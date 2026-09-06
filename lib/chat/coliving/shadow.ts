import "server-only";

import postgres from "postgres";
import {
  captureSnapshot,
  dropRestoredHousehold,
  restoreSnapshot,
  toPortableSnapshot,
  type Snapshot,
} from "./evals/snapshot";
import { colivingModelId, shadowCandidateModelId } from "./model";
import { resolveSender } from "./repo";
import { runColivingTurn } from "./turn";

/**
 * 影子跑（Shadow）—— 真人的每一条短信，同时喂给候选版本完整跑一遍，
 * 但**一个字都不发出去**。
 *
 * ## 为什么需要它（2026-09-05 用户对 Replay 现状的评估）
 *
 * 用户给当时的 Conversation Replay 打 70 分，指出的两个洞在这里一并解决：
 *
 * - **油箱是空的**：`snapshots/` 目录只有 README，长期 regression corpus
 *   根本没在用 snapshot replay。造好了发动机，没有燃料。
 * - **缺 Shadow**：历史事故重放只能覆盖已经发生过的坑；真正逼近真实的是
 *   拿**今天真人正在发的消息**去喂候选版本——真人本人、真实措辞、真实
 *   时间、真实历史、真实 DB、真实关系、真实当下状态，全都是 100% 的，
 *   「只缺最后真正把 Candidate 的短信发出去」。
 *
 * ## 关键设计：这两件事是同一个机制
 *
 * 影子跑**不能直接在真人住的那栋房子上跑候选版本**——`runColivingTurn`
 * 会往库里写 decision / memory / communication / case，等于拿真人的世界
 * 当草稿纸。那正是 `guard.ts` 记的那次事故的形态（凭空给用户安了一个
 * 「我上周被裁了」的人设）。
 *
 * 所以走快照：
 *
 * ```
 *   真实短信进来
 *     → 生产版本正常跑、正常发短信          （完全不受影响）
 *     → 影子：冻结这栋房子在**消息到达之前**那一刻的完整世界状态
 *     → 恢复成一栋全新的 is_test=true 副本
 *     → 候选版本在副本上跑同一条消息
 *     → 结果落进 coliving.shadow_run，短信一个字不发
 *     → 副本删掉
 * ```
 *
 * 于是「跑一次影子」＝「自动沉淀一份带完整真实世界状态的快照」。
 * 油箱自己会满，而且满的是真实流量，不是编出来的场景。
 *
 * ## 四条安全性质
 *
 * 1. **绝不发短信**：这个模块根本不 import `sendSms`。候选版本产出的
 *    reply/outbound 只落 `shadow_run` 表，投递那一步在调用方
 *    （`route.ts`）手里，而调用方只对生产结果调 `deliver`。
 * 2. **绝不碰真人的世界**：候选版本跑在恢复出来的副本上，副本是
 *    `is_test = true`。真实 household 在这条路径上**只被读，不被写**。
 * 3. **绝不影响生产**：整个流程包在 try/catch 里，且**排在生产版本
 *    跑完、短信发完之后**。影子挂了只是少一条语料，住户照常收到回复。
 * 4. **默认关闭**：要 `COLIVING_SHADOW=1` 才跑。它会让一轮的总耗时
 *    大致翻倍（副本上要完整再跑一遍生成+批判器），`maxDuration` 有限，
 *    所以是显式打开的选项，不是默认行为。
 *
 * ## 诚实交代一个当前的局限
 *
 * 默认情况下（不设 `COLIVING_SHADOW_MODEL`），"候选版本"和"生产版本"
 * 跑的是**同一份代码、同一个模型**。这种情况下影子跑真正稳定提供的
 * 价值只有前两项：
 *
 *   ①**把真实流量沉淀成可重放的快照**（解决"油箱空"）—— 完整成立
 *   ②**候选路径的端到端可用性验证**（恢复→跑→产出，全链路真跑一遍）
 *   ③ A/B 对比：同一份代码同一个模型跑两次，差异里混着模型本身的
 *     随机性，不能直接当成"改动引起的回归"。
 *
 * 设了 `COLIVING_SHADOW_MODEL`，候选版本会换成那个模型跑（`runColivingTurn`
 * 的 `modelId` 参数），这时候③才算真的成立——但这仍然只是"换模型"的 A/B，
 * 不是"换代码"的 A/B；要对比代码改动，还是得靠 `pnpm coliving-eval`
 * 这类离线跑批。`shadow_run.production_model` / `shadow_model` 两列
 * 记录了两侧实际用的模型，复核时能看出这次差异是不是模型造成的，
 * 不用靠猜——**不设 `COLIVING_SHADOW_MODEL` 时这两列会相等**，那正是
 * "同一份代码同一个模型跑两次"的诚实记录，不是缺陷。
 *
 * 这个局限**不影响 ① 的价值**，而 ① 正是用户当前最缺的那一块。
 */

