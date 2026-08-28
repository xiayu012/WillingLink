/**
 * 召回评测 —— 专门盯"库里明明有，搜索却说没有"。
 *
 * 为什么需要第二套评测
 * --------------------
 * `search-eval` 的 ground truth 与运行时**共用同一个 buildStrictPredicate**，
 * 这保证了判定不漂移，但也让它对"筛选过严"完全失明：谓词误杀一条房源时，
 * ground truth 也同步误杀，于是仍然记 PASS。AGENT_LOG 2026-08-15 已经写明
 * "别指望评测数字变红"——而 50% 的真实查询根本没有地点约束这种事，正是靠
 * 人工统计才发现的。这个脚本把那次人工统计变成可重复的门禁。
 *
 * 方法：**ground truth 不经过我们的任何筛选代码**
 *   1. 用向量检索（纯语义，与谓词无关）取 top-N 候选；
 *   2. 逐条问 LLM：这条房源满足租客说出口的全部硬性要求吗？yes/no/unsure；
 *   3. yes 的集合 = A。再看我们的严格谓词留下了 A 里的多少条。
 *
 * 三个指标：
 *   recall        A 中被谓词保留的比例 ← **过严的唯一探针**
 *   precision     工具真正返回的房源里被 LLM 认可的比例 ← 过松的探针
 *   falseEmpty    A 非空但工具返回 0 条的查询数 ← "库里有却说没有"，最痛的失败
 *
 * 用法：
 *   pnpm search-recall-eval                    # 24 条查询 × top40 候选
 *   pnpm search-recall-eval -- --limit 40 --candidates 60
 *   pnpm search-recall-eval -- --no-tool       # 只测谓词，跳过整条工具链（快）
 *
 * 报告：tests/search-eval/reports/recall-<日期>.md
 * 退出码：recall < RECALL_FLOOR → 1。
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
process.env.SEARCH_DETERMINISTIC = "1";

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const LIMIT = Number(argValue("limit") ?? 24);
const CANDIDATES = Number(argValue("candidates") ?? 40);
const RUN_TOOL = !process.argv.includes("--no-tool");
/**
 * 低于这条线视为回归。
 *
 * **这是相对基线，不是质量目标**。判官比我们的产品契约宽松（它会接受"邻市也算
 * 满足"这类判断，我们不会），所以 100% 既不可达也不该追。2026-08-24 连续几轮
 * 实测落在 72–75%，判官本身的抖动就有几个百分点（同样的代码两轮 62.8% / 73.1%
 * 都出现过）。0.65 是"明显退步才报警"的位置——盯的是掉到 50% 那种事故，
 * 不是小数点。真正要读的是报告里的两份明细。
 */
const RECALL_FLOOR = Number(argValue("floor") ?? 0.65);
const JUDGE_CHUNK = 8;

const db = postgres(process.env.POSTGRES_URL!);

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE =
  /(微信|vx|wx|wechat|电话|手机|联系方式)[:：]?\s*[\w+-]{5,}/gi;
const WS_RE = /\s+/g;

function cleanWantedText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(WS_RE, " ")
    .trim()
    .slice(0, 300);
}

type Row = {
  id: string;
  title: string | null;
  rawText: string;
};

type Judgement = "yes" | "no" | "unsure";

let judgeFailures = 0;
const JUDGE_RETRIES = 2;
const JUDGE_TIMEOUT_MS = 90_000;

/** POST to the judge, retrying transient failures; null when it never lands. */
async function fetchWithRetry(
  body: Record<string, unknown>
): Promise<{ choices?: { message?: { content?: string } }[] } | null> {
  for (let attempt = 0; attempt <= JUDGE_RETRIES; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      // 只打 name/message：AI SDK 之外的错误对象也可能让 inspect 自己抛。
      const err = e as Error;
      console.error(`  judge retry ${attempt + 1}: ${err.name} ${err.message}`);
    }
  }
  return null;
}

/**
 * 判定一批候选是否满足租客的硬性要求。**故意不给它看我们的任何结构化字段**
 * ——它读的是房源原文，和人一样。
 */
