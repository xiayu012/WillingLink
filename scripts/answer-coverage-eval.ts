/**
 * 回答覆盖率门禁：`pnpm answer-coverage-eval`
 *
 * 盯的是一件很具体的事——**租客说出口的条件，回答里有没有交代**。
 *
 * 起因（2026-08-26）：租客写了"8月底"入住，回复里从头到尾没有一个日期。房源本身
 * 可能确实合适，但读的人无法确认，只能再问一轮；在小红书私信里，"再问一轮"经常
 * 就是流失。这类问题 `search-eval` 抓不到——它判的是**检索**对不对，不判**回答**
 * 有没有把话说清楚。
 *
 * ground truth 不另写一套正则，直接用 `planQuery`：它是运行时理解查询的同一个
 * 入口（CLAUDE.md 要求的"唯一入口"），它认为租客说了什么，就是租客说了什么。
 * 门禁只做一件事：**plan 里非空的每一个维度，在回答里找对应的交代**。
 *
 * 语料是 `XhsRentalWanted` 全表原文——真实租客的话，不是我编的。
 *
 * 判"交代了"一律**放宽**：只要回答里出现了这个话题就算过。要抓的是"整个话题
 * 在回答里根本不存在"，不是措辞好不好。宁可放过不可误报——上一轮就是因为价格
 * 正则写窄了，制造 5 个假失败，把诊断带偏了整整一轮。
 *
 * 用法：
 *   pnpm answer-coverage-eval                 # 全表
 *   pnpm answer-coverage-eval -- --limit 40   # 迭代时先跑一小批
 *   pnpm answer-coverage-eval -- --show 8     # 多打几条失败样例出来读
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
    process.env[k] = process.env[k]?.slice(1, -1);
  }
}
process.env.SEARCH_DETERMINISTIC = "1";

import postgres from "postgres";
import type { CityEntry } from "@/lib/rental/cities";
import type { QueryPlan } from "@/lib/rental/query-plan";

/**
 * 应用模块**必须在 dotenv 之后动态导入**。
 *
 * ESM 的 `import` 会被提升到文件顶部执行，早于上面那句 `config({path})`。
 * `lib/db/queries.ts` 在模块作用域就建了 postgres 客户端，于是它读到的
 * POSTGRES_URL 是空的，全部退化成 localhost:5432 —— 表现是每条 case 都抛
 * `AggregateError: connect ECONNREFUSED 127.0.0.1:5432`，而且 AggregateError
 * 的 message 是空的，光看 name+message 完全看不出发生了什么。
 */
type App = {
  handleInboundMessage: typeof import("@/lib/chat/adapter").handleInboundMessage;
  XHS_DM_EXTRA_SYSTEM: string;
  XHS_DM_MODEL: string;
  cityAliases: (e: CityEntry) => string[];
  detectCity: (t: string) => CityEntry | null;
  planQuery: typeof import("@/lib/rental/query-plan").planQuery;
};
let app: App;

