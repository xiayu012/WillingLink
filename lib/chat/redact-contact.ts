/**
 * 剔除联系方式与外链。
 *
 * 用在**渠道适配层的出站方向**：项目 AI 的回答里经常带着房源原文里的微信号、
 * 手机号、邮箱，以及每条房源后面那个 `([原帖](url))` 链接。渠道要不要剔由
 * adapter 自己决定，Chat Engine 不管——同一条 conversation 在网页上仍然看得到
 * 完整原文，被剔的只是发出去的那一份。
 *
 * ## 为什么必须剔干净（小红书私信风控）
 *
 * 查过平台规则：私信里**站外链接一律禁止**（只放行小红书站内笔记/商品链接），
 * 微信号/手机/QQ/邮箱禁止，"微信/淘宝/京东"这类第三方平台字眼也在管控范围。
 * 违反的处罚是警告 → 禁言 7 天 → 30 天 → 封号。所以这里的取舍是**宁可多删**：
 * 少一个号码只是让对方多问一句，漏一个就可能把账号搭进去。
 *
 * ## 实测漏过的三类（用库里真实回复跑出来的，别删这些 case）
 *
 * 1. `([原帖](https://…))` —— 以前完全没管 URL，每条房源都带一个，全泄漏。
 *    站内 xiaohongshu.com 链接也一起删：整段是给网页看的，私信里没有意义。
 * 2. `(415)一254-0960` —— 号码中间夹汉字「一」，纯数字正则认不出来。房源原文
 *    里这种手写混淆很常见（还有全角数字、`&`、`＃` 之类）。
 * 3. `- 联系: 加我的` / 落单的 ` 张先生` —— 删掉号码之后剩下的半截字段。
 *    整行就是联系方式字段的，**整行删掉**，不要留残渣。
 */

type ContactPattern = {
  label: string;
  regex: RegExp;
};

/**
 * 链接：**在其它规则之前跑**，因为 markdown 链接里裹着 URL，先删外层才不会
 * 留下 `[原帖]()` 这种空壳。
 */
const LINK_PATTERNS: (ContactPattern & { replacement: string })[] = [
  {
    label: "markdown-link",
    // `([原帖](url))` 整段连外层括号一起删——这是房源列表里最常见的形态。
    // 没有捕获组，替换成空串（写 "$1" 会被当字面量插进去，踩过这个坑）
    regex: /\s*[（(]\s*\[[^\]]*\]\([^\s)]*\)\s*[）)]/g,
    replacement: "",
  },
  {
    label: "markdown-link",
    // 其余 `[文字](url)` 只留文字
    regex: /\[([^\]]*)\]\([^\s)]*\)/g,
    replacement: "$1",
  },
  {
    label: "url",
    regex: /https?:\/\/\S+/gi,
    replacement: "",
  },
  {
    label: "url",
    // 无协议域名：www.x.com / bay123.com/thread-1.html
    // 前面用否定环视而不是「行首或空白」：中文后面直接跟域名很常见
    // （实测漏过 `参考Apartments.com，Zillow等网站`，「考」不是空白就没匹配上）。
    // 挡掉 [\w@./-] 是为了不切在更长 token 的中间。
    regex:
      /(?<![\w@./-])(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|co|me|app|xyz|top|vip|shop)\b(?:\/\S*)?/gi,
    replacement: "",
  },
];

/**
 * 整行就是联系方式字段的，整行删。房源列表是 `- 联系: xxx` 这种固定格式，
 * 删了值只会剩个空标签，不如整行拿掉。
 */
const CONTACT_LINE_PATTERN =
  // `[*_]{0,2}` 是给 markdown 加粗留的位：实测漏过 `- **联系:** WeChat ID: xxx`，
  // 标签被 ** 包着，不带这一段就匹配不上。
  /^[ \t]*[-*•]?[ \t]*[*_]{0,2}[ \t]*(?:联系方式|联系人|联系电话|联系|电话|手机|微信号?|邮箱|Email|Tel|Phone|Contact)[ \t]*[:：]?[ \t]*[*_]{0,2}[ \t]*[:：]?[^\n]*$/gim;

/**
 * 顺序有讲究：先吃掉"标签 + 号码"的整段（`微信：abc123`），再兜零散的裸号码。
 * 反过来的话标签会剩在原地，变成"微信：""联系："这种半句。
 */
