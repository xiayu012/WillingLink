/**
 * comment-reply 端到端评测：`pnpm comment-reply-eval`
 *
 * **调的是真实路由** `app/api/xhs/comment-reply/route.ts` 的 POST，不是绕过它去
 * 直接调 chat engine。整条链路都在里面：六分类闸门 → 排除自帖 → 单帖作用域起草
 * → 纯变换压缩 → 拼开场白 → 写库。任何一环坏了这里都能看见。
 *
 * 判据来自积累下来的产品要求，每条都能自动查：
 *   - 该评论的帖子必须真出内容，不该评论的必须跳过
 *   - 身份判对（求租帖→给房源，招租/找室友帖→给人）
 *   - **不许复述帖主自己的帖**（最常见的翻车：一个工具都不调，把原文总结一遍）
 *   - 小红书私信/评论风控：不许有 URL、不许有联系方式
 *   - 长度：评论要短（压缩后 260 上下，硬上限 400）
 *   - 不许出现聊天页话术（"如需调整条件…我再重新筛选"）
 *
 * 用法：
 *   pnpm comment-reply-eval              全部用例
 *   pnpm comment-reply-eval -- --limit 5 只跑前 5 条
 *   pnpm comment-reply-eval -- --only 12 只跑第 12 条（调试用）
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) {
    process.env[m[1]] ??= m[2].replace(/^"|"$/g, "");
  }
}

type Expect = "comment" | "skip";

type Case = {
  name: string;
  /** 帖主视角的正文 */
  post: string;
  expect: Expect;
  /** 期望的身份（只在 expect=comment 时检查） */
  kind?: "seeker" | "lister" | "roommate";
};

