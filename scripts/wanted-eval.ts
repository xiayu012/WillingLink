/**
 * 求租搜索质量评测 runner —— 检验 searchWanted（房东找租客方向）。
 *
 * 与 search-eval.ts 对称：那个测「租客搜房源」，这个测「房东搜求租帖」。
 *
 * 数据源：XhsRentalListing 原文（真实房东语言）当作房东输入的查询。
 *
 * 判定核心 —— 区分「代码没写好」vs「库里本来没数据」：
 *   对每条查询先在全量求租帖上算 ground truth（地点匹配的求租帖集合）。
 *   - 返回帖子地点匹配              → PASS
 *   - 地点不匹配 & ground truth 为空 → DATA_GAP（搜索已尽力，非 bug）
 *   - 地点不匹配 & ground truth 非空 → CODE_BUG（明明有匹配的帖子却没返回）
 *   - 无结果     & ground truth 非空 → CODE_BUG
 *
 * 用法：NODE_OPTIONS=--conditions=react-server npx tsx scripts/wanted-eval.ts --limit 40
 * 退出码：存在 CODE_BUG → 1，否则 0。
 */

import { config } from "dotenv";
config({ path: ".env.local" });
for (const k of ["POSTGRES_URL", "VOYAGE_API_KEY", "OPENAI_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]!.slice(1, -1);
  }
}
process.env.SEARCH_DETERMINISTIC = "1";

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const LIMIT = Number(argValue("limit") ?? 40);

const db = postgres(process.env.POSTGRES_URL!);

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE =
  /(微信|vx|wx|wechat|电话|手机|联系方式)[:：]?\s*[\w+-]{5,}/gi;

function cleanText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

const NON_BAY_RE =
  /西雅图|seattle|芝加哥|chicago|纽约|new\s*york|nyc|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|波士顿|boston|奥斯汀|austin|尔湾|irvine|拉斯维加斯|vegas|达拉斯|dallas|休斯顿|houston/i;

type Verdict = "PASS" | "DATA_GAP" | "CODE_BUG";

type EvalResult = {
  query: string;
  verdict: Verdict;
  queryCity: string | null;
  returnedCount: number;
  returnedCities: (string | null)[];
  groundTruthCount: number;
  relaxedNote: string | null;
  violations: string[];
};

