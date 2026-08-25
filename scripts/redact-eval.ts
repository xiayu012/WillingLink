/**
 * 出站剔除的回归门禁：`pnpm redact-eval`，全绿才能发布。
 *
 * 为什么需要它：小红书私信风控对**站外链接和联系方式**是硬红线（警告 → 禁言
 * 7 天 → 30 天 → 封号），而这一层每放宽一点正则，就可能漏一整类出去。反过来
 * 删太狠又会把租金、邮编、日期、地标一起吃掉，房源就没法看了。两个方向都得钉住。
 *
 * 下面每条 case 都来自**真实**语料——用库里的助手回复跑 `redactContactInfo`、
 * 人眼读剔后文本抓出来的（`(415)一254-0960`、`**联系:** WeChat ID: xxx`、
 * `参考Apartments.com` 都是这么发现的）。别删 case，只加。
 *
 * 要再对真实数据扫一遍时：从 Message_v2 拉 role='assistant' 的 parts，逐条过
 * `redactContactInfo`，然后用下面 mustDrop 的那几类正则去搜剔后文本。
 */
import { redactContactInfo } from "../lib/chat/redact-contact";
import {
  DM_CHAR_LIMIT,
  formatForDm,
  insertListingSeparators,
  LISTING_SEPARATOR,
  wantsContactCollection,
} from "../lib/chat/xhs-dm";
import {
  classifyPostKindByRule,
  shouldDraftComment,
} from "../lib/xhs/post-kind-rules";

type Case = {
  name: string;
  input: string;
  mustDrop?: string[];
  mustKeep?: string[];
};

const cases: Case[] = [
  // ---- 必须剔掉 ----
  {
    name: "原帖markdown链接",
    input:
      "标题 ([原帖](https://www.xiaohongshu.com/discovery/item/6a7?x=1))\n- 房型: 1 室",
    mustDrop: ["原帖", "xiaohongshu.com", "http"],
    mustKeep: ["标题", "房型"],
  },
  {
    name: "站外链接",
    input: "看这个 ([原帖](http://www.bay123.com/thread-242033-1-1.html))",
    mustDrop: ["bay123", "http"],
  },
  {
    name: "裸URL",
    input: "详情 https://example.com/a/b?c=d 请看",
    mustDrop: ["example.com", "https"],
  },
  {
    name: "无协议域名跟在中文后",
    input: "可参考Apartments.com，Zillow等网站",
    mustDrop: ["Apartments.com"],
  },
  {
    name: "混淆电话(夹汉字)",
    input: "- 联系: (415)一254-0960 Lin",
    mustDrop: ["415", "254", "0960", "Lin"],
  },
  {
    name: "普通电话",
    input: "电话 408-219-1207 找我",
    mustDrop: ["408", "219", "1207"],
  },
  {
    name: "markdown加粗联系行",
    input: "- **联系:** ， WeChat ID: chunheunwong\n- **租金:** $1000",
    mustDrop: ["WeChat", "chunheunwong"],
    mustKeep: ["租金", "$1000"],
  },
  {
    name: "微信号",
    input: "加微信：abc_123456 详聊",
    mustDrop: ["微信", "abc_123456"],
  },
  {
    name: "邮箱",
    input: "邮件 zhang.san@gmail.com 联系",
    mustDrop: ["@gmail.com", "zhang.san"],
  },
  { name: "QQ", input: "QQ 872913455", mustDrop: ["872913455"] },

  // ---- 必须保留（误伤检查）----
  {
    name: "租金",
    input: "- 租金: $1250/月，押一付一",
    mustKeep: ["$1250", "租金"],
  },
  {
    name: "带逗号租金",
    input: "- 租金: $1，300/月（含水电）",
    mustKeep: ["300", "含水电"],
  },
  {
    name: "日期区间",
    input: "- 简介: 时间8/29-11/30，市中心新楼",
    mustKeep: ["8/29", "11/30"],
  },
  {
    name: "邮编",
    input: "灣區Hayward房間出租｜94541｜8月下旬可入住",
    mustKeep: ["94541"],
  },
  {
    name: "门牌路口",
    input: "- 位置: 三藩市，10th Ave 和 Irving St 交口",
    mustKeep: ["10th Ave", "Irving St"],
  },
  {
    name: "地标抖音",
    input: "靠近SJSU/NEU/UCSC/抖音 $850 两个次卧出租",
    mustKeep: ["抖音", "$850"],
  },
  {
    name: "房型数字",
    input: "- 房型: 3 室 / 1 卫 · 单房",
    mustKeep: ["3 室", "1 卫"],
  },
  {
    name: "纯问候不动",
    input: "我在线，有什么湾区租房需求请告诉我，我帮您找。",
    mustKeep: ["我在线", "湾区租房"],
  },
  {
    name: "高速公路号",
    input: "靠近92. 101， 高速公路",
    mustKeep: ["92", "101"],
  },
  { name: "网速", input: "500M High speed internet", mustKeep: ["500M"] },
];

