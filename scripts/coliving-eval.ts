/**
 * 合租房大脑的语料回归 runner。
 *
 * 用法：
 *   pnpm coliving-eval                          # 跑全部语料，并发 4
 *   pnpm coliving-eval -- --scenario kitchen-procrastination-2026-09-05
 *   pnpm coliving-eval -- --concurrency 8
 *   pnpm coliving-eval -- --limit 3
 *   pnpm coliving-eval -- --judge-off        # 跳过语义验收，只跑结构性
 *   pnpm coliving-eval -- --judge-advisory   # 语义验收照跑，但 high 不计入门禁
 *

 * 设计对照 docs/coliving-parallel-testing-plan.md 阶段一 + 阶段二：
 * - 每个场景一个独立测试屋，household_id 天然隔离，不需要
 *   `pnpm coliving:db --purge` 这个串行点，场景之间可以并发跑。
 * - 判定全部是**结构性**检查（工具有没有调、回复/出站消息有没有命中
 *   某个正则），不引入额外的模型调用做语义判分——语义判断留给人工
 *   或者阶段三的子代理审查，这里只做代码能确定性判的那部分。
 * - 语料**只增不减**：抓到新的真实 bug，对应的复现场景整理成一份
 *   JSON 提交进 `scenarios/`，以后每次跑批默认全量跑，自动重新验证
 *   过去踩过的所有坑。
 *
 * 退出码：结构性断言失败，或语义验收（judge）报了 high → 1，否则 0。
 * `--judge-advisory` 可以让 judge 只旁听、不参与退出码（默认参与，见下）。
 * 报告：终端打印 + 写一份 JSON 到 tests/coliving-eval/reports/（gitignored，
 * 目录不存在会自动建）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });
process.env.COLIVING_LOCAL_WRITE = "1";

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JudgeResult } from "../lib/chat/coliving/evals/judge";
import type { EvalScenario } from "../lib/chat/coliving/evals/schema";
import {
  countAcceptedOutbound,
  evaluateTurnReplyReviews,
  validateScenario,
} from "../lib/chat/coliving/evals/schema";
import type { ReplyReview } from "../lib/chat/coliving/turn";

// ── CLI args ─────────────────────────────────────────────────────────────
function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const SCENARIO_FILTER = argValue("scenario");
const CONCURRENCY = Number(argValue("concurrency") ?? 4);
const LIMIT = Number(argValue("limit") ?? Number.POSITIVE_INFINITY);
/**
 * 语义验收（L2/L3）默认开。关掉的场合：只想快速看结构性断言、或者
 * 判定器本身正在被调试——它每个场景多一次模型调用，跑批会慢一点。
 */
const JUDGE_OFF = process.argv.includes("--judge-off");
/**
 * 默认 judge 的 high 参与总门禁（结构性通过 ≠ 整体通过）。
 * 想让它只旁听、不影响退出码，显式传这个 flag——**不能是默认行为**，
 * 否则又会退回"judge 说了不算、报告却好像判过"的老样子。
 */
const JUDGE_ADVISORY = process.argv.includes("--judge-advisory");

// ── 加载 + 校验语料 ──────────────────────────────────────────────────────
const SCENARIOS_DIR = path.join(
  process.cwd(),
  "lib/chat/coliving/evals/scenarios"
);
function loadScenarios(): EvalScenario[] {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json"));
  const scenarios = files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, f), "utf8"));
    return validateScenario(raw, f);
  });
  const filtered = SCENARIO_FILTER
    ? scenarios.filter((s) => s.id === SCENARIO_FILTER)
    : scenarios;
  return filtered.slice(0, LIMIT);
}

// ── 简单的并发限制（不引入 p-limit 依赖，量级不需要） ───────────────────
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

// ── 单个场景的结果 ───────────────────────────────────────────────────────
/**
 * 一轮的完整记录。**每一轮都存，不只是最后一轮**——报告页要按聊天记录
 * 的形式给人看（`scripts/coliving-report.ts`），语义验收器也要读完整
 * 上下文才能判"这句话是不是泄漏了上一轮才说的事"。
 */
type TurnRecord = {
  fromName: string;
  fromRole: string;
  said: string;
  reply: string;
  replyReview: ReplyReview;
  toolsUsed: string[];
  scheduleFacts: string[];
  outbound: Array<{
    toName: string;
    text: string;
    blocked: boolean;
    blockReason?: string;
  }>;
};

