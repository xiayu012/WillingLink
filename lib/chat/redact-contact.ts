/**
 * 剔除联系方式。
 *
 * 用在**渠道适配层的出站方向**：项目 AI 的回答里经常带着房源原文里的微信号、
 * 手机号、邮箱（库里那些字段就是这么存的），直接发到小红书私信里既像营销号，
 * 也等于替房东在平台外导流。渠道要不要剔由 adapter 自己决定，Chat Engine 不管
 * ——同一条 conversation 在网页上仍然看得到完整原文。
 *
 * 取舍：**宁可多删一点**。少一个微信号只是让对方来问一句，漏一个就发出去了。
 */

type ContactPattern = {
  label: string;
  regex: RegExp;
};

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
    // 微信/QQ/TG/IG/手机 等标签后面跟的账号或号码，连标签一起删
    regex:
      /(?:微信号?|weixin|wechat|wx|vx|v信|薇信|威信|qq号?|telegram|tg|whatsapp|line|ins|instagram|小红书号?|抖音号?|手机号?|电话|联系方式|联系我?|contact)\s*[:：是为]?\s*[+\dA-Za-z_.-]{4,30}/gi,
  },
  {
    label: "phone",
    // +1 (408) 219-1207 / 408-219-1207 / 4082191207
    regex: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
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
  /[（(【\[]\s*[）)】\]]/g,
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

  for (const { label, regex } of CONTACT_PATTERNS) {
    if (regex.test(text)) {
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
