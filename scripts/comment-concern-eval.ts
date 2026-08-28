/**
 * 评论"有没有正面回应租客关心的事" —— `pnpm comment-concern-eval`
 *
 * 跟另外两套的分工：
 * - `comment-reply-eval` 查成品的**形式**（角色、联系方式、字数、幂等）。
 * - `answer-coverage-eval` 查**真实语料**（XhsRentalWanted 全表）里 planQuery
 *   解出的每个维度有没有被交代，是门禁。
 * - 这一套补两件它们都不做的事：**用例是手写的**（不受库存分布影响，能把关心点
 *   铺开到库里暂时没有的组合），以及**区分"如实说没写"和"回避"**——前者合格，
 *   后者才是失败。数据缺失不是回复的错，回避才是。
 *
 * 起因：租客写"希望通勤方便，想长租"，回复给了三套房源却只报城市+房型+租金，
 * 通勤和租期一个字没提。**评论区字数金贵（上限 300），应该优先花在租客
 * 自己提出来的关心点上**，而不是千篇一律的三件套。
 *
 * 判定（每条帖子逐个关心点看，三种结局）：
 *   answered  用房源数据正面回答了（"步行8分钟到Caltrain"、"租期一年起"）
 *   declared  房源确实没写，**如实说明**（"租期未标"、"房东没写车位"）
 *   ignored   压根没提 ← 唯一算失败的
 *
 * `declared` 算通过是有意的：数据缺失不是回复的错，**回避才是**。租客看到
 * "租期未标"至少知道该去问什么；什么都不说就是让他自己猜。
 *
 * 用例是**手写的虚构求租帖**，不取自数据库：库里的帖子已经被前面几轮调过很多次，
 * 而且分布偏向已有数据；手写才能把关心点铺开（通勤/租期/宠物/车位数/独卫/
 * 包水电/家具/押金/性别/隔音…）并且每条都清楚知道"应该答什么"。
 *
 * 用法：
 *   pnpm comment-concern-eval               全部 20 条
 *   pnpm comment-concern-eval -- --limit 5  只跑前 5 条（改提示词时快速看）
 *   pnpm comment-concern-eval -- --only 7   只跑第 7 条（调单条用）
 */
import { config } from "dotenv";