const CONTACT_PATTERNS: ContactPattern[] = [
  {
    label: "email",
    regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  },
  {
    label: "labeled-account",
    // 微信/QQ/TG/IG/手机 等标签后面跟的账号或号码，连标签一起删。
    // 中间那个 `(?:id|号码?|账号|account)?` 是实测补的：`WeChat ID: chunheunwong`
    // 这种写法，平台名和账号之间隔着一个 ID，不放行就整段漏过去。
    regex:
      /(?:微信号?|weixin|wechat|wx|vx|v信|薇信|威信|qq号?|telegram|tg|whatsapp|line|ins|instagram|小红书号?|抖音号?|手机号?|电话|联系方式|联系我?|contact)\s*(?:id|号码?|账号|account)?\s*[:：是为]?\s*[+\dA-Za-z_.-]{4,30}/gi,
  },
  {
    label: "phone",
    // +1 (408) 219-1207 / 408-219-1207 / 4082191207
    regex: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
  },
  {
    label: "phone-obfuscated",
    // 号码中间夹汉字/全角符号：实测遇到过 `(415)一254-0960`。分隔位放宽到
    // 「一〇零○·—～＃&空格」这类手写混淆常用字符，仍然要求 3-3-4 的美国号码骨架，
    // 免得把 `8/29-11/30` 这种日期误伤。
    regex:
      /\(?\d{3}\)?[\s.\-—–~～·一〇零○＃#&*]{1,3}\d{3}[\s.\-—–~～·一〇零○＃#&*]{1,3}\d{4}(?!\d)/g,
  },
  {
    label: "long-digits",
    // 7-15 位裸数字：QQ、手机、微信号常见形态。邮编(5位)、租金(4位)不受影响
    regex: /(?<![\d-])\d{7,15}(?![\d-])/g,
  },
];

/** 删完之后剩下的空标签、空括号、多余标点 */
const LEFTOVER_PATTERNS: RegExp[] = [
  /(?:微信号?|weixin|wechat|wx|vx|qq号?|telegram|tg|whatsapp|line|手机号?|电话|联系方式|联系我?|contact)\s*[:：]?\s*(?=[，。、；;,.）)\]】\n]|$)/gi,
  /[（(【[]\s*[）)】\]]/g,
  /\s*[，,、;；]\s*(?=[，,、;；。.])/g,
  /^[\s，,、;；。.]+/gm,
];

/**
 * 删掉号码之后常留下"短信 或""或邮箱"这种只剩引导词的碎片。按标点切段，把连接词
 * 剥光后什么都不剩的段整段丢掉——留着比删掉更难看。
 */
const CONNECTOR_WORDS =
  /短信|电话|邮箱|微信号?|联系方式|联系我?|有意者|请加|加我|加|或者|或|另|contact|text|call|dm|wechat|wx|vx|tg|qq/gi;

function isOrphanFragment(fragment: string): boolean {
  const bare = fragment
    .replace(CONNECTOR_WORDS, "")
    .replace(/[\s:：\-—~～、,，.。;；()（）【】[\]]/g, "");
  return bare.length === 0;
}

function dropOrphanFragments(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/[，,、;；]/)
        .filter(
          (fragment) =>
            fragment.trim().length === 0 || !isOrphanFragment(fragment)
        )
        .join("，")
    )
    .join("\n");
}

export type RedactResult = {
  text: string;
  /** 命中了哪几类，用于日志——**不要把命中的内容打出去** */
  hits: string[];
};

export function redactContactInfo(input: string): RedactResult {
  const hits: string[] = [];
  let text = input;

  // 1) 链接最先：markdown 外层包着 URL，先删外层才不留 `[原帖]()` 空壳
  for (const { label, regex, replacement } of LINK_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text) && !hits.includes(label)) {
      hits.push(label);
    }
    regex.lastIndex = 0;
    text = text.replace(regex, replacement);
  }

  // 2) 整行的联系方式字段，连标签带值一起拿掉
  CONTACT_LINE_PATTERN.lastIndex = 0;
  if (CONTACT_LINE_PATTERN.test(text)) {
    hits.push("contact-line");
    CONTACT_LINE_PATTERN.lastIndex = 0;
    text = text.replace(CONTACT_LINE_PATTERN, "");
  }

  for (const { label, regex } of CONTACT_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text) && !hits.includes(label)) {
      hits.push(label);
    }
    regex.lastIndex = 0;
    text = text.replace(regex, "");
  }

  if (hits.length > 0) {
    for (const pattern of LEFTOVER_PATTERNS) {
      text = text.replace(pattern, "");
    }
  }

  if (hits.length > 0) {
    text = dropOrphanFragments(text);
  }

  text = text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return { text, hits };
}