export type ShadowOutcome = {
  shadowRunId: string;
  /** 副本上跑出来的回复（没有发出去） */
  shadowReply: string | null;
  error: string | null;
};

/**
 * 把即将打日志/落库的错误文本脱敏成不含真实号码的版本。
 *
 * **为什么需要这一层**：`args.from` 是真实手机号，`restoreSnapshot` 在
 * `rawSnapshot`（未脱敏，`toPortableSnapshot` 之前的那份）上抛错时也会把
 * `person_contact.value` 原样拼进 `Error.message`（"号码 X 不在 phoneMap
 * 里，拒绝原样恢复"）——这两处错误信息都会被下面 `runShadowTurn` 的
 * catch 打 `console.log`、写进 `shadow_run.shadow_error`。不在这里挡一道，
 * 真实号码就会经这条路径直接落进日志和数据库。
 *
 * 两层脱敏：
 * 1. **精确抹掉这次调用已知的真实号码**——调用方传入的 `args.from`
 *    和 `rawSnapshot.phoneMap` 的全部 key（那正是这次抓到的这栋房子里
 *    每一个真实号码）。
 * 2. **兜底**：不管精确列表有没有漏，只要文本里出现"像手机号"的数字串
 *    （`+` 开头或纯数字，允许中间夹横线/空格，总长 7~18 位数字），一律
 *    替换掉。这条兜底会连带遮住无害的槽位号（`+1555…`）——这是有意的
 *    取舍：错误信息少一点细节，换绝不漏真实号码的保证。
 *
 * **不改变原始异常的控制流**：只处理文本内容，不吞异常、不改变
 * 异常类型、不影响调用方 try/catch 的行为。
 */
export function redactShadowErrorMessage(
  rawMessage: string,
  knownRealNumbers: Array<string | null | undefined>
): string {
  let text = rawMessage;
  for (const real of knownRealNumbers) {
    if (!real) continue;
    const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "g"), "[号码已脱敏]");
  }
  // 兜底：+开头或纯数字的长串，允许内部夹横线/空格，总长 7~18 位数字
  text = text.replace(/\+?\d[\d\s-]{5,17}\d/g, "[号码已脱敏]");
  return text;
}

function db(): postgres.Sql {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("[shadow] 没有 POSTGRES_URL");
  return postgres(url, { max: 2, idle_timeout: 20 });
}

/** 影子跑开着吗。默认关——它会让一轮耗时大致翻倍 */
export function shadowEnabled(): boolean {
  return process.env.COLIVING_SHADOW === "1";
}

/**
 * 跑一次影子。**调用方必须保证这是在生产版本跑完、短信发完之后调用的**，
 * 而且要包在自己的 try/catch 里——虽然这个函数内部已经全程兜住异常，
 * 但多一层不吃亏，影子永远不该让住户收不到消息。
 *
 * @param arrivedAt **消息到达的时刻，必须在生产版本开跑之前取**。
 *   快照按这个时间点截断，才能冻住"这条消息进来之前"的世界；
 *   取晚了就会把生产版本这一轮自己写的 decision/message 混进快照，
 *   候选版本等于看着答案答题。
 */
