/**
 * 合租房大脑的语料回归 runner。
 *
 * 用法：
 *   pnpm coliving-eval                          # 跑全部语料，并发 4
 *   pnpm coliving-eval -- --scenario kitchen-procrastination-2026-09-05
 *   pnpm coliving-eval -- --concurrency 8
 *   pnpm coliving-eval -- --limit 3
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
 * 退出码：有场景判失败 → 1，否则 0。
 * 报告：终端打印 + 写一份 JSON 到 tests/coliving-eval/reports/（gitignored，
 * 目录不存在会自动建）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });
process.env.COLIVING_LOCAL_WRITE = "1";

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JudgeFinding } from "../lib/chat/coliving/evals/judge";
import type { EvalScenario } from "../lib/chat/coliving/evals/schema";
import { validateScenario } from "../lib/chat/coliving/evals/schema";

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
  toolsUsed: string[];
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
  /** 大模型语义验收（L2/L3）。`--judge-off` 或判定器挂了就没有这一项 */
  judge?: { pass: boolean; findings: JudgeFinding[] };
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
      toolsUsed: last.toolsUsed,
      // 用 allOutbound 而不是 outbound：被审稿拦下的那些也要进文字稿，
      // 它们是复核时最该看的部分（"这条为什么没发出去"）
      outbound: last.allOutbound.map((o) => ({
        toName: nameOf(o.personId),
        text: o.text,
        blocked: Boolean(o.blocked),
        blockReason: o.blockReason,
      })),
    });
  }
  if (!last) {
    throw new Error(`场景 ${scenario.id} 没有任何 turns`);
  }

  const failures: string[] = [];
  const exp = scenario.expect ?? {};
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
  if (exp.minBlockedComms !== undefined) {
    // 测试脚本没有真正走 Twilio 发送，需要先标 sent 才能进阻塞清单——
    // 跟生产路径（webhook 里的 deliver()）一致地补这一步，
    // 否则 getBlockedComms 的 status='sent' 条件永远不成立
    for (const m of last.outbound) {
      await repo.markCommunication({ communicationId: m.communicationId, status: "sent" });
    }
    if (last.replyCommunicationId) {
      await repo.markCommunication({ communicationId: last.replyCommunicationId, status: "sent" });
    }
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
   * **判定失败不覆盖结构性结论**：`pass` 仍然只由结构性断言决定，
   * judge 的结果单独放在 `judge` 字段里。理由是这一层天然有误报
   * （子代理自己也指出：它看不到 pickSchedule 的候选，"排得不近人情"
   * 这类判断最容易误伤），让它直接把场景判红会让跑批变得不可信——
   * 先让人看着它的意见，攒够信心再考虑要不要让它参与 gate。
   */
  let judge: { pass: boolean; findings: JudgeFinding[] } | undefined;
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
          outbound: t.outbound.map((o) => ({
            toName: o.toName,
            text: o.text,
            blocked: o.blocked,
          })),
        })),
      });
    } catch (error) {
      // 判定器挂了不该让整个跑批失败——它是附加信息，不是门禁
      console.log(
        `[judge] ${scenario.id} 判定失败（跳过）：`,
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
    lastReply: last.reply,
    toolsUsed,
    outboundTexts,
    ms: Date.now() - start,
  };
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
  const results = await runWithConcurrency(scenarios, CONCURRENCY, runScenario);
  const totalMs = Date.now() - start;

  let failCount = 0;
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} [${r.id}] ${r.ms}ms`);
    if (!r.pass) {
      failCount++;
      for (const f of r.failures) console.log(`    - ${f}`);
      console.log(`    最终回复：${r.lastReply}`);
    }
  }
  console.log(
    `\n${results.length - failCount}/${results.length} 通过，总耗时 ${(totalMs / 1000).toFixed(1)}s`
  );

  const reportDir = path.join(process.cwd(), "tests/coliving-eval/reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `${new Date().toISOString().slice(0, 10)}.json`
  );
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`报告已写入 ${reportPath}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("跑批失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
