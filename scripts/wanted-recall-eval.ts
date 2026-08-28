/**
 * searchWanted 召回评测 —— 专门盯"库里明明有合适的人，却说没有"。
 *
 * 为什么单独一套
 * --------------
 * `search-recall-eval` 量的是**租客找房**那条路（searchRental）。房东/找室友的
 * 人走的是另一条完全独立的实现（`lib/ai/tools/search-wanted.ts`），它没跟着
 * 升级到 `planQuery` 那套理解层，至今是**关键词字符串匹配**：把帖子拆成几个词，
 * 要求求租帖**同时包含全部**这些词。
 *
 * 实测踩到过：一位房东找 San Mateo 的女生室友，拆出【"长租"、"女生"】两个词，
 * 而库里 4 条真正符合的求租帖**没有一条写了"长租"这两个字**（写的是"合租"或
 * 干脆没提租期）→ 一条都没搜到，对外回"我手里没有完全符合的"。
 * 那次是人工翻库才发现的，这个脚本把它变成可重复的观测。
 *
 * 方法：**ground truth 不经过我们的任何匹配代码**
 *   1. 房东侧的帖子（XhsRentalListing）当查询；
 *   2. 从求租帖里**随机**取 N 条当候选池——随机是关键，用我们自己的关键词
 *      逻辑去挑候选，就会跟 search-eval 一样对"筛太严"结构性失明；
 *   3. 逐条问 LLM：这个人满足房东说出口的硬性条件吗？yes/no/unsure；
 *   4. yes 的集合 = A。再看 `findNextWanted` 实际返回了 A 里的什么。
 *
 * 指标（按重要性排）：
 *   falseEmpty   A 非空但工具一条没返回 ← **就是上面那个 bug，最痛的失败**
 *   relaxedRate  工具没找到精确匹配、退回"放宽条件"的比例
 *   precision    工具返回的人里被 LLM 认可的比例
 *
 * 用法：
 *   pnpm wanted-recall-eval    # 16 条查询 × 30 候选
 *   pnpm wanted-recall-eval -- --limit 24 --candidates 40
 *
 * 报告：tests/search-eval/reports/wanted-recall-<日期>.md
 * **这个脚本只观测，不改任何线上行为，也不设退出码门禁**——先摸清底数，
 * 有了基线再谈定门槛。
 */
import { config } from "dotenv";

config({ path: ".env.local" });
for (const k of ["POSTGRES_URL", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]?.replace(/^"|"$/g, "");
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const LIMIT = Number(argValue("limit") ?? 16);
const CANDIDATES = Number(argValue("candidates") ?? 30);
/** 固定种子，让候选池在多次运行之间稳定，指标才可比。 */
const SEED = Number(argValue("seed") ?? 42);

const db = postgres(process.env.POSTGRES_URL as string);

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE =
  /(微信|vx|wx|wechat|电话|手机|联系方式)[:：]?\s*[\w+-]{5,}/gi;
const WS_RE = /\s+/g;

function cleanText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(WS_RE, " ")
    .trim()
    .slice(0, 300);
}

/** 可复现的伪随机——候选池必须每次一样，否则指标没法跨运行比较。 */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type WantedRow = { id: string; rawText: string };
type Judgement = "yes" | "no" | "unsure";

const JUDGE_RETRIES = 2;
const JUDGE_TIMEOUT_MS = 90_000;
const JUDGE_CHUNK = 8;
let judgeFailures = 0;

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
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      const err = e as Error;
      console.error(`  judge retry ${attempt + 1}: ${err.name} ${err.message}`);
    }
  }
  return null;
}

/**
 * 判定一批求租者是否满足房东说出口的硬性条件。
 * **故意不给它看我们的关键词逻辑**——它读原文，和人一样。
 */
async function judgeBatch(
  landlordPost: string,
  rows: WantedRow[]
): Promise<{ verdict: Judgement; reason: string }[]> {
  const block = rows
    .map((r, i) => `【候选${i + 1}】${cleanText(r.rawText)}`)
    .join("\n\n");
  const res = await fetchWithRetry({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "你是租房中介，替**房东/找室友的人**筛选求租者。房东有房（或有位置）要找人；" +
          "候选是别人发的求租帖。对每个候选判断：这个人是否满足房东**明说的硬性条件**？\n" +
          '- "yes"：没有任何一条硬性条件被违反（求租帖对某条沉默 → 不算违反）。\n' +
          '- "no"：可以指出求租帖里的具体内容与某条硬性条件矛盾。\n' +
          '- "unsure"：信息不足以判断。\n' +
          "只看房东真正说出口的条件；房东没提的属性不要脑补。" +
          "带'最好/优先/或者/都可以'的是偏好不是硬性条件，不因为它判 no。\n" +
          "下面几种必须判 no：\n" +
          "· 房东点名了城市/区域，求租者要的是别的地方——相邻、通勤方便都不算满足。\n" +
          "· 房东写明只招某个性别，求租者是异性。\n" +
          "· 求租者的预算明显低于房东的报价。\n" +
          "· 候选其实是房源帖/招租帖（不是求租的人），对找租客的房东是矛盾。\n" +
          "**措辞不同不算矛盾**：'长租'和'长期'、'合租'和'找室友'说的是一回事，" +
          "不要因为用词不同就判 no。\n" +
          '只输出 JSON：{"results":[{"i":1,"verdict":"yes|no|unsure","reason":"一句话"}]}',
      },
      { role: "user", content: `【房东的帖子】${landlordPost}\n\n${block}` },
    ],
  });
  if (!res) {
    judgeFailures++;
    return rows.map(() => ({
      verdict: "unsure" as const,
      reason: "judge unavailable",
    }));
  }
  const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
  const out = rows.map(() => ({
    verdict: "unsure" as Judgement,
    reason: "",
  }));
  for (const r of parsed.results ?? []) {
    const i = Number(r.i) - 1;
    if (i >= 0 && i < out.length) {
      out[i] = {
        verdict: r.verdict as Judgement,
        reason: String(r.reason ?? ""),
      };
    }
  }
  return out;
}