async function loadApp(): Promise<App> {
  const [adapter, dm, cities, plan] = await Promise.all([
    import("@/lib/chat/adapter"),
    import("@/lib/chat/xhs-dm"),
    import("@/lib/rental/cities"),
    import("@/lib/rental/query-plan"),
  ]);
  return {
    handleInboundMessage: adapter.handleInboundMessage,
    XHS_DM_EXTRA_SYSTEM: dm.XHS_DM_EXTRA_SYSTEM,
    XHS_DM_MODEL: dm.XHS_DM_MODEL,
    cityAliases: cities.cityAliases,
    detectCity: cities.detectCity,
    planQuery: plan.planQuery,
  };
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const LIMIT = Number(argValue("limit") ?? 0); // 0 = 全表
const SHOW = Number(argValue("show") ?? 3);
const CONCURRENCY = Number(argValue("concurrency") ?? 4);

const HASHTAG_RE = /#[^\s#]+/g;
const CONTACT_RE = /(微信|weixin|wechat|vx|v信|电话|手机|qq)\s*[:：]?\s*\S+/gi;

function cleanWantedText(raw: string): string {
  return raw
    .replace(HASHTAG_RE, " ")
    .replace(CONTACT_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

type Dimension = {
  key: string;
  label: string;
  /** plan 里算不算"租客说了这一项" */
  stated: (p: QueryPlan) => boolean;
  /** 回答里算不算"交代了这一项" */
  covered: (answer: string, p: QueryPlan) => boolean;
};

/**
 * 算“交代了入住时间”的写法。
 *
 * 要求**不是精确到某一天**——房东原帖怎么写的、转述出来就行：“随时入住”、
 * “8月底”、“9/1起租”、“即刻可入住”都算数；原帖真没写就明说“入住时间未标”。
 * 租客既然提了时间，回答里就不能对这件事只字不提。
 *
 * 但**不能认裸的「入住」两个字**：几乎每条租房回复都会出现“适合…入住”、
 * “拎包入住”，拿它当判据的话，一个时间词都没有的回答也能拿满分——第一版就是
 * 这么得出“入住时间 16/16 (100%)”这个假结论的。
 */
const DATE_RE =
  /\d{1,2}\s*[月/-]\s*\d{1,2}|\d{1,2}\s*月(?:初|中|下旬|上旬|底|末|份)?|\d{4}\s*年|随时|即可|即刻|立即|马上|现在可|起租|空出|可入住|可住|入住时间|入住日期|未标|未写|待确认|now|a\.?s\.?a\.?p\.?|immediate|move[\s-]?in|available/i;

/** 真正算"说了钱"的写法。裸的「租金」两个字不算——那是标签不是价格。 */
const MONEY_RE =
  /\$\s*\d|\d{3,5}\s*(?:刀|美元|块|\/月|每月)|(?:租金|房租|月租|预算|要价)\s*[:：约]?\s*\d|面议|未标|未写|价格未定/;

const DIMENSIONS: Dimension[] = [
  {
    key: "moveIn",
    label: "入住时间",
    stated: (p) => p.moveIn.kind !== "unknown",
    covered: (a) => DATE_RE.test(simplify(a)),
  },
  {
    key: "rent",
    label: "租金",
    stated: (p) => p.rentMin !== null || p.rentMax !== null,
    covered: (a) => MONEY_RE.test(simplify(a)),
  },
  {
    key: "city",
    label: "城市",
    stated: (p) => p.cities.length > 0,
    covered: (a, p) => {
      const lower = simplify(a).toLowerCase();
      return p.cities.some((c) => {
        if (lower.includes(c.toLowerCase())) {
          return true;
        }
        // plan 里存的是 canonical 英文名；回答常写中文（"山景城"），
        // 所以要连别名一起找
        const entry = app.detectCity(c);
        return entry
          ? app.cityAliases(entry).some((alias) =>
              lower.includes(alias.toLowerCase())
            )
          : false;
      });
    },
  },
  {
    key: "bedrooms",
    label: "户型",
    stated: (p) => p.bedroomsAnyOf.length > 0,
    covered: (a) =>
      /\d\s*(?:室|房|b\b|bd|bedroom)|studio|开间|主卧|次卧|单间|房间|雅房|套间|一居|两居|整租|合租/i.test(
        simplify(a)
      ),
  },
  {
    key: "lease",
    label: "租期",
    stated: (p) => p.leaseMonthsMin !== null || p.leaseMonthsMax !== null,
    covered: (a) =>
      /租期|短租|长租|\d+\s*个?月|\d+\s*months?|month[\s-]?to[\s-]?month|长期|半年|一年/i.test(
        simplify(a)
      ),
  },
  {
    key: "parking",
    label: "车位",
    stated: (p) => p.requires.parkingIncluded === true,
    covered: (a) => /车位|停车|车库|parking|garage/i.test(simplify(a)),
  },
  {
    key: "pets",
    label: "宠物",
    stated: (p) => p.requires.petFriendly === true,
    covered: (a) => /宠物|猫|狗|pet/i.test(simplify(a)),
  },
  {
    key: "utilities",
    label: "水电",
    stated: (p) => p.requires.utilitiesIncluded === true,
    covered: (a) => /水电|utilit|包水|全包|水费|电费/i.test(simplify(a)),
  },
  {
    key: "couples",
    label: "情侣",
    stated: (p) => p.requires.couplesOk === true,
    covered: (a) => /情侣|夫妻|couple|两人/i.test(simplify(a)),
  },
];

const BULLET_RE = /^[ \t]*(?:[-•]|\*(?!\*))/;

/**
 * 繁→简，只覆盖判据里用到的那几个字。
 *
 * 帖主常用繁体，回答就跟着繁体。实测：回答写的是"都有停車位"，而判据里写的是
 * "停车"，于是被判成"漏了车位"——又一个假失败。不引完整的繁简转换库：门禁只需要
 * 认得出话题，这几个字够了。
 */
const TRAD_TO_SIMP: Record<string, string> = {
  車: "车",
  間: "间",
  費: "费",
  電: "电",
  寵: "宠",
  樓: "楼",
  規: "规",
  約: "约",
  標: "标",
  寫: "写",
  單: "单",
  門: "门",
  區: "区",
  長: "长",
  點: "点",
  經: "经",
  離: "离",
  邊: "边",
  飯: "饭",
  養: "养",
  獨: "独",
  衛: "卫",
  機: "机",
  設: "设",
  備: "备",
  廚: "厨",
  預: "预",
  價: "价",
  錢: "钱",
  時: "时",
  訂: "订",
  種: "种",
  鐘: "钟",
};

/** 把回答归一化成简体再匹配，免得繁体回答整片误报 */
function simplify(text: string): string {
  return text.replace(/[一-鿿]/g, (c) => TRAD_TO_SIMP[c] ?? c);
}

/**
 * 把回答切成一条条房源块：标题行 + 它下面所有短横线信息点。
 *
 * 开头的引导语和结尾的总结句不属于任何房源，自然被排除在外——**这正是重点**：
 * "整条回答里出现过一次日期"和"每条房源都写了什么时候能住"是两回事，用户抱怨的
 * 是后者，而整条回答级的判据会把前者算成通过。
 */
function listingBlocks(answer: string): string[] {
  const lines = answer.split("\n");
  const blocks: string[] = [];
  for (const [i, line] of lines.entries()) {
    const isTitle =
      line.trim().length > 0 &&
      !BULLET_RE.test(line) &&
      BULLET_RE.test(lines[i + 1] ?? "") &&
      // 房源标题**必须带「原帖」链接**——这是唯一高精度的信号。
      //
      // 只看"非要点行 + 下一行是要点"会把各种引导语算成房源，加粗也不够（模型
      // 到处加粗）。实测误判过三种，全都是引擎**做对了事**却被记成失败：
      //  1. "收到！看到您这边有房源：" + 要点（帖主是房东，引擎在反问缺什么）
      //  2. 反问清单 `1. **"中区"** 具体指哪个城市？` + 缩进选项
      //  3. `**如果您在湾区找房**，麻烦告诉我：` + 要点（引擎正确判断需求在
      //     新西兰/伦敦，如实说不在覆盖范围）
      // 这三种都不该按"每条房源要写租金"考核——它们压根不是房源。
      line.includes("原帖");
    if (!isTitle) {
      continue;
    }
    const body: string[] = [line];
    for (let j = i + 1; j < lines.length; j++) {
      if (BULLET_RE.test(lines[j]) || lines[j].trim().length === 0) {
        body.push(lines[j]);
      } else {
        break;
      }
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** 回答里有没有真的展示房源 */
function showsListings(answer: string): boolean {
  return listingBlocks(answer).length > 0;
}

/**
 * 逐条房源都必须交代的两件事：**什么时候能住进去**、**多少钱**。
 * 少任何一条，读的人都没法决定要不要约看房，只能再问一轮。
 */
const PER_LISTING = [
  { label: "入住时间", re: DATE_RE },
  { label: "租金", re: MONEY_RE },
];

function perListingMisses(
  answer: string
): { label: string; n: number; of: number }[] {
  const blocks = listingBlocks(answer);
  return PER_LISTING.map((d) => ({
    label: d.label,
    n: blocks.filter((b) => !d.re.test(simplify(b))).length,
    of: blocks.length,
  })).filter((x) => x.n > 0);
}

type Row = {
  query: string;
  plan: QueryPlan;
  answer: string;
  listings: boolean;
  missing: Dimension[];
  /** 逐条房源缺的东西，跟整条回答级的 missing 分开看 */
  perListing: { label: string; n: number; of: number }[];
  error?: string;
};

async function runOne(query: string, index: number): Promise<Row | null> {
  const plan = await app.planQuery(query);
  if (plan.outOfScope) {
    return null; // 湾区外，回答"没收录"才是对的，不该按维度考核
  }
  try {
    const result = await app.handleInboundMessage({
      channel: "xhs",
      // 每条一个独立身份：共用会话会把上一条的房源和上下文带进来
      externalUserId: `cov-${index}-${Date.now().toString(36)}`,
      text: query,
      extraSystem: app.XHS_DM_EXTRA_SYSTEM,
      selectedChatModel: app.XHS_DM_MODEL,
    });
    const answer = result.text ?? "";
    const listings = showsListings(answer);
    return {
      query,
      plan,
      answer,
      listings,
      // 没搜到房源时不按维度考核——那时该说的是"没有符合的"，不是逐条交代
      missing: listings
        ? DIMENSIONS.filter((d) => d.stated(plan) && !d.covered(answer, plan))
        : [],
      perListing: listings ? perListingMisses(answer) : [],
    };
  } catch (error) {
    // AggregateError 的 message 是空的，真正的原因在 .errors[] 里——
    // 直接打 name+message 会得到 "AggregateError: "，等于没说
    const e = error as Error & { errors?: unknown[]; cause?: unknown };
    const inner = Array.isArray(e.errors)
      ? e.errors.map((x) => (x as Error)?.message ?? String(x)).join(" | ")
      : ((e.cause as Error)?.message ?? "");
    return {
      query,
      plan,
      answer: "",
      listings: false,
      missing: [],
      perListing: [],
      error: `${e.name}: ${e.message || inner}`.slice(0, 220),
    };
  }
}

async function main() {
  app = await loadApp();
  const db = postgres(process.env.POSTGRES_URL ?? "");
  const rows = await db`
    SELECT "rawText" FROM "XhsRentalWanted"
    WHERE LENGTH(TRIM("rawText")) >= 15
    ORDER BY "createdAt" DESC
  `;
  await db.end();

  const queries = rows
    .map((r) => cleanWantedText(r.rawText as string))
    .filter((q) => q.length >= 12);
  const cases = LIMIT > 0 ? queries.slice(0, LIMIT) : queries;

  console.log(`语料：XhsRentalWanted ${cases.length} 条原文\n`);

  const results: Row[] = [];
  let done = 0;
  const queue = [...cases.entries()];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      const [i, q] = next;
      const row = await runOne(q, i);
      done++;
      if (row) {
        results.push(row);
        let tag = "✅";
        if (row.error) {
          tag = "💥";
        } else if (row.missing.length > 0 || row.perListing.length > 0) {
          const whole = row.missing.map((d) => d.label);
          const per = row.perListing.map((x) => `${x.label}${x.n}/${x.of}条`);
          tag = `❌ 漏:${[...whole, ...per].join("/")}`;
        } else if (!row.listings) {
          tag = "○ 无结果";
        }
        console.log(`[${done}/${cases.length}] ${tag}  ${q.slice(0, 42)}`);
      } else {
        console.log(`[${done}/${cases.length}] ⊘ 湾区外  ${q.slice(0, 38)}`);
      }
    }
  });
  await Promise.all(workers);

  const withListings = results.filter((r) => r.listings);
  const errors = results.filter((r) => r.error);
  const noResult = results.filter((r) => !(r.listings || r.error));
  const bad = withListings.filter(
    (r) => r.missing.length > 0 || r.perListing.length > 0
  );

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `跑了 ${results.length} 条：出房源 ${withListings.length} · 无结果 ${noResult.length} · 报错 ${errors.length}`
  );
  console.log(
    `覆盖率：${withListings.length - bad.length}/${withListings.length} 条把说过的条件全交代了`
  );

  // 逐条房源的两项硬指标。这才是用户实际在读的东西——整条回答里出现过一次日期
  // 不算数，他看的是**这一套什么时候能住、多少钱**。
  console.log("\n逐条房源（分母 = 所有出现过的房源条目）：");
  for (const d of PER_LISTING) {
    const total = withListings.reduce(
      (n, r) => n + listingBlocks(r.answer).length,
      0
    );
    const missed = withListings.reduce(
      (n, r) => n + (r.perListing.find((x) => x.label === d.label)?.n ?? 0),
      0
    );
    if (total === 0) {
      continue;
    }
    const rate = missed / total;
    let bar = "✅";
    if (rate > 0.2) {
      bar = "❌";
    } else if (rate > 0) {
      bar = "⚠️ ";
    }
    console.log(
      `  ${bar} ${d.label.padEnd(5, "　")} ${String(total - missed).padStart(4)}/${String(total).padEnd(4)} (${((1 - rate) * 100).toFixed(0)}%)`
    );
  }

  console.log("\n按维度（分母 = 租客说了这一项、且出了房源的条数）：");
  for (const d of DIMENSIONS) {
    const stated = withListings.filter((r) => d.stated(r.plan));
    if (stated.length === 0) {
      continue;
    }
    const missed = stated.filter((r) => r.missing.includes(d));
    const rate = missed.length / stated.length;
    let bar = "✅";
    if (rate > 0.2) {
      bar = "❌";
    } else if (rate > 0) {
      bar = "⚠️ ";
    }
    console.log(
      `  ${bar} ${d.label.padEnd(5, "　")} ${String(stated.length - missed.length).padStart(3)}/${String(stated.length).padEnd(3)} (${((1 - rate) * 100).toFixed(0)}%)`
    );
  }

  if (bad.length > 0) {
    console.log("\n失败样例：");
    for (const r of bad.slice(0, SHOW)) {
      const whole = r.missing.map((d) => d.label);
      const per = r.perListing.map((x) => `${x.label}(${x.n}/${x.of}条没写)`);
      console.log(`\n  ── 漏了：${[...whole, ...per].join("、")}`);
      // 把 plan 一起打出来。城市这类判定失败时，光看回答猜不出是"引擎答错了"
      // 还是"plan 里的城市跟我以为的不一样"——上一轮就在这上面空转过。
      const p = r.plan;
      console.log(
        `  plan：城市=[${p.cities.join(",")}] 预算=${p.rentMin ?? ""}-${p.rentMax ?? ""} 户型=[${p.bedroomsAnyOf.join(",")}] 入住=${JSON.stringify(p.moveIn)}`
      );
      console.log(`  租客：${r.query.slice(0, 130)}`);
      console.log(`  回答：${r.answer.replace(/\n+/g, " ⏎ ").slice(0, 300)}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n报错 ${errors.length} 条，样例：${errors[0].error}`);
  }

  process.exit(bad.length > 0 ? 1 : 0);
}

main();