async function main() {
  const { createSearchWantedTool } = await import(
    "@/lib/ai/tools/search-wanted"
  );
  const { detectCity, cityAliases } = await import("@/lib/rental/cities");

  // Region alias set for a city: its own + each neighbour's spellings (EN+ZH).
  // Correctness proxy for keyword-location search = "does the post text mention
  // the requested city/neighbour at all", NOT "which city does first-match
  // detectCity pick" (that mislabels a 'Fremont/Berkeley both-OK' seeker).
  const regionAliases = (
    city: NonNullable<ReturnType<typeof detectCity>>
  ): string[] => {
    const terms = [...cityAliases(city)];
    for (const n of city.neighbors) {
      const e = detectCity(n);
      terms.push(...(e ? cityAliases(e) : [n]));
    }
    return [...new Set(terms.map((t) => t.toLowerCase()))];
  };
  const postInRegion = (
    row: { rawText?: unknown; title?: unknown; preferredLocations?: unknown },
    aliases: string[]
  ): boolean => {
    const hay =
      `${row.title ?? ""} ${row.preferredLocations ?? ""} ${row.rawText ?? ""}`.toLowerCase();
    return aliases.some((a) => hay.includes(a));
  };

  // 房东查询：用真实房源原文
  const listingRows = await db`
    SELECT "rawText", title, city, "locationText" FROM "XhsRentalListing"
    WHERE LENGTH(TRIM("rawText")) >= 15
    ORDER BY "createdAt" DESC
    LIMIT ${LIMIT * 2}
  `;
  const cases = listingRows
    .map((r) => ({ query: cleanText(r.rawText as string) }))
    .filter((c) => c.query.length >= 12)
    .slice(0, LIMIT);

  // 全量求租帖，供 ground truth 与结果核验
  const wanted = await db`
    SELECT id, title, "rawText", "preferredLocations"
    FROM "XhsRentalWanted"
  `;

  // Display label only — which city a post most-mentions (first-match).
  const labelCity = (row: (typeof wanted)[number]): string | null => {
    const hit = detectCity(
      `${row.title ?? ""} ${row.preferredLocations ?? ""} ${row.rawText ?? ""}`
    );
    return hit ? hit.en : null;
  };

  console.log(`求租评测 ${cases.length} 条\n`);
  const results: EvalResult[] = [];

  for (const [i, c] of cases.entries()) {
    const queryCity = detectCity(c.query);
    const outOfBay = !queryCity && NON_BAY_RE.test(c.query);
    const aliases = queryCity ? regionAliases(queryCity) : null;

    // ground truth：文本提及请求城市/邻居（任一拼写）的求租帖。无城市则任何帖都算。
    const groundTruth = wanted.filter((row) => {
      if (outOfBay) return false;
      if (!aliases) return true;
      return postInRegion(row, aliases);
    });

    const tool = createSearchWantedTool(`eval-${randomUUID()}`);
    const r: {
      wanted: (typeof wanted)[number][] | null;
      relaxedNote: string | null;
      count: number;
    } = (await (tool as { execute: Function }).execute(
      { query: c.query },
      {}
    )) as never;

    const returned = r.wanted ?? [];
    const returnedCities = returned.map((w) =>
      labelCity(wanted.find((x) => x.id === w.id) ?? w)
    );

    const violations: string[] = [];
    // 真正的 violation：查询有明确城市、非松弛结果，但返回帖文本里根本不含
    // 请求城市/邻居的任何拼写（说明地点过滤没生效）。
    if (aliases && !r.relaxedNote) {
      for (const w of returned) {
        const row = wanted.find((x) => x.id === w.id) ?? w;
        if (!postInRegion(row, aliases)) {
          violations.push(`${labelCity(row) ?? "?"}≠${queryCity?.en}`);
        }
      }
    }

    let verdict: Verdict;
    if (outOfBay) {
      verdict = "DATA_GAP";
    } else if (returned.length === 0) {
      verdict = groundTruth.length > 0 ? "CODE_BUG" : "DATA_GAP";
    } else if (violations.length === 0) {
      verdict = "PASS";
    } else {
      verdict = groundTruth.length > 0 ? "CODE_BUG" : "DATA_GAP";
    }

    results.push({
      query: c.query,
      verdict,
      queryCity: queryCity?.en ?? null,
      returnedCount: returned.length,
      returnedCities,
      groundTruthCount: groundTruth.length,
      relaxedNote: r.relaxedNote,
      violations,
    });

    const mark = verdict === "PASS" ? "✓" : verdict === "DATA_GAP" ? "◌" : "✗";
    console.log(
      `${mark} [${i + 1}/${cases.length}] ${queryCity?.en ?? "?"} 「${c.query.slice(0, 32)}」 → ${returned.length}条 [${returnedCities.map((x) => x ?? "?").join(",")}]${
        violations.length ? ` ✗${violations.join(";")}` : ""
      }${r.relaxedNote ? " ~松弛" : ""} (GT=${groundTruth.length})`
    );
  }

  const pass = results.filter((r) => r.verdict === "PASS");
  const gaps = results.filter((r) => r.verdict === "DATA_GAP");
  const bugs = results.filter((r) => r.verdict === "CODE_BUG");

  const summary =
    `求租评测 ${new Date().toISOString().slice(0, 10)}：共 ${results.length} 条\n` +
    `  ✓ PASS ${pass.length}  ◌ DATA_GAP ${gaps.length}  ✗ CODE_BUG ${bugs.length}`;
  console.log(`\n${summary}`);

  const reportDir = path.join("tests", "search-eval", "reports");
  mkdirSync(reportDir, { recursive: true });
  const lines: string[] = [
    `# 求租评测报告 ${new Date().toISOString()}\n`,
    summary,
    "",
    "## ✗ CODE_BUG（库里有匹配的求租帖却没返回——需要修）",
  ];
  for (const r of bugs) {
    lines.push(
      `- ${r.queryCity ?? "?"} 「${r.query.slice(0, 70)}」→ ${r.returnedCount}条 [${r.returnedCities.map((x) => x ?? "?").join(",")}] | 违反:${r.violations.join(";")} | GT=${r.groundTruthCount}`
    );
  }
  writeFileSync(
    path.join(reportDir, "wanted-latest.json"),
    JSON.stringify({ summary, results }, null, 2)
  );
  writeFileSync(
    path.join(reportDir, `wanted-${new Date().toISOString().slice(0, 10)}.md`),
    lines.join("\n")
  );

  await db.end();
  process.exit(bugs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