type ScenarioResult = {
  id: string;
  source: string;
  pass: boolean;
  failures: string[];
  /** 完整文字稿，给报告页和语义验收用 */
  turns: TurnRecord[];
  /**
   * 大模型语义验收（L2/L3）。**永远有值，不再是可选的**——`--judge-off`
   * 或判定器挂了，`verified` 是 false，`pass` 恒为 false，调用方必须显式
   * 处理"没验收"这个状态，不能因为字段不存在就悄悄当没发生过、算作通过。
   */
  judge: JudgeResult;
  /** 最终回复最后一次审稿的结论——见 lib/chat/coliving/turn.ts 的 ReplyReview */
  replyReview: ReplyReview;
  lastReply: string;
  toolsUsed: string[];
  outboundTexts: string[];
  ms: number;
};

async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  const start = Date.now();
  const repo = await import("../lib/chat/coliving/repo");
  const turn = await import("../lib/chat/coliving/turn");

  let householdId: string;
  /** 快照场景专用：槽位号 → 本次恢复实际可用的号 */
  let phoneRewrite: Record<string, string> = {};
  if (scenario.snapshot) {
    // ── 快照重放：状态是冻住恢复出来的，不重演历史轮次 ──────────────
    const { restoreSnapshot } = await import(
      "../lib/chat/coliving/evals/snapshot"
    );
    const snapPath = path.join(
      process.cwd(),
      "lib/chat/coliving/evals/snapshots",
      `${scenario.snapshot}.json`
    );
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    const restored = await restoreSnapshot(snap);
    householdId = restored.householdId;
    // 场景里写的是**槽位号**（稳定、可提交进 git），实际发消息要用这次
    // 恢复现生成的号——不换就会认成陌生号码，走完全不同的路径，
    // 静默测了个寂寞。写错号直接报错，不静默跳过。
    phoneRewrite = restored.phoneMap;
    for (const [i, t] of scenario.turns.entries()) {
      if (!phoneRewrite[t.from]) {
        throw new Error(
          `场景 ${scenario.id} 的 turns[${i}].from（${t.from}）不是快照 ` +
            `${scenario.snapshot} 里的槽位号。可用槽位号：${Object.keys(phoneRewrite).join("、")}`
        );
      }
    }
  } else {
    const created = await repo.createTestHousehold(
      `evals-${scenario.id}-${Date.now()}`
    );
    householdId = created.householdId;
    // 场景里写的号码是**槽位号**，每次跑换成本次独有的真号——
    // 写死号码反复跑批会让同一个号挂上多栋屋子，`resolveSender` 的
    // `limit 1` 就会任意认进旧屋子，测的是被上次污染过的状态。
    // 详见 evals/phones.ts 开头那次真实事故。
    const { makeLivePhones, collectSlotPhones } = await import(
      "../lib/chat/coliving/evals/phones"
    );
    phoneRewrite = makeLivePhones(
      collectSlotPhones({ people: scenario.people, turns: scenario.turns })
    );
    for (const p of scenario.people ?? []) {
      await repo.addResident({
        householdId,
        phone: phoneRewrite[p.phone] ?? p.phone,
        name: p.name,
        role: p.role,
        note: null,
      });
    }
    await repo.setDeclaredSize(householdId, (scenario.people ?? []).length);
  }

  // 正文里的号码也要换：`addresident-greeting` 那条场景把号码写在消息里
  // （"一个电话是 155…"），只换 from 不换正文，模型会去加一个上次跑批
  // 留下的旧号，等于没测到"加人"这个动作
  const { rewritePhonesInText } = await import(
    "../lib/chat/coliving/evals/phones"
  );
  // 名字/角色查一次就够，用来把 person_id 翻译成人能读的名字
  const members = await repo.getMembers(householdId);
  const nameOf = (personId: string) =>
    members.find((m) => m.personId === personId)?.name ?? "（未知）";
  const roleOf = (phone: string) =>
    members.find((m) => m.address === phone)?.role ?? "tenant";

  for (const name of scenario.setup?.confirmedNames ?? []) {
    const person = members.find((m) => m.name === name);
    if (!person) {
      throw new Error(`场景 ${scenario.id} 找不到要确认姓名的成员「${name}」`);
    }
    await repo.renamePerson({ personId: person.personId, name, confirmed: true });
    person.nameConfirmed = true;
  }

  // 需要精确复现“某个结构化状态后的下一轮”时，直接预置测试状态，
  // 不让额外一轮模型输出把前提改写掉；所有写入仍只发生在本次测试屋。
  for (const openCase of scenario.setup?.openCases ?? []) {
    const caseId = await repo.openCase({
      householdId,
      kind: openCase.kind,
      title: openCase.title,
      severity: openCase.severity ?? null,
    });
    for (const position of openCase.positions ?? []) {
      const person = members.find((m) => m.name === position.person);
      if (!person) {
        throw new Error(
          `场景 ${scenario.id} 预置表态找不到成员「${position.person}」`
        );
      }
      await repo.recordCasePosition({
        caseId,
        householdId,
        personId: person.personId,
        kind: position.kind,
        statement: position.statement,
      });
    }
  }
  for (const message of scenario.setup?.priorMessages ?? []) {
    const person = members.find((m) => m.name === message.person);
    if (!person) {
      throw new Error(
        `场景 ${scenario.id} 预置历史找不到成员「${message.person}」`
      );
    }
    const conversationId = await repo.getOrCreateConversation({
      personId: person.personId,
      householdId,
      channel: "sms",
    });
    await repo.appendMessage({
      conversationId,
      personId: person.personId,
      direction: message.direction,
      channel: "sms",
      body: message.body,
    });
  }

  let last: Awaited<ReturnType<typeof turn.runColivingTurn>> | null = null;
  const transcript: TurnRecord[] = [];
  for (const t of scenario.turns) {
    const livePhone = phoneRewrite[t.from] ?? t.from;
    const said = rewritePhonesInText(t.text, phoneRewrite);
    last = await turn.runColivingTurn({ from: livePhone, text: said });
    transcript.push({
      fromName:
        members.find((m) => m.address === livePhone)?.name ?? livePhone,
      fromRole: roleOf(livePhone),
      said,
      reply: last.reply,
      replyReview: last.replyReview,
      toolsUsed: last.toolsUsed,
      scheduleFacts: last.scheduleFacts,
      // 用 allOutbound 而不是 outbound：被审稿拦下的那些也要进文字稿，
      // 它们是复核时最该看的部分（"这条为什么没发出去"）
      outbound: last.allOutbound.map((o) => ({
        toName: nameOf(o.personId),
        text: o.text,
        blocked: Boolean(o.blocked),
        blockReason: o.blockReason,
      })),
    });
    // 隔离评测不调用 Twilio，但下一轮必须看到与生产一致的“已经发出、
    // 正在等回复”状态。否则 buildContext 的阻塞清单为空，模型会把上一轮
    // 已问过的问题再问一遍，测出来的是评测器失真，不是产品行为。
    for (const message of last.outbound) {
      await repo.markCommunication({
        communicationId: message.communicationId,
        status: "sent",
      });
    }
    if (last.replyCommunicationId) {
      await repo.markCommunication({
        communicationId: last.replyCommunicationId,
        status: "sent",
      });
    }
  }
  if (!last) {
    throw new Error(`场景 ${scenario.id} 没有任何 turns`);
  }

  const failures: string[] = [];
  const exp = scenario.expect ?? {};
  const acceptedOutboundCount = countAcceptedOutbound(last.allOutbound);
  if (exp.minAcceptedOutbound !== undefined && acceptedOutboundCount < exp.minAcceptedOutbound) {
    failures.push(`应有至少 ${exp.minAcceptedOutbound} 条通过审稿的出站，实际 ${acceptedOutboundCount} 条；调用联系工具不等于联系成功`);
  }
  const toolsUsed = last.toolsUsed;
  const outboundTexts = last.outbound.map((o) => o.text);

  for (const t of exp.mustUseTools ?? []) {
    if (!toolsUsed.includes(t)) {
      failures.push(`应该调用 ${t}，但 toolsUsed 里没有（实际：${toolsUsed.join("、") || "无"}）`);
    }
  }
  if (exp.mustUseAnyOfTools && exp.mustUseAnyOfTools.length > 0) {
    const hit = exp.mustUseAnyOfTools.some((t) => toolsUsed.includes(t));
    if (!hit) {
      failures.push(
        `应该调用 [${exp.mustUseAnyOfTools.join("、")}] 里的至少一个，但一个都没调（实际：${toolsUsed.join("、") || "无"}）`
      );
    }
  }
  for (const t of exp.mustNotUseTools ?? []) {
    if (toolsUsed.includes(t)) {
      failures.push(`不该调用 ${t}，但调用了`);
    }
  }
  for (const pattern of exp.replyMustNotMatch ?? []) {
    if (new RegExp(pattern).test(last.reply)) {
      failures.push(`回复命中了不该出现的模式「${pattern}」：${last.reply.slice(0, 80)}`);
    }
  }
  for (const pattern of exp.replyMustMatch ?? []) {
    if (!new RegExp(pattern).test(last.reply)) {
      failures.push(`回复没有命中该出现的模式「${pattern}」：${last.reply.slice(0, 80)}`);
    }
  }
  for (const pattern of exp.outboundMustNotMatch ?? []) {
    const hit = outboundTexts.find((text) => new RegExp(pattern).test(text));
    if (hit) {
      failures.push(`出站消息命中了不该出现的模式「${pattern}」：${hit.slice(0, 80)}`);
    }
  }
  /**
   * **批判器明知最终回复不合格，代码照样发了——这个门禁堵这个漏洞。**
   * `runColivingTurn` 已经把打回/重写/最终修正的真实结论算成了
   * `replyReview`；这里不重新判断，只核对这个结论本身站不站得住，
   * 不合格或没验证过都计入结构性失败，让"批判器打回但总门禁绿色"
   * 不再可能发生。
   */
  failures.push(...evaluateTurnReplyReviews(transcript.map((turn) => turn.replyReview)));

  if (exp.minBlockedComms !== undefined) {
    const blockedAfter = await repo.getBlockedComms(householdId);
    if (blockedAfter.length < exp.minBlockedComms) {
      failures.push(
        `阻塞清单应该至少有 ${exp.minBlockedComms} 条，实际 ${blockedAfter.length} 条`
      );
    }
  }

  /**
   * **语义验收（L2/L3）：结构性断言抓不到的那一层。**
   *
   * 上面那些断言查的是"工具调没调、正则匹不匹配"——确定性、便宜、可靠，
   * 但看不出"这句话虽然没违反任何正则，但读起来在拱火"，也看不出
   * "AI 没直接点名，可是透露的信息足以让乙推断出是甲投诉的"。
   * 那类问题只有读懂人话才能发现，所以交给一次独立的模型判定。
   *
   * `pass` 这个字段本身**只反映结构性断言**，judge 的结果单独放在
   * `judge` 字段里——这样报告页才能分别显示"结构性失败"和"语义失败"，
   * 而不是混成一个不知道具体是哪层的红叉。
   *
   * **但总门禁（`main()` 算的退出码）默认把 `judge.pass`（只看 high）
   * 也算进去**——一个场景语义验收报了 high，整批就不该显示"全部通过"。
   * 这一层确实有误报（子代理自己指出过：它看不到 pickSchedule 的候选，
   * "排得不近人情"这类判断最容易误伤，`real-kitchen-incident` 场景
   * 复测时也见过），想让它只旁听、不影响退出码，传 `--judge-advisory`。
   */
  // **`--judge-off` 或判定失败，都是"没验收"，不是"通过"**——直接标成
  // `verified:false, pass:false`，不能让调用方因为拿不到 judge 结果就
  // 默认当没发生过、把总结果算成绿。
  let judge: JudgeResult = { pass: false, verified: false, findings: [] };
  if (!JUDGE_OFF) {
    try {
      const { judgeConversation } = await import(
        "../lib/chat/coliving/evals/judge"
      );
      judge = await judgeConversation({
        scenarioId: scenario.id,
        source: scenario.source,
        roster: members.map((m) => ({ name: m.name, role: m.role })),
        turns: transcript.map((t) => ({
          fromName: t.fromName,
          said: t.said,
          reply: t.reply,
          facts: t.scheduleFacts,
          outbound: t.outbound.map((o) => ({
            toName: o.toName,
            text: o.text,
            blocked: o.blocked,
          })),
        })),
      });
    } catch (error) {
      // 判定器挂了不该让整个跑批直接崩溃退出——但这一场景的语义层
      // 确确实实没验收过，`judge` 保持上面初始化的未验收态，不当通过。
      console.log(
        `[judge] ${scenario.id} 判定失败（标记未验收）：`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return {
    id: scenario.id,
    source: scenario.source,
    pass: failures.length === 0,
    failures,
    turns: transcript,
    judge,
    replyReview: last.replyReview,
    lastReply: last.reply,
    toolsUsed,
    outboundTexts,
    ms: Date.now() - start,
  };
}

/**
 * 单个场景的基础设施故障也必须落进报告。否则模型网关超时会让整批直接
 * 退出，已经完成的场景和失败原因一起丢失，看起来反而像“没有红灯”。
 */
async function runScenarioSafely(scenario: EvalScenario): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    return await runScenario(scenario);
  } catch (error) {
    const reason = (() => {
      if (error instanceof Error) {
        const own = [error.name, error.message.trim()].filter(Boolean).join(": ");
        const aggregate = error instanceof AggregateError
          ? error.errors
              .map((item) =>
                item instanceof Error
                  ? [item.name, item.message.trim()].filter(Boolean).join(": ")
                  : String(item)
              )
              .filter(Boolean)
              .join(" | ")
          : "";
        const cause = error.cause instanceof Error
          ? [error.cause.name, error.cause.message.trim()].filter(Boolean).join(": ")
          : error.cause
            ? String(error.cause)
            : "";
        return [own, aggregate && `errors=${aggregate}`, cause && `cause=${cause}`]
          .filter(Boolean)
          .join("; ") ||
          "Error（无错误文本）";
      }
      const text = String(error).trim();
      if (text) return text;
      try {
        return JSON.stringify(error) || "未知异常（无错误文本）";
      } catch {
        return "未知异常（无法序列化）";
      }
    })();
    console.log(`[scenario] ${scenario.id} 执行失败（写入红灯报告）：${reason}`);
    return {
      id: scenario.id,
      source: scenario.source,
      pass: false,
      failures: [`场景执行异常：${reason}`],
      turns: [],
      judge: { pass: false, verified: false, findings: [] },
      replyReview: {
        verified: false,
        pass: false,
        broke: "",
        why: `场景执行异常：${reason}`,
      },
      lastReply: "",
      toolsUsed: [],
      outboundTexts: [],
      ms: Date.now() - start,
    };
  }
}

