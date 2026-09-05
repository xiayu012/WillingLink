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
type ScenarioResult = {
  id: string;
  pass: boolean;
  failures: string[];
  lastReply: string;
  toolsUsed: string[];
  outboundTexts: string[];
  ms: number;
};

async function runScenario(scenario: EvalScenario): Promise<ScenarioResult> {
  const start = Date.now();
  const repo = await import("../lib/chat/coliving/repo");
  const turn = await import("../lib/chat/coliving/turn");

  const { householdId } = await repo.createTestHousehold(
    `evals-${scenario.id}-${Date.now()}`
  );
  for (const p of scenario.people) {
    await repo.addResident({
      householdId,
      phone: p.phone,
      name: p.name,
      role: p.role,
      note: null,
    });
  }
  await repo.setDeclaredSize(householdId, scenario.people.length);

  let last: Awaited<ReturnType<typeof turn.runColivingTurn>> | null = null;
  for (const t of scenario.turns) {
    last = await turn.runColivingTurn({ from: t.from, text: t.text });
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

  return {
    id: scenario.id,
    pass: failures.length === 0,
    failures,
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
