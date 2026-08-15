/**
 * 搜索质量评测 runner —— 用真实用户措辞检验 searchRental。
 *
 * 数据源（--source，默认 auto）：
 *   wanted  XhsRentalWanted 求租帖原文（真实租客语言，冷启动用）
 *   log     SearchQueryLog 留档的真实搜索查询（积累后优先）
 *   auto    log 里非评测查询 ≥ limit 条则用 log，否则 wanted
 *
 * 判定核心 —— 区分「代码没写好」vs「库里本来没数据」：
 *   对每条查询先在全量房源上算 ground truth（可证明满足硬约束的房源集合）。
 *   - 返回结果满足约束            → PASS
 *   - 违反约束 & ground truth 为空 → DATA_GAP（搜索已尽力，非 bug；
 *                                    若无 relaxedNote 则记 NOTE_MISSING 提示缺失）
 *   - 违反约束 & ground truth 非空 → CODE_BUG（明明有满足的房源却没返回）
 *   - 无结果   & ground truth 非空 → CODE_BUG
 *
 * 可选 LLM 判分（OPENAI_API_KEY 存在时自动开启，--no-judge 关闭）：
 * 对 PASS 的结果再判语义相关性，抓「硬约束都过但内容驴唇不对马嘴」的情况。
 *
 * 用法：
 *   pnpm search-eval                     # auto 源，50 条
 *   pnpm search-eval -- --source wanted --limit 30
 *   pnpm search-eval -- --notify         # 结束后把摘要发 Telegram（CI 用）
 *
 * 退出码：存在 CODE_BUG → 1，否则 0（DATA_GAP 不算失败）。
 * 报告：tests/search-eval/reports/<日期>.md（gitignored）
 */

import { config } from "dotenv";

config({ path: ".env.local" });
for (const k of [
  "POSTGRES_URL",
  "VOYAGE_API_KEY",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]!.slice(1, -1);
  }
}
// 评测必须可复现
process.env.SEARCH_DETERMINISTIC = "1";

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

// ── CLI args ──────────────────────────────────────────────────────────────────

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const SOURCE = (argValue("source") ?? "auto") as "auto" | "wanted" | "log";
const LIMIT = Number(argValue("limit") ?? 50);
const NOTIFY = process.argv.includes("--notify");
const JUDGE =
  !process.argv.includes("--no-judge") && Boolean(process.env.OPENAI_API_KEY);

const db = postgres(process.env.POSTGRES_URL!);

// ── 查询清洗（求租帖原文 → 可搜索的查询文本）─────────────────────────────────

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE =
  /(微信|vx|wx|wechat|电话|手机|联系方式)[:：]?\s*[\w+-]{5,}/gi;

function cleanWantedText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
// 湾区外城市判定改由 lib/rental/cities.ts 的 isOutOfBayQuery 提供（与运行时共享）。

type EvalCase = { source: string; query: string };

type Verdict = "PASS" | "DATA_GAP" | "CODE_BUG" | "VERIFIER_CUT";

type EvalResult = {
  query: string;
  verdict: Verdict;
  phase: string;
  violations: string[];
  groundTruthCount: number;
  returnedCount: number;
  listingTitles: string[];
  judgeScore: number | null;
  judgeReason: string | null;
};

async function collectCases(): Promise<EvalCase[]> {
  if (SOURCE === "log" || SOURCE === "auto") {
    const logRows = await db`
      SELECT DISTINCT ON (query) query
      FROM "SearchQueryLog"
      WHERE "chatId" NOT LIKE 'eval-%'
      ORDER BY query, "createdAt" DESC
      LIMIT ${LIMIT}
    `;
    if (SOURCE === "log" || logRows.length >= LIMIT) {
      return logRows.map((r) => ({ source: "log", query: r.query as string }));
    }
  }
  // wanted 兜底：真实租客求租原文
  const wantedRows = await db`
    SELECT "rawText" FROM "XhsRentalWanted"
    WHERE LENGTH(TRIM("rawText")) >= 15
    ORDER BY "createdAt" DESC
    LIMIT ${LIMIT * 2}
  `;
  return wantedRows
    .map((r) => ({
      source: "wanted",
      query: cleanWantedText(r.rawText as string),
    }))
    .filter((c) => c.query.length >= 12)
    .slice(0, LIMIT);
}

