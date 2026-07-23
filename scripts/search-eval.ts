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
for (const k of ["POSTGRES_URL", "VOYAGE_API_KEY", "OPENAI_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]!.slice(1, -1);
  }
}
// 评测必须可复现
process.env.SEARCH_DETERMINISTIC = "1";

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
const JUDGE = !process.argv.includes("--no-judge") && Boolean(process.env.OPENAI_API_KEY);

const db = postgres(process.env.POSTGRES_URL!);

// ── 查询清洗（求租帖原文 → 可搜索的查询文本）─────────────────────────────────

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE = /(微信|vx|wx|wechat|电话|手机|联系方式)[:：]?\s*[\w+-]{5,}/gi;

function cleanWantedText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

// ── 湾区外城市（出现且无湾区城市时 → 库外需求，属 DATA_GAP）─────────────────

const NON_BAY_RE =
  /西雅图|seattle|芝加哥|chicago|纽约|new\s*york|nyc|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|波士顿|boston|奥斯汀|austin|尔湾|irvine|拉斯维加斯|vegas|达拉斯|dallas|休斯顿|houston|费城|philadelphia|华盛顿|dc\b|亚特兰大|atlanta|凤凰城|phoenix|丹佛|denver|波特兰|portland/i;

// ── 主流程 ────────────────────────────────────────────────────────────────────

type EvalCase = { source: string; query: string };

type Verdict = "PASS" | "DATA_GAP" | "CODE_BUG";

