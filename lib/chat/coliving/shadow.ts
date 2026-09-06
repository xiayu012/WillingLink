import "server-only";

import postgres from "postgres";
import { captureSnapshot, dropRestoredHousehold, restoreSnapshot } from "./evals/snapshot";
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
 * 单个部署里，"候选版本"和"生产版本"跑的是**同一份代码**。所以这一版
 * 影子跑真正稳定提供的价值是前两项，第三项要打折看：
 *
 *   ①**把真实流量沉淀成可重放的快照**（解决"油箱空"）—— 完整成立
 *   ②**候选路径的端到端可用性验证**（恢复→跑→产出，全链路真跑一遍）
 *   ③ A/B 对比：同一份代码跑两次，差异里混着模型本身的随机性，
 *     不能直接当成"改动引起的回归"。要做真正的 A/B，得让候选侧跑
 *     不同的东西——预留了 `SHADOW_MODEL_ID` 这个口子（换模型跑影子），
 *     更彻底的做法是部署两份、或者把候选行为放在 feature flag 后面。
 *
 * 这个局限**不影响 ① 的价值**，而 ① 正是用户当前最缺的那一块。
 */

export type ShadowOutcome = {
  shadowRunId: string;
  /** 副本上跑出来的回复（没有发出去） */
  shadowReply: string | null;
  error: string | null;
};

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
  const sql = db();

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

    // ① 冻结「这条消息进来之前」的完整世界状态
    const snapshot = await captureSnapshot({
      householdId: sender.householdId,
      asOf: args.arrivedAt,
      // 向量太占地方，而且相似判例检索对"这一步说了什么"影响很小
      dropEmbeddings: true,
    });

    // ② 恢复成一栋全新副本。号码在这一步被换成本次独有的测试号，
    //    所以副本里的人跟真人完全隔离，真人的短信永远打不到副本上
    const restored = await restoreSnapshot(snapshot);
    restoredHouseholdId = restored.householdId;

    // 真人的号 → 快照里的槽位号 → 这次恢复出来的可用测试号
    const slot = snapshot.phoneMap[args.from];
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
    });

    const [row] = await sql<{ id: string }[]>`
      insert into coliving.shadow_run
        (household_id, household_label, inbound_from, inbound_text, arrived_at,
         production_reply, production_tools,
         shadow_reply, shadow_tools, shadow_outbound, snapshot)
      values
        (${sender.householdId}, ${sender.householdLabel},
         ${args.from}, ${args.text}, ${args.arrivedAt},
         ${args.productionReply}, ${args.productionTools},
         ${outcome.reply}, ${outcome.toolsUsed},
         ${sql.json(outcome.outbound.map((o) => ({
           toPersonId: o.personId,
           text: o.text,
           blocked: Boolean(o.blocked),
         })))},
         ${sql.json(snapshot as never)})
      returning id`;

    return { shadowRunId: row.id, shadowReply: outcome.reply, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[shadow] 影子跑失败（不影响生产）：", message);
    // 失败也留痕：知道"这条消息影子没跑成"比完全没记录有用，
    // 否则语料里会莫名其妙缺一段，事后查不出是没跑还是跑挂了
    try {
      const [row] = await sql<{ id: string }[]>`
        insert into coliving.shadow_run
          (inbound_from, inbound_text, arrived_at,
           production_reply, production_tools, shadow_error)
        values
          (${args.from}, ${args.text}, ${args.arrivedAt},
           ${args.productionReply}, ${args.productionTools}, ${message})
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