async function llmJudge(
  query: string,
  listingText: string
): Promise<{ score: number; reason: string } | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是租房搜索质量评审。给定租客需求和返回的房源，评相关性：" +
              '2=很匹配 1=勉强相关 0=不相关。只输出 JSON：{"score":0|1|2,"reason":"一句话"}。' +
              "注意：数据库很小，城市相邻、条件略偏都算 1，只有完全对不上才是 0。",
          },
          {
            role: "user",
            content: `【需求】${query}\n【房源】${listingText.slice(0, 500)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (typeof parsed.score !== "number") return null;
    return { score: parsed.score, reason: String(parsed.reason ?? "") };
  } catch {
    return null;
  }
}

async function main() {
  // 动态 import：确保 env 处理完后再加载会创建 DB 连接的模块
  const { createSearchRentalTool, buildStrictPredicate } = await import(
    "@/lib/ai/tools/search-rental"
  );
  const { isOutOfBayQuery } = await import("@/lib/rental/cities");

  const cases = await collectCases();
  console.log(`评测 ${cases.length} 条（源：${cases[0]?.source ?? "?"}）\n`);

  // 全量房源一次取回，供 ground truth 与结果核验。
  // ground truth 与运行时共用同一个 buildStrictPredicate，判定标准永不漂移。
  const listings = await db`
    SELECT "id", "title", "rawText", "locationText", "propertyName", "city",
           "rent", "rentNumeric", "bedrooms", "bedroomsNum", "availableFrom",
           "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded",
           "furnished", "leaseMinMonths", "leaseMaxMonths"
    FROM "XhsRentalListing"
  `;

  const results: EvalResult[] = [];

  for (const [i, c] of cases.entries()) {
    const outOfBay = isOutOfBayQuery(c.query);
    const pred = buildStrictPredicate(c.query);

    // ── ground truth：严格谓词下可满足的房源集合 ──
    const groundTruth = outOfBay
      ? []
      : listings.filter((row) => pred.matches(row as never));

    // ── 执行搜索（严格模式返回 listings 数组，≤5）──
    type ToolResult = {
      listings?: { id: string; title: string | null; rawText: string }[];
      listing?: { id: string; title: string | null; rawText: string } | null;
      verifierCutCount?: number;
      action?: string;
    };
    const tool = createSearchRentalTool(`eval-${randomUUID()}`);
    const exec = (): Promise<ToolResult> =>
      (tool as { execute: Function }).execute({ query: c.query }, {});
    let r = await exec();
    // 181 连发下 Neon/gateway 偶发瞬时故障；重试一次再定性，免得污染 CODE_BUG。
    if (r.action?.startsWith("SEARCH_FAILED")) {
      r = await exec();
    }
    const returned = r.listings ?? (r.listing ? [r.listing] : []);

    // ── 核验：每一个返回的房源都必须满足严格谓词 ──
    const violations: string[] = [];
    for (const item of returned) {
      const full = listings.find((l) => l.id === item.id);
      if (!full) {
        violations.push(`返回了库里不存在的房源 ${item.id}`);
        continue;
      }
      if (outOfBay) {
        violations.push(`湾区外需求却返回了房源「${full.title ?? full.id}」`);
      } else if (!pred.matches(full as never)) {
        violations.push(`「${(full.title ?? "").slice(0, 20)}」不满足严格条件`);
      }
    }
    if (returned.length > 5) {
      violations.push(`返回 ${returned.length} 条，超过 5 条上限`);
    }

    // ── 分类（严格模式语义）──
    // 空结果 + 库里确实没有 → DATA_GAP（正确地说了"没有"）
    // 空结果 + 终审剔空     → VERIFIER_CUT（谓词过了但 LLM 终审判矛盾；
    //                          剔除理由在 Vercel log，人工抽查那边）
    // 空结果 + 库里明明有   → CODE_BUG
    // 有结果 + 全部满足     → PASS；任何一条违反 → CODE_BUG
    let verdict: Verdict;
    if (returned.length === 0) {
      if (groundTruth.length === 0) {
        verdict = "DATA_GAP";
      } else {
        verdict = (r.verifierCutCount ?? 0) > 0 ? "VERIFIER_CUT" : "CODE_BUG";
      }
    } else {
      verdict = violations.length === 0 ? "PASS" : "CODE_BUG";
    }

    // ── LLM 判分（只对 PASS 的第一条：抓约束都过但语义跑偏的）──
    let judge: { score: number; reason: string } | null = null;
    if (JUDGE && verdict === "PASS" && returned[0]) {
      judge = await llmJudge(c.query, returned[0].rawText);
    }

    results.push({
      query: c.query,
      verdict,
      phase: r.action?.split(":")[0] ?? "?",
      violations,
      groundTruthCount: groundTruth.length,
      returnedCount: returned.length,
      listingTitles: returned.map((l) => l.title ?? "(无标题)"),
      judgeScore: judge?.score ?? null,
      judgeReason: judge?.reason ?? null,
    });

    const mark =
      verdict === "PASS"
        ? "✓"
        : verdict === "DATA_GAP"
          ? "◌"
          : verdict === "VERIFIER_CUT"
            ? "◔"
            : "✗";
    console.log(
      `${mark} [${i + 1}/${cases.length}] ${c.query.slice(0, 40)} → ${
        returned.length > 0
          ? `${returned.length}条: ${returned[0].title?.slice(0, 25) ?? "?"}…`
          : "(无结果)"
      } | 库内可满足: ${groundTruth.length}${
        violations.length ? ` [${violations.join("; ")}]` : ""
      }${judge && judge.score === 0 ? ` [判分0: ${judge.reason}]` : ""}`
    );
  }

  // ── 汇总 ──
  const pass = results.filter((r) => r.verdict === "PASS");
  const gaps = results.filter((r) => r.verdict === "DATA_GAP");
  const bugs = results.filter((r) => r.verdict === "CODE_BUG");
  const verifierCuts = results.filter((r) => r.verdict === "VERIFIER_CUT");
  const badJudge = pass.filter((r) => r.judgeScore === 0);

  const summary =
    `搜索评测（严格模式）${new Date().toISOString().slice(0, 10)}：共 ${results.length} 条\n` +
    `  ✓ PASS ${pass.length}  ◌ DATA_GAP ${gaps.length}（库里没有，正确说了"没有"）  ` +
    `◔ VERIFIER_CUT ${verifierCuts.length}（终审剔空，理由见 Vercel log）  ✗ CODE_BUG ${bugs.length}` +
    (JUDGE ? `  LLM判0分（约束过但语义跑偏）：${badJudge.length}` : "");
  console.log(`\n${summary}`);

  // ── 报告落盘 ──
  const reportDir = path.join("tests", "search-eval", "reports");
  mkdirSync(reportDir, { recursive: true });
  const lines: string[] = [
    `# 搜索评测报告 ${new Date().toISOString()}\n`,
    summary,
    "",
  ];
  for (const section of [
    ["## ✗ CODE_BUG（漏返回 / 返回了不满足严格条件的房源——需要修）", bugs],
    ["## ⚠ LLM 判 0 分（硬约束都过但语义不相关）", badJudge],
    ["## ◔ VERIFIER_CUT（谓词通过但 LLM 终审全部剔除；剔除理由在运行时日志）", verifierCuts],
    ["## ◌ DATA_GAP（数据库没有满足全部要求的房源，正确回答'没有'）", gaps],
    ["## ✓ PASS", pass],
  ] as const) {
    lines.push(section[0] as string);
    for (const r of section[1] as EvalResult[]) {
      lines.push(
        `- 「${r.query.slice(0, 80)}」→ ${r.returnedCount} 条` +
          (r.listingTitles.length
            ? `（${r.listingTitles.map((t) => t.slice(0, 15)).join(" / ")}）`
            : "") +
          ` | ${r.phase}` +
          (r.violations.length ? ` | 违反: ${r.violations.join("; ")}` : "") +
          ` | 库内可满足房源数: ${r.groundTruthCount}` +
          (r.judgeReason ? ` | 判分${r.judgeScore}: ${r.judgeReason}` : "")
      );
    }
    lines.push("");
  }
  const reportPath = path.join(
    reportDir,
    `${new Date().toISOString().slice(0, 10)}.md`
  );
  writeFileSync(reportPath, lines.join("\n"));
  writeFileSync(
    path.join(reportDir, "latest.json"),
    JSON.stringify({ summary, results }, null, 2)
  );
  console.log(`报告: ${reportPath}`);

  // ── Telegram 报警（只在有值得人看的问题时发）──
  if (NOTIFY && (bugs.length > 0 || badJudge.length > 0)) {
    const { sendFeedbackToTelegram } = await import("@/lib/feedback/telegram");
    const top = [...bugs, ...badJudge]
      .slice(0, 5)
      .map(
        (b) =>
          `· ${b.query.slice(0, 40)} → ${b.violations.join(";") || b.judgeReason}`
      )
      .join("\n");
    await sendFeedbackToTelegram(`⚠ ${summary}\n${top}`).catch((e) =>
      console.error("Telegram notify failed:", e)
    );
  }

  await db.end();
  process.exit(bugs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