const CASES: Case[] = [
  // ───────────── 求租（seeker）：正常、边界、易误判 ─────────────
  {
    name: "标准求租-南湾studio",
    kind: "seeker",
    expect: "comment",
    post: `湾区mountain view求租
位置：mountain view或者附近通勤30分钟内都可
时间：9月初开始，3-4个月
预算：2500/月以内
需求：studio或者独立卫浴合租都可，需要有车位
关于我：女生，不养宠物，来实习，生活稳定规律`,
  },
  {
    name: "求租-只给城市没预算",
    kind: "seeker",
    expect: "comment",
    post: "求租！人在Fremont上班，想找Fremont附近的房子，越快入住越好，一个人住，干净安静就行。",
  },
  {
    name: "求租-预算区间",
    kind: "seeker",
    expect: "comment",
    post: "求租 Sunnyvale 或 Santa Clara 一室一厅，预算 2000-2600，10月初入住，长租一年，无宠物无烟。",
  },
  {
    name: "求租-女生限女生房源",
    kind: "seeker",
    expect: "comment",
    post: "女生求租San Jose主卧，希望房东和室友都是女生，预算1500以内，9月中入住，能长租最好。",
  },
  {
    name: "求租-带宠物",
    kind: "seeker",
    expect: "comment",
    post: "求租：我和我的猫想找Berkeley附近可养宠物的1b1b，预算2800以内，11月入住。",
  },
  {
    name: "求租-短租两个月",
    kind: "seeker",
    expect: "comment",
    post: "实习生求短租，Palo Alto附近，6月中到8月中，两个月，预算2000，带家具最好，有洗衣机。",
  },
  {
    name: "求租-地标锚点近Apple",
    kind: "seeker",
    expect: "comment",
    post: "求租，工作在Apple Park，希望走路或骑车能到，预算2200以内，独立卫浴优先，9月入住。",
  },
  {
    name: "求租-地铁通勤",
    kind: "seeker",
    expect: "comment",
    post: "求租旧金山，能走到BART站的房子，预算2500，一个人住，studio或1b1b都行，尽快入住。",
  },
  {
    name: "求租-多城备选",
    kind: "seeker",
    expect: "comment",
    post: "求租 Dublin 优先，San Ramon 或 Pleasanton 也可以，工作地点94583，没车所以要能公交通勤，预算1400以内合租，9月入住长租。",
  },
  {
    name: "求租-英文",
    kind: "seeker",
    expect: "comment",
    post: "Looking for a studio or 1b1b in San Mateo, budget under $2800/month, move in early October, long term lease, no pets, quiet neighborhood preferred.",
  },
  {
    name: "求租-极短一句话",
    kind: "seeker",
    expect: "comment",
    post: "有没有San Jose便宜的房子求推荐，预算1200左右",
  },
  {
    name: "求租-预算很低",
    kind: "seeker",
    expect: "comment",
    post: "学生求租，预算800以内，南湾哪里都行，能睡就可以，9月开学前入住。",
  },
  {
    name: "求租-预算很高",
    kind: "seeker",
    expect: "comment",
    post: "求租Palo Alto或Los Altos整套3b2b，预算8000以内，一家四口，要好学区，明年1月入住长租。",
  },
  {
    name: "求租-湾区外应拒",
    kind: "seeker",
    expect: "comment",
    post: "求租西雅图市中心一室一厅，预算2000，下个月入住。",
  },
  {
    name: "求租-带很多偏好",
    kind: "seeker",
    expect: "comment",
    post: `求租 Sunnyvale
预算：2400以内
时间：9/1
最好有：in-unit laundry、独立卫浴、车位、健身房
本人：男，工程师，作息规律，不抽烟不party，爱干净`,
  },

  // ───────────── 招租（lister） ─────────────
  {
    name: "招租-主卧带独卫",
    kind: "lister",
    expect: "comment",
    post: `✅出租-SUNNYVALE 獨立出入，独立衛浴主臥，走路1分鐘到Apple班車站
屋況：全新衛浴，實木地板，朝南明亮，帶傢具，有車位，不與房東同住，即可入住
租客：適合單身/國際學生，无过夜客，不吸烟
#Sunnyvale租房 #南湾主卧`,
  },
  {
    name: "招租-广告口吻第二人称",
    kind: "lister",
    expect: "comment",
    post: `【UCB西南侧｜$1995住独立Studio】
想在伯克利找一套预算友好、离学校近、还不用和室友合租的房子？
2122 Dwight 这套Studio可以重点看看！
步行约9分钟到学校，厨房生活空间自己使用。
原价$1995/月，12个月租期免1个月房租，折算约$1829。现房可入住。`,
  },
  {
    name: "招租-整租独栋",
    kind: "lister",
    expect: "comment",
    post: "南湾West San Jose 4b3b独立屋整租，2016年新建，近1600尺，不提供家具，7月底起租，交通方便近280和880。",
  },
  {
    name: "招租-多间房",
    kind: "lister",
    expect: "comment",
    post: "8/24和8/27各起租1间侧卧，95008和95117各一间，都只和一位室友share卫生间，租到明年5/15，1250和1350美元/月。无中介费，直接和屋主签，没有找室友压力。",
  },
  {
    name: "招租-转租",
    kind: "lister",
    expect: "comment",
    post: "转租Sunnyvale豪华公寓studio，9月20起转到明年7月底，环境安静，小区设施完善，$3296/月，有停车位。",
  },
  {
    name: "招租-英文",
    kind: "lister",
    expect: "comment",
    post: "Room for rent in Fremont, private bathroom, furnished, $1400/month including utilities, available Sept 1, prefer quiet non-smoking tenant, parking available.",
  },

  // ───────────── 找室友（roommate） ─────────────
  {
    name: "找室友-已定房",
    kind: "roommate",
    expect: "comment",
    post: "NEU硅谷校区硕士新生，真诚找一位合拍女生室友，已看好North SJSU的2B2B公寓，人均2k+，9月初入住，作息规律无宠物爱干净。",
  },
  {
    name: "找室友-要一起找房",
    kind: "roommate",
    expect: "comment",
    post: "想在Santa Clara找个室友一起租2b1b，SCU附近，9月入住长租，房租两人分，本人女生学生不抽烟。",
  },
  {
    name: "找室友-次卧分摊",
    kind: "roommate",
    expect: "comment",
    post: "Elan at River Oaks次卧招室友，最早8.25最晚9.8入住，长租一年，家里有一只兔子，希望东西少好相处的。",
  },

  // ───────────── 不该评论的（skip） ─────────────
  {
    name: "跳过-看房体验",
    expect: "skip",
    post: `之前发了一篇求助帖，问大家在Redwood City上班住哪里比较好，收到很多建议。这周终于实地看了一圈来更新一下。
Huxley：前台服务好，健身房一般。
Indigo：房间新，价格偏高。
Trestle：性价比不错，位置略偏。`,
  },
  {
    name: "跳过-踩坑避雷",
    expect: "skip",
    post: "租房踩坑总结！签约前一定要看清楚这几条，避雷不良中介，我的血泪教训分享给大家，希望大家别再被坑。",
  },
  {
    name: "跳过-科普攻略",
    expect: "skip",
    post: "湾区租房攻略｜新手必看：怎么看lease条款、押金能退多少、什么时候是淡季、怎么砍价，一篇讲清楚。",
  },
  {
    name: "跳过-纯提问",
    expect: "skip",
    post: "请问大家湾区现在租金是涨了还是跌了？我想等一等再租，有懂行的朋友说说吗？",
  },
  {
    name: "跳过-完全无关",
    expect: "skip",
    post: "今天去半月湾看日落，风好大但是特别好看，推荐大家去，记得带外套。#湾区周末 #半月湾",
  },
  {
    name: "跳过-家具转让",
    expect: "skip",
    post: "搬家出二手家具，宜家沙发床书桌都有，便宜出，自提，在Sunnyvale，有需要的私信。",
  },
  {
    name: "跳过-出二手车",
    expect: "skip",
    post: "出2019 Toyota Corolla，一手车况好，8万迈，在San Jose，有意私信，价格好商量。",
  },
  {
    name: "跳过-招聘",
    expect: "skip",
    post: "湾区中餐馆招服务员，包吃住，时薪面议，有经验优先，地点Milpitas，有意者私信。",
  },

  // ───────────── 更多边界：容易踩的形态 ─────────────
  {
    name: "求租-中英混写口语",
    kind: "seeker",
    expect: "comment",
    post: "求个studio或者1b1b，budget 2300左右，Sunnyvale/Santa Clara都行，move in 9月，谢谢大家🙏",
  },
  {
    name: "求租-只说公司名",
    kind: "seeker",
    expect: "comment",
    post: "新入职Nvidia，求租附近的房子，一个人住，预算2500以内，10月入住，希望通勤20分钟内。",
  },
  {
    name: "求租-带表情和话题标签",
    kind: "seeker",
    expect: "comment",
    post: "🏠求租｜Fremont｜预算1600｜9月入住｜独立卫浴优先✨ 本人女生上班族，安静爱干净🌸 #湾区租房 #Fremont",
  },
  {
    name: "求租-换房",
    kind: "seeker",
    expect: "comment",
    post: "现在住Milpitas，想换到Santa Clara离公司近点，预算2000内，1b1b或主卧，11月到期后搬。",
  },
  {
    name: "求租-很长很啰嗦",
    kind: "seeker",
    expect: "comment",
    post: `大家好呀，第一次在这里发帖有点紧张。
我是今年刚毕业的学生，马上要去湾区工作了，所以想提前找好房子。
我的情况是这样的：公司在Redwood City，但是我听说那边房租很贵，所以想看看周边。
预算的话，我希望能控制在2200一个月以内，包水电最好。
时间上是9月中旬入职，所以9月初能入住就行。
房型我不挑，studio、1b1b、或者跟人合租一个带独卫的房间都可以接受。
我本人挺安静的，不抽烟不喝酒，也不养宠物，平时就是上班回家，周末可能出去爬爬山。
希望能找到合适的，谢谢大家！`,
  },
  {
    name: "求租-明确不要合租",
    kind: "seeker",
    expect: "comment",
    post: "求租San Mateo整套1b1b，不接受合租，一定要独立厨房厕所，预算3000，10月入住长租。",
  },
  {
    name: "求租-要求可养猫",
    kind: "seeker",
    expect: "comment",
    post: "求租Oakland或Berkeley，一定要能养猫，预算2200以内，studio或1b1b，12月入住。",
  },
  {
    name: "求租-要求包水电",
    kind: "seeker",
    expect: "comment",
    post: "南湾求租房间，预算1300以内，希望包水电网，9月入住，能停一辆车最好。",
  },
  {
    name: "求租-学区房",
    kind: "seeker",
    expect: "comment",
    post: "一家三口求租Cupertino学区房，2b2b以上，预算4500以内，明年2月入住，长租。",
  },
  {
    name: "招租-带车位强调",
    kind: "lister",
    expect: "comment",
    post: "Santa Clara 95051 主卧出租，独立卫浴，含一个固定车位，包水电网，$1900/月，9月1日起租，限女生。",
  },
  {
    name: "招租-ADU",
    kind: "lister",
    expect: "comment",
    post: "Fremont独立ADU出租，一室一厅带厨卫，独立进出，$2300/月，即刻可入住，可短租3个月起。",
  },
  {
    name: "招租-极短",
    kind: "lister",
    expect: "comment",
    post: "San Jose主卧出租，1200，包水电，随时入住。",
  },
  {
    name: "找室友-英文",
    kind: "roommate",
    expect: "comment",
    post: "Looking for a roommate to share a 2b2b in Sunnyvale starting September, rent split around $1700 each, prefer clean and quiet, no pets.",
  },
  {
    name: "找室友-明确性别偏好",
    kind: "roommate",
    expect: "comment",
    post: "找一位女生室友一起租Mountain View的2b1b，9月入住长租，人均1800左右，本人作息规律不抽烟。",
  },
  {
    name: "跳过-已租出",
    expect: "skip",
    post: "【已出租】谢谢大家关注，房子已经租出去了，帖子留着做个记录，祝大家都能找到合适的房子！",
  },
  {
    name: "跳过-求助问哪个区好",
    expect: "skip",
    post: "请问在Palo Alto上班的话，住Menlo Park还是Redwood City比较好？想听听大家的经验，主要考虑通勤和安全。",
  },
  {
    name: "跳过-晒装修",
    expect: "skip",
    post: "花了两周把出租屋改造完成！分享一下我的软装思路和购物清单，租房党也能住得很舒服。#租房改造",
  },
];