async function judgeBatch(
  query: string,
  rows: Row[]
): Promise<{ verdict: Judgement; reason: string }[]> {
  const listingBlock = rows
    .map(
      (r, i) =>
        `【候选${i + 1}】${r.title ?? "(无标题)"}\n${r.rawText.slice(0, 900)}`
    )
    .join("\n\n");
  // 判官是网络调用，偶发 headers timeout 会把整轮评测炸掉（实测过两次）。
  // 重试两次，仍失败就整批记 unsure —— 评测本身绝不能因为一次抖动前功尽弃。
  const res = await fetchWithRetry({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是租房中介，替租客人工筛房源。对每个候选判断：它是否满足租客**明说的硬性要求**（城市/预算/户型/租期/入住时间/宠物等）？\n" +
          '- "yes"：没有任何一条硬性要求被违反（帖子对某要求沉默 → 不算违反）。\n' +
          '- "no"：可以指出帖子里的具体内容与某条硬性要求矛盾。\n' +
          '- "unsure"：信息不足以判断。\n' +
          "只看租客真正说出口的要求；租客没提的属性不要脑补。带'最好/优先/或者/都可以'的是偏好不是硬性要求，不因为它判 no。\n" +
          // 判官必须和产品契约用同一把尺，否则 recall 量的是"判官比我们宽松
          // 多少"，不是"我们过严多少"。这三条是实测中判官最爱通融的地方。
          "但下面三种情况必须判 no，不许通融：\n" +
          "· 租客点名了城市，房源在别的城市——相邻、通勤方便、同属东湾/南湾，都不算满足。\n" +
          "  （但租客**没有**点名城市时，绝不许以城市为由判 no——没说就是不限。\n" +
          "   租客说的是片区/学校/公司附近而不是城市名时，同城或通勤可达都算满足。）\n" +
          "· 租客点名了户型（studio / 1b1b / 2b2b …），房源是别的户型——数字不同就是不同。\n" +
          "· 租客给了预算上限，房源租金超过它——超一块钱也是超。\n" +
          "· 租客自述了性别（'本人男''我是女生'），房源写明只招异性（'限女生''只招男生'\n" +
          "  '希望租客：女生'）——他根本住不进去，比预算更硬。\n" +
          "  （'女生优先'是偏好不是限定，不判 no；房东自述'本人女生'也不是对租客的限定。）\n" +
          '只输出 JSON：{"results":[{"i":1,"verdict":"yes|no|unsure","reason":"一句话"}]}',
      },
      {
        role: "user",
        content: `【租客需求】${query}\n\n${listingBlock}`,
      },
    ],
  });
  if (!res) {
    judgeFailures++;
    return rows.map(() => ({
      verdict: "unsure" as const,
      reason: "judge unavailable",
    }));
  }
  const data = res;
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  const out: { verdict: Judgement; reason: string }[] = rows.map(() => ({
    verdict: "unsure" as const,
    reason: "",
  }));
  for (const item of parsed.results ?? []) {
    const idx = Number(item?.i) - 1;
    if (idx >= 0 && idx < out.length) {
      const v = String(item?.verdict ?? "unsure");
      out[idx] = {
        verdict: v === "yes" || v === "no" ? v : "unsure",
        reason: String(item?.reason ?? ""),
      };
    }
  }
  return out;
}

