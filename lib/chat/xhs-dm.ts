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
export const XHS_DM_EXTRA_SYSTEM = `你运转在小红书。你账号是企业专业号。租客会咨询你房源信息，当你觉得"火候"差不多了就叫对方填写联系方式。 还有一些FAQ只在对方问了才回答：价钱是6.88人民币或0.99美金，可获得多个房东的联系方式。需要租客自己联系房东，我不是中介，我只是替代租客做网络搜索。我无法主动联系房东，因为我是商业电话号

这是私信对话，**回复控制在1000字以内**，说人话，别长篇大论。对方问是非题就直接回答是或不是，别把房源列表再甩一遍。`;

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

/**
 * 私信这条链路用的模型。
 *
 * **跟网页分开、且比网页强**：私信里最难的不是找房，是先听懂"这两套还在吗"
 * 是个是非问句而不是一次新搜索。这类意图分辨小模型做不好——gpt-4.1-mini 会
 * 老老实实照着"看到房源词就搜索并展示"执行，甩一堆卡片出来，很不像人。
 * 提示词那道判断闸（见 `lib/ai/prompts.ts` 开头）是根治，模型是让那道闸真正
 * 被执行的前提，两个一起才有效。
 *
 * 换/回退只改环境变量，不用动代码；嫌慢或嫌贵就设成 `openai/gpt-4.1-mini`。
 */
export const XHS_DM_MODEL =
  process.env.XHS_DM_MODEL?.trim() || "anthropic/claude-sonnet-4.5";

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
 * 房源标题行：**非字段行，且下一个非空行是字段行**。
 *
 * 模型输出形状固定：一行标题（不带 `-`）+ 若干 `- 字段: 值`，循环，前面常有
 * 一句引导语、后面常有一句总结。只看"下一行是不是字段"就够分辨：
 *
 *     以下是符合要求的房源：      ← 下一行是标题（非字段）→ 不是标题 ✓
 *     南湾west SJ SFH 4b3b整租招租 ← 下一行是字段 → 是标题 ✓
 *     - 租金: …
 *     这些房源都在您预算内…       ← 下一行没有/非字段 → 不是标题 ✓
 */
function isListingTitle(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    line.trim().length > 0 &&
    line !== LISTING_SEPARATOR &&
    !FIELD_LINE.test(line) &&
    neighborKind(lines, i, 1) === "field"
  );
}

/**
 * 给每条房源上下都包一条分割线：第一条上面、每两条之间、最后一条下面。
 *
 * **在剔除之后跑**：`redactContactInfo` 会整行删掉 `- 联系: …`、还会合并空行，
 * 先插分割线的话行号结构会被它改掉。
 */
export function insertListingSeparators(text: string): string {
  const lines = text.split("\n");
  const titles = lines.map((_, i) => isListingTitle(lines, i));
  if (!titles.includes(true)) {
    return text;
  }

  // 最后一条房源的最后一个字段行——分割线要收在它下面，而不是收在后面那句总结上
  const lastTitle = titles.lastIndexOf(true);
  let lastFieldOfLastBlock = lastTitle;
  for (let i = lastTitle + 1; i < lines.length; i++) {
    if (FIELD_LINE.test(lines[i])) {
      lastFieldOfLastBlock = i;
    } else if (lines[i].trim().length > 0 && lines[i] !== LISTING_SEPARATOR) {
      break;
    }
  }

  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (line === LISTING_SEPARATOR) {
      continue; // 旧的先丢掉，下面统一重排——这样重复调用不会叠加
    }
    if (titles[i]) {
      out.push(LISTING_SEPARATOR);
    }
    out.push(line);
    if (i === lastFieldOfLastBlock) {
      out.push(LISTING_SEPARATOR);
    }
  }

  return out.join("\n");
}

/** 发进小红书私信的长度上限 */
export const DM_CHAR_LIMIT = 1000;

/**
 * 压到长度上限：**整条整条地丢，不切在半截房源上**。
 *
 * 排完版之后每条房源都被一对分割线夹着，所以"丢最后一条"就是删掉倒数第二条
 * 分割线到倒数第一条分割线之间那一段。丢到只剩一条还超，就只能硬截——但那时
 * 截的是一条房源的内部，已经是最差情况，正常不该发生。
 */
function capToLimit(text: string, limit: number): string {
  let lines = text.split("\n");

  while (lines.join("\n").length > limit) {
    const sepAt = lines.reduce<number[]>((acc, line, i) => {
      if (line === LISTING_SEPARATOR) {
        acc.push(i);
      }
      return acc;
    }, []);
    if (sepAt.length < 2) {
      break;
    }
    // 删「倒数第二条分割线 → 倒数第一条分割线之前」，即最后一条房源连它上面那条线
    lines = [
      ...lines.slice(0, sepAt.at(-2)),
      ...lines.slice(sepAt.at(-1) as number),
    ];
  }

  const capped = lines.join("\n");
  return capped.length > limit ? `${capped.slice(0, limit - 1)}…` : capped;
}

/**
 * 私信出站排版：先包分割线，再压到 1000 字。
 *
 * 顺序不能反——压缩靠分割线找房源边界，没排版就只能瞎截。
 */
export function formatForDm(text: string, limit = DM_CHAR_LIMIT): string {
  return capToLimit(insertListingSeparators(text), limit);
}