type EvalResult = {
  query: string;
  verdict: Verdict;
  noteMissing: boolean;
  phase: string;
  violations: string[];
  groundTruthCount: number;
  listingTitle: string | null;
  listingCity: string | null;
  listingRent: number | null;
  relaxedNote: string | null;
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
    .map((r) => ({ source: "wanted", query: cleanWantedText(r.rawText as string) }))
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
          { role: "user", content: `【需求】${query}\n【房源】${listingText.slice(0, 500)}` },
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
  const { createSearchRentalTool } = await import("@/lib/ai/tools/search-rental");
  const { detectCity } = await import("@/lib/rental/cities");
  const { extractHardConstraints, rowViolates, hasAnyConstraint } = await import(
    "@/lib/rental/query-constraints"
  );

  const cases = await collectCases();
  console.log(`评测 ${cases.length} 条（源：${cases[0]?.source ?? "?"}）\n`);

  // 全量房源一次取回，供 ground truth 与结果核验
  const listings = await db`
    SELECT "id", "title", "rawText", "locationText", "city", "rentNumeric",
           "bedroomsNum", "availableFrom", "petFriendly", "couplesOk",
           "utilitiesIncluded", "parkingIncluded", "furnished"
    FROM "XhsRentalListing"
  `;
  const resolveCity = (row: (typeof listings)[number]): string | null => {
    if (row.city) return row.city as string;
    const hit = detectCity(
      `${row.title ?? ""} ${row.locationText ?? ""} ${row.rawText ?? ""}`
    );
    return hit ? hit.en : null;
  };

  const results: EvalResult[] = [];

  for (const [i, c] of cases.entries()) {
    const constraints = extractHardConstraints(c.query);
    const queryCity = detectCity(c.query);
    const outOfBay = !queryCity && NON_BAY_RE.test(c.query);
    const cityWhitelist = queryCity
      ? [queryCity.en, ...queryCity.neighbors].map((s) => s.toLowerCase())
      : null;

    // ── ground truth：可证明满足所有硬约束的房源数 ──
    const groundTruth = listings.filter((row) => {
      if (outOfBay) return false; // 库只有湾区
      if (rowViolates(row as never, constraints)) return false;
      // 严格化：有预算要求时租金必须已解析，有城市要求时城市必须命中白名单
      if (constraints.rentMax != null && row.rentNumeric == null) return false;
      if (cityWhitelist) {
        const rc = resolveCity(row);
        if (!rc || !cityWhitelist.includes(rc.toLowerCase())) return false;
      }
      return true;
    });

    // ── 执行搜索 ──
    const tool = createSearchRentalTool(`eval-${randomUUID()}`);
    const r: {
      listing: (typeof listings)[number] | null;
      relaxedNote: string | null;
    } = (await (tool as { execute: Function }).execute(
      { query: c.query },
      {}
    )) as never;

    // ── 核验返回结果 ──
    const violations: string[] = [];
    let listingCity: string | null = null;
    if (r.listing) {
      const full = listings.find((l) => l.id === r.listing?.id) ?? r.listing;
      listingCity = resolveCity(full as never);
      if (
        constraints.rentMax != null &&
        full.rentNumeric != null &&
        full.rentNumeric > constraints.rentMax
      ) {
        violations.push(`超预算 $${full.rentNumeric}>${constraints.rentMax}`);
      }
      if (cityWhitelist && listingCity && !cityWhitelist.includes(listingCity.toLowerCase())) {
        violations.push(`城市不符 ${listingCity}≠${queryCity?.en}`);
      }
      if (
        constraints.bedroomsNum != null &&
        full.bedroomsNum != null &&
        full.bedroomsNum !== constraints.bedroomsNum
      ) {
        violations.push(`房型不符 ${full.bedroomsNum}室≠${constraints.bedroomsNum}室`);
      }
    }

    // ── 分类 ──
    let verdict: Verdict;
    if (outOfBay) {
      // 库外需求（西雅图等）：无论返回什么都是数据覆盖问题，唯一该做的是提示用户
      verdict = "DATA_GAP";
    } else if (!r.listing) {
      verdict = groundTruth.length > 0 ? "CODE_BUG" : "DATA_GAP";
    } else if (violations.length === 0) {
      verdict = "PASS";
    } else {
      verdict = groundTruth.length > 0 ? "CODE_BUG" : "DATA_GAP";
    }
    const noteMissing = verdict === "DATA_GAP" && Boolean(r.listing) && !r.relaxedNote;

    // ── LLM 判分（只对 PASS：抓约束都过但语义跑偏的）──
    let judge: { score: number; reason: string } | null = null;
    if (JUDGE && verdict === "PASS" && r.listing) {
      judge = await llmJudge(c.query, r.listing.rawText as string);
    }

    results.push({
      query: c.query,
      verdict,
      noteMissing,
      phase: (r as { phase?: string }).phase ?? "?",
      violations,
      groundTruthCount: groundTruth.length,
      listingTitle: (r.listing?.title as string) ?? null,
      listingCity,
      listingRent: (r.listing?.rentNumeric as number) ?? null,
      relaxedNote: r.relaxedNote,
      judgeScore: judge?.score ?? null,
      judgeReason: judge?.reason ?? null,
    });

    const mark =
      verdict === "PASS" ? "✓" : verdict === "DATA_GAP" ? "◌" : "✗";
    console.log(
      `${mark} [${i + 1}/${cases.length}] ${c.query.slice(0, 40)} → ${
        r.listing?.title?.slice(0, 30) ?? "(无结果)"
      }${violations.length ? ` [${violations.join("; ")}]` : ""}${
        judge && judge.score === 0 ? ` [判分0: ${judge.reason}]` : ""
      }`
    );
  }

  // ── 汇总 ──
  const pass = results.filter((r) => r.verdict === "PASS");
  const gaps = results.filter((r) => r.verdict === "DATA_GAP");
  const bugs = results.filter((r) => r.verdict === "CODE_BUG");
  const noteMissing = results.filter((r) => r.noteMissing);
  const badJudge = pass.filter((r) => r.judgeScore === 0);

  const summary =
    `搜索评测 ${new Date().toISOString().slice(0, 10)}：共 ${results.length} 条\n` +
    `  ✓ PASS ${pass.length}  ◌ DATA_GAP ${gaps.length}（库里没数据，非 bug）  ✗ CODE_BUG ${bugs.length}\n` +
    `  提示缺失（跨城/放宽但无 relaxedNote）：${noteMissing.length}` +
    (JUDGE ? `  LLM判0分（约束过但语义跑偏）：${badJudge.length}` : "");
  console.log(`\n${summary}`);

  // ── 报告落盘 ──
  const reportDir = path.join("tests", "search-eval", "reports");
  mkdirSync(reportDir, { recursive: true });
  const lines: string[] = [`# 搜索评测报告 ${new Date().toISOString()}\n`, summary, ""];
  for (const section of [
    ["## ✗ CODE_BUG（库里有满足的房源却没返回——需要修）", bugs],
    ["## ⚠ 提示缺失（结果放宽了但没告诉用户）", noteMissing],
    ["## ⚠ LLM 判 0 分（硬约束都过但语义不相关）", badJudge],
    ["## ◌ DATA_GAP（数据库没有对应房源，搜索已尽力）", gaps],
    ["## ✓ PASS", pass],
  ] as const) {
    lines.push(section[0] as string);
    for (const r of section[1] as EvalResult[]) {
      lines.push(
        `- 「${r.query.slice(0, 80)}」→ ${r.listingTitle ?? "(无结果)"}` +
          ` | ${r.listingCity ?? "?"} | $${r.listingRent ?? "?"} | ${r.phase}` +
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
  if (NOTIFY && (bugs.length > 0 || noteMissing.length > 0 || badJudge.length > 0)) {
    const { sendFeedbackToTelegram } = await import("@/lib/feedback/telegram");
    const top = [...bugs, ...badJudge]
      .slice(0, 5)
      .map((b) => `· ${b.query.slice(0, 40)} → ${b.violations.join(";") || b.judgeReason}`)
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