type CaseResult = {
  query: string;
  approved: number;
  keptByPredicate: number;
  recall: number | null;
  returned: number;
  returnedApproved: number;
  precision: number | null;
  falseEmpty: boolean;
  plan: string;
  /** LLM 认可、却被谓词筛掉的（过严证据）。 */
  misses: { title: string; reason: string }[];
  /** 真的返回给用户、却被 LLM 判不合格的（过松证据）。 */
  rejects: { title: string; reason: string }[];
};

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("需要 OPENAI_API_KEY（LLM ground truth 用它）");
    process.exit(1);
  }

  const { createSearchRentalTool, buildStrictPredicate } = await import(
    "@/lib/ai/tools/search-rental"
  );
  const { planQuery, planSummary } = await import("@/lib/rental/query-plan");
  const { embedText } = await import("@/lib/ai/embeddings");
  const { vectorSearchXhsRentalListings } = await import("@/lib/db/queries");

  const wanted = await db`
    SELECT "rawText" FROM "XhsRentalWanted"
    WHERE LENGTH(TRIM("rawText")) >= 40
    ORDER BY "createdAt" DESC
    LIMIT ${LIMIT * 2}
  `;
  const cases = wanted
    .map((r) => cleanWantedText(r.rawText as string))
    .filter((q) => q.length >= 30)
    .slice(0, LIMIT);

  console.log(`召回评测 ${cases.length} 条 × top${CANDIDATES} 候选\n`);

  const results: CaseResult[] = [];

  for (const [i, query] of cases.entries()) {
    const plan = await planQuery(query);

    // ── 候选池：纯语义，与我们的筛选代码无关 ──
    const vec = await embedText(query, "query");
    const pool = (await vectorSearchXhsRentalListings(
      vec,
      CANDIDATES
    )) as unknown as (Row & Record<string, unknown>)[];

    // ── 工具真正返回的（整条链路：计划 → 谓词 → rerank → 终审）──
    let returned: Row[] = [];
    if (RUN_TOOL && !plan.outOfScope) {
      const tool = createSearchRentalTool(`eval-recall-${randomUUID()}`);
      const r = (await (tool as { execute: Function }).execute(
        { query },
        {}
      )) as { listings?: Row[] };
      returned = r.listings ?? [];
    }

    // 判定池 = 候选 ∪ 实际返回（返回的可能不在 top-N 候选里）
    const judgePool = [...pool];
    for (const r of returned) {
      if (!judgePool.some((p) => p.id === r.id)) {
        judgePool.push(r as Row & Record<string, unknown>);
      }
    }

    const judged = new Map<string, { verdict: Judgement; reason: string }>();
    if (!plan.outOfScope) {
      const chunks: (Row & Record<string, unknown>)[][] = [];
      for (let k = 0; k < judgePool.length; k += JUDGE_CHUNK) {
        chunks.push(judgePool.slice(k, k + JUDGE_CHUNK));
      }
      const verdicts = await Promise.all(
        chunks.map((c) => judgeBatch(query, c))
      );
      chunks.forEach((chunk, ci) => {
        chunk.forEach((row, ri) => {
          judged.set(row.id, verdicts[ci][ri]);
        });
      });
    }

    const approved = judgePool.filter(
      (r) => judged.get(r.id)?.verdict === "yes"
    );
    const pred = buildStrictPredicate(plan);
    const kept = approved.filter((r) => pred.matches(r as never));
    const misses = approved
      .filter((r) => !pred.matches(r as never))
      .slice(0, 5)
      .map((r) => ({
        title: (r.title ?? r.rawText).slice(0, 40),
        reason: judged.get(r.id)?.reason ?? "",
      }));

    const returnedApproved = returned.filter(
      (r) => judged.get(r.id)?.verdict === "yes"
    ).length;
    const rejects = returned
      .filter((r) => judged.get(r.id)?.verdict === "no")
      .slice(0, 5)
      .map((r) => ({
        title: (r.title ?? r.rawText).slice(0, 40),
        reason: judged.get(r.id)?.reason ?? "",
      }));

    const result: CaseResult = {
      query,
      approved: approved.length,
      keptByPredicate: kept.length,
      recall: approved.length > 0 ? kept.length / approved.length : null,
      returned: returned.length,
      returnedApproved,
      precision:
        returned.length > 0 ? returnedApproved / returned.length : null,
      falseEmpty: approved.length > 0 && returned.length === 0 && RUN_TOOL,
      plan: planSummary(plan),
      misses,
      rejects,
    };
    results.push(result);

    console.log(
      `[${i + 1}/${cases.length}] ${query.slice(0, 34)}… ` +
        `认可${result.approved} 谓词留${result.keptByPredicate} ` +
        `召回${result.recall == null ? "-" : `${Math.round(result.recall * 100)}%`} ` +
        `返回${result.returned}(合格${result.returnedApproved})` +
        (result.falseEmpty ? "  ✗ 库里有却返回空" : "") +
        `\n      计划: ${result.plan}`
    );
  }

  // ── 汇总（按房源条数加权，不是按查询平均——大查询不该被小查询稀释）──
  const totApproved = results.reduce((a, r) => a + r.approved, 0);
  const totKept = results.reduce((a, r) => a + r.keptByPredicate, 0);
  const totReturned = results.reduce((a, r) => a + r.returned, 0);
  const totReturnedOk = results.reduce((a, r) => a + r.returnedApproved, 0);
  const falseEmpties = results.filter((r) => r.falseEmpty);
  const recall = totApproved > 0 ? totKept / totApproved : 1;
  const precision = totReturned > 0 ? totReturnedOk / totReturned : 1;

  const summary =
    `召回评测 ${new Date().toISOString().slice(0, 10)}：${results.length} 条查询\n` +
    `  recall  ${(recall * 100).toFixed(1)}%  (LLM 认可 ${totApproved} 条，谓词保留 ${totKept} 条) ← 过严探针\n` +
    `  precision ${(precision * 100).toFixed(1)}%  (返回 ${totReturned} 条，其中合格 ${totReturnedOk} 条) ← 过松探针\n` +
    `  falseEmpty ${falseEmpties.length} 条查询「库里有却返回空」` +
    (judgeFailures > 0
      ? `\n  ⚠ ${judgeFailures} 批判定调用失败，这些候选记 unsure —— 数字偏保守`
      : "");
  console.log(`\n${summary}`);

  const reportDir = path.join("tests", "search-eval", "reports");
  mkdirSync(reportDir, { recursive: true });
  const lines = [
    `# 召回评测 ${new Date().toISOString()}\n`,
    summary,
    "",
    "## 谓词误杀明细（LLM 认可但被筛掉）",
  ];
  for (const r of results.filter((x) => x.misses.length > 0)) {
    lines.push(`\n### ${r.query.slice(0, 70)}`);
    lines.push(`计划: ${r.plan}`);
    for (const m of r.misses) {
      lines.push(`- 「${m.title}」 ${m.reason}`);
    }
  }
  lines.push("\n## 返回了却不合格（过松证据）");
  for (const r of results.filter((x) => x.rejects.length > 0)) {
    lines.push(`\n### ${r.query.slice(0, 70)}`);
    lines.push(`计划: ${r.plan}`);
    for (const m of r.rejects) {
      lines.push(`- 「${m.title}」 ${m.reason}`);
    }
  }

  lines.push("\n## 每条查询");
  for (const r of results) {
    lines.push(
      `- ${r.query.slice(0, 60)} | 认可${r.approved} 留${r.keptByPredicate} 返回${r.returned}(合格${r.returnedApproved})${r.falseEmpty ? " ✗falseEmpty" : ""} | ${r.plan}`
    );
  }
  const reportPath = path.join(
    reportDir,
    `recall-${new Date().toISOString().slice(0, 10)}.md`
  );
  writeFileSync(reportPath, lines.join("\n"));
  console.log(`报告: ${reportPath}`);

  await db.end();
  process.exit(recall < RECALL_FLOOR ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