// ── 判据 ──────────────────────────────────────────────────────────────────
const URL_RE =
  /https?:\/\/\S+|\[[^\]]*\]\([^)]*\)|(?:www\.)?[a-z0-9-]+\.(?:com|cn|net|org)\b/i;
const CONTACT_RE =
  /微信|weixin|wechat|\bwx\b|\bvx\b|qq号|[\w.+-]+@[\w-]+\.[\w.-]+|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/i;
const CHAT_TAIL_RE =
  /如需调整条件|我再重新筛选|如仍不满意|随时告诉我|需要我帮您找|还是有其他/;
/** 小红书评论的硬上限。提示词里的 260 是用户故意留的余量，300 才是不能破的线。 */
const HARD_MAX_CHARS = 300;
const LISTING_NO_RE = /【第\s*(\d+)\s*套】/g;

const codePoints = (s: string) => [...s].length;

/** 复述帖主自己帖子的特征：回答里大段照抄原文 */
function looksLikeEcho(post: string, reply: string): boolean {
  const stripped = reply.replace(/[\s，。、！？,.!?]/g, "");
  const src = post.replace(/[\s，。、！？,.!?]/g, "");
  if (stripped.length < 20) {
    return false;
  }
  // 取回答里若干 12 字窗口，看有多少能在原文里原样找到
  let hit = 0;
  let total = 0;
  for (let i = 0; i + 12 <= stripped.length; i += 6) {
    total++;
    if (src.includes(stripped.slice(i, i + 12))) {
      hit++;
    }
  }
  return total > 0 && hit / total > 0.4;
}

