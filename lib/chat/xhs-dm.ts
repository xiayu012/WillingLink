/**
 * 小红书私信这条渠道自己的东西：**渠道提示词** + **「要不要收联系方式」的识别**。
 *
 * 两样为什么放同一个文件：识别器认的就是上面那段提示词引导模型说出来的话。
 * 拆到两处，改了提示词忘了改识别、或者反过来，线上表现是 `collect_contact`
 * 一直是 false，而且不报错、不留日志——最难查的那种。**改一个就回来看另一个。**
 */

/**
 * 作为 `extraSystem` 追加在项目通用 system prompt 后面（`buildTurnSetup`
 * 负责拼接），只对小红书私信这条渠道生效，网页那条不受影响。
 *
 * 内容是用户口述的原话，没有改写：这是运营策略（什么时候要联系方式、定价多少、
 * 为什么不能直接给房东电话），不是我能替他决定的东西。
 */
export const XHS_DM_EXTRA_SYSTEM = `你运转在小红书。你账号是企业专业号。租客会咨询你房源信息，当你觉得"火候"差不多了就叫对方填写联系方式。 还有一些FAQ只在对方问了才回答：价钱是6.88人民币或0.99美金，可获得多个房东的联系方式。需要租客自己联系房东，我不是中介，我只是替代租客做网络搜索。我无法主动联系房东，因为我是商业电话号`;

/**
 * 「这句话是在叫对方留联系方式吗」。
 *
 * 用正则不用模型：这段文本是**我们自己的提示词**引导出来的，措辞高度可预期，
 * 正则零延迟零成本且结果稳定；上一轮已经因为多绕一跳吃过延迟的亏，没必要为一个
 * 布尔值再加一次模型调用。真哪天发现措辞太散兜不住，再换最便宜的模型也不迟。
 *
 * **关键是别把「提到房东的联系方式」误判成「在要对方的联系方式」**——上面 FAQ
 * 里就写着「可获得多个房东的联系方式」，模型答 FAQ 时会原样复述。所以动词和
 * 名词之间只放行「你的/您的/一下/个」这几个词，中间一旦插进「房东的」就匹配不上：
 *
 *   ✅ 方便留个联系方式吗          → true
 *   ✅ 请填写一下您的联系方式      → true
 *   ✅ 把您的微信发给我            → true
 *   ❌ 平台不让发送房东的联系方式  → false（发送不在动词表里，且隔着「房东的」）
 *   ❌ 付费后可获得多个房东的联系方式 → false
 */
const CONTACT_NOUN = "(?:联系方式|联系电话|电话|手机号?|微信号?|微信|邮箱)";
const OWNER_HINT = "(?:您的|你的|自己的)?";

const COLLECT_CONTACT_PATTERNS: RegExp[] = [
  // 动词在前：填写/留下/提交 + （你的）+ 联系方式
  new RegExp(
    `(?:填写|填一下|填个|留下|留个|留一下|提交|发我|发给我|给我|告诉我)\\s*(?:一下)?\\s*${OWNER_HINT}\\s*${CONTACT_NOUN}`
  ),
  // 名词在前：把您的联系方式 + 发给我/填一下
  new RegExp(
    `(?:您的|你的)\\s*${CONTACT_NOUN}\\s*(?:发给我|给我|告诉我|留给我|填写|填一下|提交)`
  ),
];

/**
 * @param text 模型这一轮的**原始**回复（剔联系方式之前）。用原文是因为
 *   `redactContactInfo` 会按标点切碎重组，「留下您的联系方式」这类句子过完那一层
 *   形状可能变，判意图应该看模型本来说了什么。
 */
export function wantsContactCollection(text: string): boolean {
  return COLLECT_CONTACT_PATTERNS.some((pattern) => pattern.test(text));
}

/** 房源之间的分割线：15 个 em dash（U+2014） */
export const LISTING_SEPARATOR = "—".repeat(15);

/**
 * 字段行：`- 租金: $1250`。用 ASCII `-*•`，**不含 em dash**，所以分割线本身
 * 不会被当成字段行——重复调用这个函数是安全的。
 */
const FIELD_LINE = /^[ \t]*[-*•]/;

function neighborKind(
  lines: string[],
  from: number,
  step: -1 | 1
): "field" | "text" | "none" {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) {
    const line = lines[i];
    if (line.trim().length === 0 || line === LISTING_SEPARATOR) {
      continue;
    }
    return FIELD_LINE.test(line) ? "field" : "text";
  }
  return "none";
}

/**
 * 房源与房源之间插一条分割线。
 *
 * 模型输出的形状是固定的：一行标题（不带 `-`），跟着若干 `- 字段: 值`，如此循环，
 * 前面常有一句引导语、后面常有一句总结。所以「新房源的标题」＝**上一行是字段行、
 * 下一行也是字段行**的那种非字段行：
 *
 *     南湾地区，预算5000美元每月…以下是符合要求的房源：   ← 引导语（上一行不是字段）
 *     南湾west SJ SFH 4b3b整租招租                      ← 第一条，前面不插
 *     - 租金: …
 *     - 房型: …
 *     ———————————————                                  ← 插在这
 *     Sunnyvale主卧独立卫浴9/1起available
 *     - 租金: …
 *     这些房源都在您预算内，需要我再筛吗？                ← 总结句（下一行不是字段）
 *
 * 两头的判断缺一不可：只看上一行，结尾的总结句会被误当成标题；只看下一行，
 * 开头的引导语会被误判。
 *
 * **在剔除之后跑**：`redactContactInfo` 会整行删掉 `- 联系: …`、还会合并空行，
 * 先插分割线的话行号结构会被它改掉。
 */
export function insertListingSeparators(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (const [i, line] of lines.entries()) {
    const isTitle =
      line.trim().length > 0 &&
      !FIELD_LINE.test(line) &&
      neighborKind(lines, i, -1) === "field" &&
      neighborKind(lines, i, 1) === "field";

    // `out.at(-1)` 那半句是为了幂等：`neighborKind` 会跳过已有的分割线去看真正的
    // 邻居，所以对已经插过的文本再跑一遍，标题仍然判为 true，不拦就会叠第二条。
    if (isTitle && out.at(-1) !== LISTING_SEPARATOR) {
      out.push(LISTING_SEPARATOR);
    }
    out.push(line);
  }

  return out.join("\n");
}