export async function runShadowTurn(args: {
  channel: string;
  from: string;
  text: string;
  arrivedAt: Date;
  /** 生产版本真实说了什么，存下来做对比 */
  productionReply: string;
  productionTools: string[];
}): Promise<ShadowOutcome | null> {
  let restoredHouseholdId: string | null = null;
  /** 失败记录要尽量保留这些——即使失败发生在 capture 之后，最值得复现
   *  的那条失败记录也不该因为写在 catch 里就把这些证据丢光。 */
  let householdId: string | null = null;
  let householdLabel: string | null = null;
  let rawSnapshot: Snapshot | null = null;
  /** 真人的号在快照里对应的槽位号（不是真实号码，落库/导出都用它） */
  let inboundSlot: string | null = null;
  const sql = db();

  const productionModelId = colivingModelId();
  // 不设 COLIVING_SHADOW_MODEL 就跟生产用同一个模型——见文件头「诚实
  // 交代一个当前的局限」，这不是缺陷，是如实记录"这次没有做模型层面的 A/B"
  const candidateModelId = shadowCandidateModelId() ?? productionModelId;

  try {
    const sender = await resolveSender(args.channel, args.from);
    if (!sender) {
      // 认不出的号码本来就不落任何世界模型记录，没有状态可冻
      return null;
    }
    if (sender.isTest) {
      // 测试屋自己发的消息不用再影子一遍，否则跑批会自我繁殖
      return null;
    }
    householdId = sender.householdId;
    householdLabel = sender.householdLabel;

    // ① 冻结「这条消息进来之前」的完整世界状态
    const snapshot = await captureSnapshot({
      householdId: sender.householdId,
      asOf: args.arrivedAt,
      // 向量太占地方，而且相似判例检索对"这一步说了什么"影响很小
      dropEmbeddings: true,
    });
    rawSnapshot = snapshot;

    // ② 恢复成一栋全新副本。号码在这一步被换成本次独有的测试号，
    //    所以副本里的人跟真人完全隔离，真人的短信永远打不到副本上
    const restored = await restoreSnapshot(snapshot);
    restoredHouseholdId = restored.householdId;

    // 真人的号 → 快照里的槽位号 → 这次恢复出来的可用测试号
    const slot = snapshot.phoneMap[args.from];
    inboundSlot = slot ?? null;
    const shadowFrom = slot ? restored.phoneMap[slot] : null;
    if (!shadowFrom) {
      throw new Error(
        `影子跑找不到 ${args.from} 对应的测试号（快照里的联系方式可能被 asOf 截掉了）`
      );
    }

    // ③ 候选版本在副本上跑同一条消息。**这里产出的 reply / outbound
    //    不会被任何人投递**——本模块不 import sendSms，调用方也只对
    //    生产结果调 deliver
    const outcome = await runColivingTurn({
      channel: args.channel,
      from: shadowFrom,
      text: args.text,
      modelId: candidateModelId,
    });

    const [row] = await sql<{ id: string }[]>`
      insert into coliving.shadow_run
        (household_id, household_label, inbound_from, inbound_text, arrived_at,
         production_reply, production_tools, production_model,
         shadow_reply, shadow_tools, shadow_outbound, shadow_model, snapshot)
      values
        (${sender.householdId}, ${sender.householdLabel},
         ${inboundSlot}, ${args.text}, ${args.arrivedAt},
         ${args.productionReply}, ${args.productionTools}, ${productionModelId},
         ${outcome.reply}, ${outcome.toolsUsed},
         ${sql.json(outcome.allOutbound.map((o) => ({
           toPersonId: o.personId,
           text: o.text,
           blocked: Boolean(o.blocked),
           blockReason: o.blockReason ?? null,
         })))},
         ${candidateModelId},
         ${sql.json(toPortableSnapshot(snapshot) as never)})
      returning id`;

    return { shadowRunId: row.id, shadowReply: outcome.reply, error: null };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // **打日志/落库之前必须先脱敏**——见 redactShadowErrorMessage 的注释：
    // 这条 catch 兜住的两类典型错误（找不到测试号、restoreSnapshot 校验
    // 号码）都会把真实手机号直接拼进 message。
    const message = redactShadowErrorMessage(rawMessage, [
      args.from,
      ...(rawSnapshot ? Object.keys(rawSnapshot.phoneMap) : []),
    ]);
    console.log("[shadow] 影子跑失败（不影响生产）：", message);
    // 失败也留痕：知道"这条消息影子没跑成"比完全没记录有用，
    // 否则语料里会莫名其妙缺一段，事后查不出是没跑还是跑挂了。
    // **如果失败发生在 capture 之后，尽量把已经拿到的 snapshot/household
    // 证据一并存下来**——那正是最值得复现的一类失败（capture 成功、
    // restore 或候选版本跑挂了），丢掉证据等于白抓了这次快照。
    try {
      let portableSnapshot: Snapshot | null = null;
      if (rawSnapshot) {
        try {
          portableSnapshot = toPortableSnapshot(rawSnapshot);
        } catch (redactError) {
          // 脱敏本身失败，宁可这条记录不带 snapshot，也不能把带真实
          // 号码的快照存进库
          console.log(
            "[shadow] 失败记录的快照脱敏失败，这条记录不保留 snapshot：",
            redactError instanceof Error ? redactError.message : String(redactError)
          );
        }
      }
      const [row] = await sql<{ id: string }[]>`
        insert into coliving.shadow_run
          (household_id, household_label, inbound_from, inbound_text, arrived_at,
           production_reply, production_tools, production_model, shadow_model,
           shadow_error, snapshot)
        values
          (${householdId}, ${householdLabel},
           ${inboundSlot}, ${args.text}, ${args.arrivedAt},
           ${args.productionReply}, ${args.productionTools}, ${productionModelId},
           ${candidateModelId}, ${message},
           ${portableSnapshot ? sql.json(portableSnapshot as never) : null})
        returning id`;
      return { shadowRunId: row.id, shadowReply: null, error: message };
    } catch {
      return null;
    }
  } finally {
    // ④ 副本用完就删。不删的话真实流量会在库里堆出成千上万栋僵尸测试屋
    if (restoredHouseholdId) {
      try {
        await dropRestoredHousehold(restoredHouseholdId);
      } catch (error) {
        console.log(
          "[shadow] 副本清理失败（不影响生产，但会留下僵尸测试屋）：",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    await sql.end();
  }
}