config({ path: ".env.local" });
for (const k of ["XHS_API_TOKEN", "OPENAI_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]?.replace(/^"|"$/g, "");
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.XHS_EVAL_BASE ?? "https://willinglink.vercel.app";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const LIMIT = Number(argValue("limit") ?? 20);
const ONLY = argValue("only") ? Number(argValue("only")) : null;

type Case = {
  name: string;
  post: string;
  /** 租客自己提出来的关心点。回复必须逐条正面回应，或如实说没写。 */
  concerns: string[];
};

/** 20 条手写求租帖，关心点刻意铺开，覆盖真实帖子里最常见的诉求类型。 */
const CASES: Case[] = [
  {
    name: "通勤+租期",
    post: "求租｜Sunnyvale附近1b1b。我在Sunnyvale上班，希望通勤方便，开车15分钟以内最好。打算长租，至少住一年。预算2800以内，9月中入住。",
    concerns: ["通勤是否方便/距离", "租期能不能长租一年", "租金", "入住时间"],
  },
  {
    name: "带猫+押金",
    post: "求租San Jose主卧，我有一只很乖的猫，绝育过不掉毛。想知道能不能养宠物，押金大概多少。预算1800左右，10月初入住。",
    concerns: ["能不能养猫/宠物政策", "押金", "租金", "入住时间"],
  },
  {
    name: "两个车位+洗衣机",
    post: "Fremont求租2b2b，我们两个人两辆车，需要两个停车位。另外希望是in-unit laundry，不想去公共洗衣房。预算3500，11月入住。",
    concerns: ["停车位数量（要两个）", "有没有室内洗衣机", "租金", "入住时间"],
  },
  {
    name: "精确短租窗口",
    post: "求Mountain View短租，时间很确定：10月5日到12月20日，不能早也不能晚。studio或1b1b都行，预算3000。",
    concerns: ["能否覆盖10/5-12/20整段", "房型", "租金"],
  },
  {
    name: "独卫+女生室友",
    post: "本人女生，求租Santa Clara合租房间，一定要独立卫浴，希望室友也是女生。预算1600，9月底入住。",
    concerns: ["有没有独立卫浴", "室友性别/是否限女生", "租金", "入住时间"],
  },
  {
    name: "包水电+做饭",
    post: "求租Milpitas单间，希望房租包水电网，我平时会自己做饭，需要能正常用厨房，不要限制炒菜。预算1500。",
    concerns: ["是否包水电网", "厨房能否正常做饭/是否限制", "租金"],
  },
  {
    name: "拎包入住",
    post: "刚落地湾区，求租Palo Alto studio，行李很少，希望带家具能直接拎包入住，床和桌子最好都有。预算3200，尽快入住。",
    concerns: ["是否带家具/能否拎包入住", "租金", "入住时间"],
  },
  {
    name: "预算硬上限+学区",
    post: "求租Cupertino 2b，预算最多2600，超一分都不行。家里有小孩，希望在好学区。长租。",
    concerns: ["租金是否在2600以内", "学区情况", "租期"],
  },
  {
    name: "情侣入住",
    post: "求租Redwood City 1b1b，我和男朋友两个人住，想确认房东接不接受情侣。预算3000，长租一年以上。",
    concerns: ["是否接受情侣/两人入住", "租金", "租期"],
  },
  {
    name: "公司班车",
    post: "在Meta上班，求租Menlo Park附近的房子，最好能走到公司班车站或者开车10分钟内到公司。1b1b，预算3800，10月入住。",
    concerns: ["到公司/班车的距离", "房型", "租金", "入住时间"],
  },
  {
    name: "安静隔音",
    post: "求租Sunnyvale单间，我在家远程办公，对安静要求很高，希望隔音好、室友作息正常。预算1700，随时可入住。",
    concerns: ["是否安静/隔音", "室友作息情况", "租金"],
  },
  {
    name: "养狗+院子",
    post: "求租东湾整租house或townhouse，有一只中型犬，需要能养狗，最好有院子让它跑。预算4000，12月入住，长租。",
    concerns: ["能否养狗", "有没有院子", "租金", "租期"],
  },
  {
    name: "接手lease",
    post: "求Santa Clara转租/接lease，希望直接接手现有租约，不想重新走申请流程。1b1b，预算2900，9月接手。",
    concerns: ["是否转租/可接手lease", "房型", "租金", "接手时间"],
  },
  {
    name: "无烟+作息",
    post: "求租San Jose主卧，本人不抽烟也受不了烟味，希望房子里没人抽烟，室友作息正常不开party。预算1900，10月入住。",
    concerns: ["是否无烟", "室友作息/是否开party", "租金", "入住时间"],
  },
  {
    name: "小区设施",
    post: "求租Santa Clara 1b1b公寓，希望小区有健身房和泳池，最好有地下车库。预算3400，长租。",
    concerns: ["有没有健身房/泳池", "车位/车库", "租金", "租期"],
  },
  {
    name: "步行到Caltrain",
    post: "没有车，求租San Mateo附近，必须能走路到Caltrain站，走路10分钟以内。studio或单间都行，预算2200，9月入住。",
    concerns: ["到Caltrain的步行距离", "租金", "入住时间"],
  },
  {
    name: "押一付一",
    post: "求租Fremont单间，预算1400，希望押一付一，押金不要太高，租金可以小谈。9月中入住，长租。",
    concerns: ["押金/押一付一", "租金是否可议", "入住时间", "租期"],
  },
  {
    name: "入住灵活但要住满一年",
    post: "求租Dublin 1b1b，入住时间比较灵活，11月到明年1月都可以，但一定要能住满一年。预算2700。",
    concerns: ["能否住满一年", "入住时间是否覆盖11月-1月", "租金"],
  },
  {
    name: "独立入口ADU",
    post: "求租南湾ADU或者带独立入口的房间，不想和房东共用大门，注重隐私。预算2000，10月入住，长租。",
    concerns: ["是否独立入口/ADU", "是否与房东同住", "租金", "入住时间"],
  },
  {
    name: "多条件叠加",
    post: "求租Sunnyvale 1b1b：预算3000以内，要车位，要in-unit laundry，9月底入住，能长租一年，最好步行能到超市。",
    concerns: [
      "租金是否3000以内",
      "车位",
      "室内洗衣机",
      "入住时间",
      "能否长租一年",
      "步行到超市",
    ],
  },
];

type Grade = {
  concern: string;
  verdict: "answered" | "declared" | "ignored";
  evidence: string;
};

async function grade(
  post: string,
  concerns: string[],
  reply: string
): Promise<Grade[]> {
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
            "你检查一条小红书评论回复，有没有正面回应租客提出的每一个关心点。\n" +
            "对每个关心点判一个结论：\n" +
            '- "answered"：回复里用房源信息正面回答了（如"步行8分钟到Caltrain"、"租期一年起"、"可养猫"）。\n' +
            '- "declared"：回复明说这项信息房源没写/未标明（如"租期未标"、"房东没写押金"）。这也算合格。\n' +
            '- "ignored"：回复通篇没提这件事，租客看完还是不知道 ← 不合格。\n' +
            "注意：只要回复里**任意一条房源**回应了该关心点，就算 answered。\n" +
            "笼统的形容词（'交通便利'、'生活方便'）**不算**回答了具体的通勤距离；\n" +
            "'安静'可以算回应了对安静的关心。\n" +
            '只输出 JSON：{"results":[{"concern":"原样抄回关心点","verdict":"answered|declared|ignored","evidence":"回复里的哪句话，或写无"}]}',
        },
        {
          role: "user",
          content: `【租客原帖】\n${post}\n\n【关心点】\n${concerns.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n【评论回复】\n${reply}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    return concerns.map((c) => ({
      concern: c,
      verdict: "ignored" as const,
      evidence: `judge failed ${res.status}`,
    }));
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  const out: Grade[] = concerns.map((c) => ({
    concern: c,
    verdict: "ignored",
    evidence: "",
  }));
  for (const r of parsed.results ?? []) {
    const i = concerns.indexOf(r.concern);
    const slot = i >= 0 ? i : out.findIndex((o) => o.evidence === "");
    if (slot >= 0) {
      out[slot] = {
        concern: concerns[slot],
        verdict: r.verdict,
        evidence: String(r.evidence ?? "").slice(0, 80),
      };
    }
  }
  return out;
}

async function main() {
  const picked = ONLY
    ? [CASES[ONLY - 1]].filter(Boolean)
    : CASES.slice(0, LIMIT);
  console.log(`评论关心点评测：${picked.length} 条手写求租帖\n`);

  let answered = 0;
  let declared = 0;
  let ignored = 0;
  let noMatchCases = 0;
  let apiFailures = 0;
  const details: string[] = [];

  for (const [i, c] of picked.entries()) {
    const res = await fetch(`${BASE}/api/xhs/comment-reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Xhs-Token": process.env.XHS_API_TOKEN as string,
      },
      body: JSON.stringify({ rawText: c.post, force: true }),
    });
    // 路由偶发返回非 JSON 的错误页（网关 5xx、超时），直接 res.json() 会抛
    // SyntaxError 把整轮评测炸掉——实测第 19 条崩过一次，前 18 条的结果全白跑。
    // 评测本身绝不能因为一次抖动前功尽弃。
    const raw = await res.text();
    let json: {
      ok?: boolean;
      text?: string;
      chars?: number;
      postKind?: string;
      skipped?: boolean;
    } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      console.log(
        `[${i + 1}/${picked.length}] ⚠ 路由返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 60)} — ${c.name}`
      );
      apiFailures++;
      continue;
    }
    const reply = json.text ?? "";
    if (!json.ok || json.skipped || !reply) {
      console.log(
        `[${i + 1}/${picked.length}] ⚠ 无回复（kind=${json.postKind} skipped=${json.skipped}） — ${c.name}`
      );
      ignored += c.concerns.length;
      continue;
    }

    // 库里确实没有可推的房源时，回复就是那句固定的"我手里没有完全符合的"。
    // **这是诚实作答，不是回避**：一条房源都没展示，当然无从交代租金/入住时间。
    // 按关心点逐条记"回避"会把这种正确行为打成失败（实测一条就贡献 3 个假失败），
    // 于是无从分辨"该答没答"和"根本没东西可答"。单列一类。
    if (!reply.includes("【第")) {
      noMatchCases++;
      console.log(
        `[${i + 1}/${picked.length}] ◌ 无匹配（诚实说没有，不计入关心点） — ${c.name}`
      );
      continue;
    }

    const grades = await grade(c.post, c.concerns, reply);
    const a = grades.filter((g) => g.verdict === "answered").length;
    const d = grades.filter((g) => g.verdict === "declared").length;
    const g0 = grades.filter((g) => g.verdict === "ignored").length;
    answered += a;
    declared += d;
    ignored += g0;

    const mark = g0 === 0 ? "✓" : "✗";
    console.log(
      `[${i + 1}/${picked.length}] ${mark} 答${a} 明说未写${d} 回避${g0} (${json.chars}字) — ${c.name}`
    );
    for (const g of grades.filter((x) => x.verdict === "ignored")) {
      console.log(`      回避: ${g.concern}`);
    }
    if (g0 > 0) {
      details.push(
        `### ${c.name}（回避 ${g0} 项）\n**帖子**: ${c.post}\n**回复**: ${reply}\n` +
          grades
            .map((g) => `- [${g.verdict}] ${g.concern} — ${g.evidence || "无"}`)
            .join("\n")
      );
    }
  }

  const total = answered + declared + ignored;
  const okRate = total > 0 ? ((answered + declared) / total) * 100 : 0;
  const summary =
    `评论关心点评测 ${new Date().toISOString().slice(0, 10)}：${picked.length} 条帖子，${total} 个关心点\n` +
    `  正面回答 ${answered}  明说未写 ${declared}  **回避 ${ignored}**\n` +
    `  合格率 ${okRate.toFixed(1)}%（回答+明说未写，回避才算失败）\n` +
    `  另有 ${noMatchCases} 条库里无匹配、如实说了"没有"（不计入关心点）` +
    (apiFailures > 0
      ? `
  ⚠ ${apiFailures} 条因路由报错跳过`
      : "");
  console.log(`\n${summary}`);

  const dir = path.join("tests", "search-eval", "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `comment-concern-${new Date().toISOString().slice(0, 10)}.md`
  );
  writeFileSync(
    file,
    `# ${summary}\n\n## 回避明细\n\n${details.join("\n\n") || "（无）"}\n`,
    "utf8"
  );
  console.log(`报告: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
