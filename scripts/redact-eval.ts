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
console.log(
  `\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed}/${cases.length} 条不通过`}`
);