let failed = 0;
for (const c of cases) {
  const { text } = redactContactInfo(c.input);
  const bad: string[] = [];
  for (const d of c.mustDrop ?? []) {
    if (text.includes(d)) {
      bad.push(`应删未删: "${d}"`);
    }
  }
  for (const k of c.mustKeep ?? []) {
    if (!text.includes(k)) {
      bad.push(`应留被删: "${k}"`);
    }
  }
  if (bad.length) {
    failed++;
    console.log(`❌ ${c.name}`);
    console.log(`   输入: ${c.input.replace(/\n/g, " ⏎ ")}`);
    console.log(`   输出: ${text.replace(/\n/g, " ⏎ ")}`);
    for (const b of bad) {
      console.log(`   ${b}`);
    }
  } else {
    console.log(`✅ ${c.name}`);
  }
}
// ---------------------------------------------------------------------------
// collect_contact 的判定。正反都要钉：漏判则留资组件不挂（白问一轮），
// 误判则模型只是在解释「平台不让发房东联系方式」也去挂组件（用户看着莫名其妙）。
// ---------------------------------------------------------------------------

const collectCases: { name: string; input: string; expect: boolean }[] = [
  {
    name: "留个联系方式",
    input: "方便留个联系方式吗？我把房源整理给您",
    expect: true,
  },
  {
    name: "填写您的联系方式",
    input: "请填写一下您的联系方式，我发详细信息给您",
    expect: true,
  },
  { name: "留下电话", input: "您留下电话，我让房东联系您", expect: true },
  {
    name: "把微信发给我",
    input: "把您的微信发给我，我推给您几套",
    expect: true,
  },
  {
    name: "提交联系方式",
    input: "提交联系方式后即可查看多个房东联系方式",
    expect: true,
  },
  {
    name: "解释平台限制(不算)",
    input: "小红书平台不让私聊发送房东的联系方式，请理解",
    expect: false,
  },
  {
    name: "说明付费获得(不算)",
    input: "价钱是6.88人民币，可获得多个房东的联系方式",
    expect: false,
  },
  {
    name: "普通房源回复(不算)",
    input: "为您找到3套Sunnyvale房源，租金$2000起，均可短租",
    expect: false,
  },
  {
    name: "纯问候(不算)",
    input: "我在线，有什么湾区租房需求请告诉我",
    expect: false,
  },
];

for (const c of collectCases) {
  const got = wantsContactCollection(c.input);
  if (got === c.expect) {
    console.log(`✅ collect: ${c.name}`);
  } else {
    failed++;
    console.log(`❌ collect: ${c.name}`);
    console.log(`   输入: ${c.input}`);
    console.log(`   期望 ${c.expect}，实际 ${got}`);
  }
}

// ---------------------------------------------------------------------------
// 房源分割线。要钉的是「插在哪」：只在房源之间，开头的引导语和结尾的总结句
// 前面都不能插——两头的判断（上一行是字段 && 下一行是字段）缺一就会误插。
// ---------------------------------------------------------------------------

const SEP = LISTING_SEPARATOR;
const twoListings = [
  "以下是符合要求的房源：",
  "南湾west SJ SFH 4b3b整租招租",
  "- 租金: $5000/月",
  "- 房型: 4 室 / 3 卫",
  "Sunnyvale主卧独立卫浴9/1起",
  "- 租金: $1800/月",
  "- 房型: 1 室 / 1 卫",
  "这些房源都在您预算内，需要我再筛吗？",
].join("\n");

const sepChecks: { name: string; pass: boolean; detail?: string }[] = [];

sepChecks.push({
  name: "分割符正好15字符",
  pass: SEP.length === 15,
  detail: `实际 ${SEP.length}`,
});

const sepOut = insertListingSeparators(twoListings);
const sepLines = sepOut.split("\n");
const sepCount = sepLines.filter((l) => l === SEP).length;