async function main() {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.log("没有匹配的场景（检查 --scenario 参数或 scenarios/ 目录）");
    process.exit(1);
  }
  console.log(
    `跑 ${scenarios.length} 个场景，并发 ${CONCURRENCY}…\n`
  );

  const start = Date.now();
  const results = await runWithConcurrency(
    scenarios,
    CONCURRENCY,
    runScenarioSafely
  );
  const totalMs = Date.now() - start;

  /**
   * 四种情况分开算，报告和终端输出都要能区分开：
   * - `structFail`：结构性断言失败（`r.pass === false`）。
   * - `judgeHighFail`：语义验收**真的判过**（`verified`）且报了至少一条 high。
   * - `judgeUnverified`：`--judge-off` 或判定器挂了——**没验收过，
   *   不是通过**，跟"判过、没问题"必须分开显示，否则一个真正没做语义
   *   验收的场景会在汇总里显示成"通过"，这正是这次要堵的漏洞。
   * - `overallFail`：总门禁，决定这一行是 ✓ 还是 ✗、决定退出码。
   *   `JUDGE_ADVISORY` 时 judgeHighFail/judgeUnverified 都只旁听，不影响
   *   退出码，但依然打印出来，不能假装没发生。
   */
  let structFailCount = 0;
  let judgeHighFailCount = 0;
  let judgeUnverifiedCount = 0;
  let overallFailCount = 0;
  for (const r of results) {
    const judgeHighFail = r.judge.verified && !r.judge.pass;
    const judgeUnverified = !r.judge.verified;
    const overallFail =
      !r.pass || ((judgeHighFail || judgeUnverified) && !JUDGE_ADVISORY);
    if (!r.pass) structFailCount++;
    if (judgeHighFail) judgeHighFailCount++;
    if (judgeUnverified) judgeUnverifiedCount++;
    if (overallFail) overallFailCount++;

    const tag = overallFail ? "✗" : "✓";
    const judgeNote = judgeUnverified
      ? JUDGE_ADVISORY
        ? "（语义验收未验收，advisory 模式不计入门禁）"
        : "（语义验收未验收）"
      : judgeHighFail
        ? JUDGE_ADVISORY
          ? "（语义验收未通过，advisory 模式不计入门禁）"
          : "（语义验收未通过）"
        : "";
    console.log(`${tag} [${r.id}] ${r.ms}ms${judgeNote}`);
    if (!r.pass) {
      for (const f of r.failures) console.log(`    - 结构性：${f}`);
    }
    if (judgeHighFail) {
      for (const f of r.judge.findings.filter((x) => x.severity !== "low")) {
        console.log(`    - 语义-${f.severity}：${f.issue}（「${f.quote.slice(0, 60)}」）`);
      }
    }
    if (overallFail) {
      console.log(`    最终回复：${r.lastReply}`);
    }
  }
  console.log(
    `\n结构性 ${results.length - structFailCount}/${results.length} 通过；` +
      `语义验收未通过 ${judgeHighFailCount} 个、未验收 ${judgeUnverifiedCount} 个` +
      `${JUDGE_ADVISORY ? "（advisory，不计入门禁）" : ""}；` +
      `总门禁 ${results.length - overallFailCount}/${results.length} 通过，` +
      `总耗时 ${(totalMs / 1000).toFixed(1)}s`
  );

  const reportDir = path.join(process.cwd(), "tests/coliving-eval/reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`报告已写入 ${reportPath}`);

  process.exit(overallFailCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("跑批失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