type Result = {
  name: string;
  ok: boolean;
  problems: string[];
  info: string;
};

async function runCase(
  c: Case,
  index: number,
  POST: (r: Request) => Promise<Response>
): Promise<Result> {
  const req = new Request("http://local/api/xhs/comment-reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 路由设了 token 就带上，跟线上一致
      ...(process.env.XHS_API_TOKEN
        ? { "x-xhs-token": process.env.XHS_API_TOKEN }
        : {}),
    },
    body: JSON.stringify({
      rawText: c.post,
      // 每条用例一个独立帖主，避免互相串会话。
      // **用序号，不要用名字的哈希前缀**：中文名字前缀相同的用例（"求租-…"、
      // "找室友-…"）截出来的十六进制前缀是一样的，会撞成同一个 authorId、
      // 落进同一条会话，`markListingAsSeen` 的排除也就串了。踩过一次。
      authorId: `eval-${index}-${Buffer.from(c.name).toString("hex").slice(-12)}`,
      authorName: `eval:${c.name}`,
    }),
  });

  const res = await POST(req);
  const body = (await res.json()) as Record<string, unknown>;
  const problems: string[] = [];

  if (!body.ok) {
    return {
      name: c.name,
      ok: false,
      problems: [`路由返回失败: ${String(body.error)}`],
      info: "",
    };
  }

  const skipped = body.skipped === true;
  const text = String(body.text ?? "");
  const kind = String(body.postKind ?? "");
  const info = `kind=${kind}${skipped ? " skipped" : ""} ${codePoints(text)}字 tools=[${(body.toolsUsed as string[] | undefined)?.join(",") ?? ""}]`;

  if (c.expect === "skip") {
    if (!skipped) {
      problems.push(`应跳过却出了评论（判成 ${kind}）`);
    }
    return { name: c.name, ok: problems.length === 0, problems, info };
  }

  // 以下是"应该评论"的用例
  if (skipped) {
    problems.push(`不该跳过却跳过了（判成 ${kind}）`);
    return { name: c.name, ok: false, problems, info };
  }
  if (c.kind && kind !== c.kind) {
    problems.push(`身份判错：期望 ${c.kind}，实际 ${kind}`);
  }
  if (text.trim().length === 0) {
    problems.push("评论是空的");
  }
  if (URL_RE.test(text)) {
    problems.push(`含 URL：${text.match(URL_RE)?.[0]}`);
  }
  if (CONTACT_RE.test(text)) {
    problems.push(`含联系方式：${text.match(CONTACT_RE)?.[0]}`);
  }
  if (CHAT_TAIL_RE.test(text)) {
    problems.push(`含聊天页话术：${text.match(CHAT_TAIL_RE)?.[0]}`);
  }
  // 有房源可推时必须带【第N套】编号，且编号要从 1 连续——裁剪之后重新编过号
  if (body.hasListings === true) {
    const nums = [...text.matchAll(LISTING_NO_RE)].map((m) => Number(m[1]));
    if (nums.length === 0) {
      problems.push("有房源却没有【第N套】编号");
    } else if (nums.some((n, i) => n !== i + 1)) {
      problems.push(`编号不连续：${nums.join(",")}`);
    }
  }
  if (codePoints(text) > HARD_MAX_CHARS) {
    problems.push(`超长：${codePoints(text)} 字 > ${HARD_MAX_CHARS}`);
  }
  if (looksLikeEcho(c.post, text)) {
    problems.push("疑似复述帖主原文（没有真正去搜）");
  }

  return { name: c.name, ok: problems.length === 0, problems, info };
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const onlyArg = args.indexOf("--only");
  let cases = CASES;
  if (onlyArg >= 0) {
    cases = [CASES[Number(args[onlyArg + 1])]];
  } else if (limitArg >= 0) {
    cases = CASES.slice(0, Number(args[limitArg + 1]));
  }

  const { POST } = await import("@/app/api/xhs/comment-reply/route");

  const results: Result[] = [];
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.name} ... `);
    try {
      const r = await runCase(c, i, POST);
      results.push(r);
      console.log(r.ok ? `✅ ${r.info}` : `❌ ${r.info}`);
      for (const p of r.problems) {
        console.log(`      ↳ ${p}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        name: c.name,
        ok: false,
        problems: [`抛异常: ${msg}`],
        info: "",
      });
      console.log(`💥 ${msg}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `comment-reply 评测：${results.length - failed.length}/${results.length} 通过`
  );
  if (failed.length > 0) {
    console.log("\n未通过：");
    for (const f of failed) {
      console.log(`  ❌ ${f.name}`);
      for (const p of f.problems) {
        console.log(`       ${p}`);
      }
    }
    process.exitCode = 1;
  }
}

main();