// 2 条房源 → 3 条线：第一条上面、两条之间、最后一条下面
sepChecks.push({
  name: "两条房源共3条线(首+中+尾)",
  pass: sepCount === 3,
  detail: `实际 ${sepCount} 条`,
});
sepChecks.push({
  name: "第一条房源上面有线",
  pass: sepLines[0] === "以下是符合要求的房源：" && sepLines[1] === SEP,
  detail: sepLines.slice(0, 2).join(" / "),
});
sepChecks.push({
  name: "线插在标题正上方",
  pass: sepLines[sepLines.indexOf(SEP) + 1] === "南湾west SJ SFH 4b3b整租招租",
  detail: sepLines[sepLines.indexOf(SEP) + 1],
});
sepChecks.push({
  name: "最后一条房源下面有线(在总结句之前)",
  pass:
    sepLines.at(-2) === SEP && sepLines.at(-1)?.startsWith("这些房源") === true,
  detail: sepLines.slice(-2).join(" / "),
});
sepChecks.push({
  name: "单条房源也上下包线",
  pass:
    insertListingSeparators(
      "房源一览：\n某房源标题\n- 租金: $1000\n- 房型: 1 室"
    )
      .split("\n")
      .filter((l) => l === SEP).length === 2,
});
sepChecks.push({
  name: "重复跑不叠加(幂等)",
  pass: insertListingSeparators(sepOut) === sepOut,
});
sepChecks.push({
  name: "纯问候不动",
  pass:
    insertListingSeparators("我在线，有什么需求告诉我") ===
    "我在线，有什么需求告诉我",
});

// ---- 1000 字上限：丢整条，不切半截 ----
const bulky = [
  "以下是符合要求的房源：",
  ...Array.from({ length: 12 }, (_, n) => [
    `房源标题第${n + 1}条`,
    `- 租金: $${1000 + n}/月`,
    `- 位置: San Jose ${n}`,
    `- 简介: ${"细节".repeat(40)}`,
  ]).flat(),
  "以上就是全部房源。",
].join("\n");
const capped = formatForDm(bulky);

sepChecks.push({
  name: "超长压到1000字以内",
  pass: capped.length <= DM_CHAR_LIMIT,
  detail: `实际 ${capped.length}`,
});
sepChecks.push({
  name: "短文本不动",
  pass: formatForDm("我在线") === "我在线",
});
sepChecks.push({
  name: "截断后仍以分割线收尾(没切在半截房源上)",
  pass: capped.split("\n").filter((l) => l === SEP).length >= 2,
  detail: `线 ${capped.split("\n").filter((l) => l === SEP).length} 条`,
});
sepChecks.push({
  name: "截断保留的是完整房源(最后一个字段行完整)",
  pass: (() => {
    const lines = capped.split("\n");
    const lastSep = lines.lastIndexOf(SEP);
    const before = lines[lastSep - 1] ?? "";
    return before.startsWith("- ") && before.endsWith("细节");
  })(),
});

for (const c of sepChecks) {
  if (c.pass) {
    console.log(`✅ sep: ${c.name}`);
  } else {
    failed++;
    console.log(`❌ sep: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 帖子分类闸门。只钉**正则快路径**（不调模型，跑得快、结果确定）；LLM 那条路
// 是概率性的，放进门禁只会变成随机失败。
// 要钉的重点：看房体验帖不能被当成求租帖去评论（Case F）。
// ---------------------------------------------------------------------------

const kindChecks: { name: string; pass: boolean; detail?: string }[] = [];

for (const c of [
  {
    name: "看房体验帖→不评论",
    text: "看房体验分享：这次实地tour了Huxley、Indigo、Trestle三家公寓，Huxley前台服务好，Indigo健身房大，Trestle性价比高。",
    expectComment: false,
  },
  {
    name: "踩坑避雷帖→不评论",
    text: "租房踩坑总结！签约前一定要看清楚这几条，避雷不良中介，我的血泪教训分享给大家。",
    expectComment: false,
  },
  {
    name: "找室友帖→要评论",
    text: "NEU硅谷校区硕士新生，真诚找一位合拍女生室友，已看好2B2B公寓，人均2k+，9月初入住。",
    expectComment: true,
  },
]) {
  const ruled = classifyPostKindByRule(c.text);
  const got = ruled ? shouldDraftComment(ruled.kind) : null;
  if (got === c.expectComment) {
    kindChecks.push({ name: c.name, pass: true });
  } else {
    kindChecks.push({
      name: c.name,
      pass: false,
      detail: `期望${c.expectComment ? "评论" : "跳过"}，实际${ruled ? `${ruled.kind}/${got ? "评论" : "跳过"}` : "正则未命中(会落到模型)"}`,
    });
  }
}

for (const c of kindChecks) {
  if (c.pass) {
    console.log(`✅ kind: ${c.name}`);
  } else {
    failed++;
    console.log(`❌ kind: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

const total =
  cases.length + collectCases.length + sepChecks.length + kindChecks.length;
console.log(
  `\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed}/${total} 条不通过`}`
);