async function main() {
  const { findNextWanted } = await import("@/lib/ai/tools/search-wanted");

  const landlordPosts = await db`
    SELECT "rawText" FROM "XhsRentalListing"
    WHERE LENGTH(TRIM("rawText")) >= 60
    ORDER BY "createdAt" DESC
    LIMIT ${LIMIT * 3}
  `;
  const allWanted = (await db`
    SELECT id, "rawText" FROM "XhsRentalWanted"
    WHERE LENGTH(TRIM("rawText")) >= 40
  `) as unknown as WantedRow[];

  const queries = landlordPosts
    .map((r) => cleanText(r.rawText as string))
    .filter((q) => q.length >= 40)
    .slice(0, LIMIT);

  console.log(
    `searchWanted 召回评测：${queries.length} 条房东帖 × ${CANDIDATES} 随机候选（求租库共 ${allWanted.length} 条）\n`
  );

  let falseEmpty = 0;
  let relaxedCount = 0;
  let toolReturned = 0;
  let toolGood = 0;
  let gtTotal = 0;
  const details: string[] = [];

  for (const [qi, query] of queries.entries()) {
    // 随机候选池：**绝不能用我们自己的关键词逻辑来挑**，否则跟被测代码同源，
    // 对"筛太严"完全失明（search-eval 就是这么瞎的）。
    const pool = seededShuffle(allWanted, SEED + qi).slice(0, CANDIDATES);

    const verdicts: { verdict: Judgement; reason: string }[] = [];
    for (let i = 0; i < pool.length; i += JUDGE_CHUNK) {
      verdicts.push(
        ...(await judgeBatch(query, pool.slice(i, i + JUDGE_CHUNK)))
      );
    }
    const accepted = pool.filter((_, i) => verdicts[i]?.verdict === "yes");
    gtTotal += accepted.length;

    const result = await findNextWanted(query, [], []);
    const returned = result?.wanted ?? [];
    const relaxed = Boolean(result?.relaxedNote);
    if (relaxed) {
      relaxedCount++;
    }
    toolReturned += returned.length;

    const acceptedIds = new Set(accepted.map((a) => a.id));
    const good = returned.filter((r) => acceptedIds.has(r.id)).length;
    toolGood += good;

    const isFalseEmpty = accepted.length > 0 && returned.length === 0;
    if (isFalseEmpty) {
      falseEmpty++;
    }

    const mark = isFalseEmpty
      ? "✗ 库里有却返回空"
      : relaxed
        ? "◔ 只给了放宽结果"
        : "✓";
    console.log(
      `[${qi + 1}/${queries.length}] ${mark} 认可${accepted.length} 返回${returned.length}(命中${good}) — ${query.slice(0, 40)}`
    );

    if (isFalseEmpty) {
      details.push(
        `### ✗ 库里有 ${accepted.length} 人却返回空\n**房东帖**: ${query.slice(0, 160)}\n` +
          accepted
            .slice(0, 4)
            .map((a) => `- 「${cleanText(a.rawText).slice(0, 90)}」`)
            .join("\n")
      );
    }
  }

  const n = queries.length;
  const precision = toolReturned > 0 ? (toolGood / toolReturned) * 100 : 0;
  const summary =
    `searchWanted 召回评测 ${new Date().toISOString().slice(0, 10)}：${n} 条查询\n` +
    `  falseEmpty  ${falseEmpty}/${n} 条「库里有却返回空」 ← 最痛的失败\n` +
    `  relaxedRate ${relaxedCount}/${n} 条只能给出放宽结果\n` +
    `  precision   ${precision.toFixed(1)}%（返回 ${toolReturned} 人，其中认可 ${toolGood}）\n` +
    `  判官认可合计 ${gtTotal} 人${judgeFailures > 0 ? `（判官失败 ${judgeFailures} 批）` : ""}`;
  console.log(`\n${summary}`);

  const dir = path.join("tests", "search-eval", "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `wanted-recall-${new Date().toISOString().slice(0, 10)}.md`
  );
  writeFileSync(
    file,
    `# ${summary}\n\n## 明细\n\n${details.join("\n\n") || "（无 falseEmpty）"}\n`,
    "utf8"
  );
  console.log(`报告: ${file}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
