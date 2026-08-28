import { geolocation } from "@vercel/functions";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { resolveChatIdForUser } from "@/lib/chat/conversation";
import {
  type ChatToolName,
  runPostScopedTurn,
  transformText,
} from "@/lib/chat/engine";
import {
  ChannelTableMissingError,
  resolveInternalUserId,
} from "@/lib/chat/identity";
import {
  createGuestUser,
  findXhsRecordIdsByRawText,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { markListingAsSeen } from "@/lib/db/seen-listings";
import { generateUUID } from "@/lib/utils";
import { classifyPostKind } from "@/lib/xhs/post-kind";
import { shouldDraftComment } from "@/lib/xhs/post-kind-rules";

export const maxDuration = 60;
export const preferredRegion = "sfo1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Xhs-Token",
};

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** 帖子正文再长也没必要全喂给模型；两千字足够表达一个租房需求。 */
const MAX_RAW_TEXT_CHARS = 2000;

/** 死代码拼在最前面的一行，不经过模型，永远一字不差。 */
const OPENING_LINE = "看看以下这些觉得怎么样，感兴趣的话私信我：";

/**
 * 没有完全符合的时候发这一句，**整条评论就只有这一句**。
 *
 * 和 `OPENING_LINE` 一样是死代码：不经过模型，永远一字不差。
 *
 * 为什么不让模型自己说"没有"：同一批帖子连跑四轮，模型每轮的措辞都不一样
 * ——"目前数据库里没有…"、"我们主要覆盖旧金山湾区"、"抱歉，数据库只包含…"。
 * 这些话把**内部实现**（我们有个数据库、覆盖范围是湾区）说给了评论区的陌生人听，
 * 而且每次都不同。对外只该有一种说法，那就把它钉死。
 */
const NO_EXACT_MATCH_LINE =
  "我手里没有完全符合的，如果愿意放宽条件可以私聊我";

/** 压缩指令。**这是变换指令，不是对话**——走 `transformText`，没有工具没有历史。 */
const CONDENSE_MESSAGE =
  "请缩写至260字符左右，不要带联系方式。每套房源单独一行，行首标上【第1套】【第2套】这样的编号。";

/**
 * 没缩到位就再说一遍，**而且说得更具体**："只留三条、每条一行、别写结尾那句"。
 * 只催一次，还不听就用它给的，不跟它耗。
 *
 * 第二次压缩仍然拿**第一轮的草稿**当输入，不是拿上一次压缩的结果——层层转述
 * 会越缩越离原意。
 */
const CONDENSE_AGAIN_MESSAGE =
  "还是太长了。只保留最多3条，每条压成一行，行首标【第1套】【第2套】这样的编号，全文260字符以内，不要写联系方式（微信/电话/邮箱都不要），不要分点小标题，也不要最后那句让我调整条件的话。";

/**
 * 评论的硬上限。提示词里写 260 是用户**故意留的余量**，真正不能超的是 300
 * ——提示词是请求，模型经常不听，所以这里还要有一道能兜住的闸。
 */
const DM_HARD_LIMIT = 300;

/** 超过这个长度就再催一次压缩（还够不着硬上限，但已经明显没听话） */
const RETRY_ABOVE_CODE_POINTS = 320;

/** 行首的【第N套】编号——既是排版，也是下面按房源整条裁剪的边界 */
const LISTING_NO_RE = /^\s*【第\s*\d+\s*[套位]】/;

/**
 * 兜住 300 字：**整套整套地丢，不切在半句上**。
 *
 * 编号那一步顺带给了我们可靠的切分边界，所以超长时可以按房源砍，而不是硬截。
 * 砍完重新编号，免得出现「第1套、第3套」这种跳号。真砍到只剩一套还超（说明
 * 单套描述本身就写太长了），才退回硬截。
 */
function capComment(text: string, limit: number): string {
  if (codePoints(text) <= limit) {
    return text;
  }

  const lines = text.split("\n");
  const head = lines.filter((l) => !LISTING_NO_RE.test(l));
  const items = lines.filter((l) => LISTING_NO_RE.test(l));

  const renumber = (kept: string[]) =>
    [
      ...head,
      // 只换数字，保留原本的量词（求租者是"套"，房东/找室友是"位"）
      ...kept.map((l, i) =>
        l.replace(LISTING_NO_RE, (m) => m.replace(/\d+/, String(i + 1)))
      ),
    ]
      .join("\n")
      .trim();

  for (let keep = items.length - 1; keep >= 1; keep--) {
    const candidate = renumber(items.slice(0, keep));
    if (codePoints(candidate) <= limit) {
      return candidate;
    }
  }

  return `${[...text].slice(0, limit - 1).join("")}…`;
}

const codePoints = (text: string) => [...text].length;

/**
 * 同一篇帖子多久之内直接复用上次的评论。
 *
 * 场景是真实的：用户重新打开同一个帖子、油猴重试、或者手滑点两下复制正文，
 * 每一次都会跑一整轮带搜索的 agent（十几秒 + 一次模型调用 + 一次 rerank）。
 *
 * 24 小时：短到库里新入的房源能反映出来，长到覆盖"同一次刷帖"的全过程。
 * 想强制重跑就在 body 里传 `force: true`。
 */
const COMMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 找上次给**这篇帖子**写过的评论。
 *
 * **不需要新建表**：第 5 步已经把「帖子正文 + 最终评论」存进这条 conversation 了，
 * 缓存本来就在，只是以前没人去读。存的就是发出去那一句，所以复用它跟重跑一遍
 * 拿到的是同一种东西——这也是当初坚持"存最终版而不是草稿"的额外好处。
 *
 * 按 chatId 找而不是全库找：chatId 是按帖主身份解析出来的，天然把不同人隔开。
 * 匿名帖主（老版本油猴没传 authorId）每次都是新 chatId，命不中缓存——这是既有
 * 的降级路径，不额外照顾。
 */
async function findCachedComment(
  chatId: string,
  storedRawText: string
): Promise<{ text: string; at: Date } | null> {
  const messages = await getMessagesByChatId({ id: chatId });
  const textOf = (m: (typeof messages)[number]) =>
    (m.parts as { type: string; text?: string }[])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");

  // 从后往前找最近一次：同一篇帖子可能被处理过多轮，要最新的那份
  for (let i = messages.length - 1; i >= 1; i--) {
    const assistant = messages[i];
    const user = messages[i - 1];
    if (
      assistant.role !== "assistant" ||
      user.role !== "user" ||
      textOf(user) !== storedRawText
    ) {
      continue;
    }
    if (Date.now() - assistant.createdAt.getTime() > COMMENT_CACHE_TTL_MS) {
      return null; // 太旧了，库里的房源大概已经变了
    }
    const text = textOf(assistant);
    return text.trim().length > 0 ? { text, at: assistant.createdAt } : null;
  }
  return null;
}

/**
 * 身份定了，就**只放开对的那个搜索工具**。
 *
 * 闸门那一步（`classifyPostKind`）已经花了一次便宜调用判出租客/房东/找室友，
 * 结果不传下去等于让贵的那个 agent 重新推一遍，推错了还没人知道。
 * **同一件事只判一次，判完就往下传。**
 *
 * 而且光传还不够——**提示词是请求，工具表才是约束**。实测：身份已判定为房东、
 * system 里白纸黑字写了"用 searchWanted"，gpt-4.1-mini 照样调 searchRental，
 * 把帖主自己那套 Studio 又描述了一遍（那篇是通篇第二人称的招租广告：
 * "想在伯克利找一套…这套Studio可以重点看看！"）。能用约束解决就别指望它听话。
 *
 * queryListings / 交通那两个是中性工具，三种身份都留着。
 */
const ROLE_TOOLS: Record<string, ChatToolName[]> = {
  seeker: [
    "searchRental",
    "queryListings",
    "findNearestTransit",
    "getTransitTime",
  ],
  lister: [
    "searchWanted",
    "queryListings",
    "findNearestTransit",
    "getTransitTime",
  ],
  roommate: [
    "searchWanted",
    "queryListings",
    "findNearestTransit",
    "getTransitTime",
  ],
};

/**
 * 评论的成品格式，直接讲给**起草那一轮**听。
 *
 * ## 为什么不再压缩第二遍
 *
 * 以前是：起草出一份两千多字的完整回答 → 再交给另一个模型"缩写至260字符"。
 * 两次调用之间是个**信息瓶颈**：第二个模型手里只剩散文，不知道哪个字段重要。
 * 线上实测（AGENT_LOG 2026-08-26 的四篇求租帖）：
 *
 * - 草稿里 `$2950`、`$3350`、`$2,XXX/月` 一应俱全，压缩后**一个价格都不剩**，
 *   留下的是"社区安静生活便利""适合家庭或朋友合租"这种没有决策价值的形容词
 * - 有明确价格的那条房源压缩时**没被选中**，选的全是信息最少的
 * - 有一条更离谱：把**求租者自己的条件**（"预算2500以内，9月初起租3-4个月，
 *   studio或含独立卫浴合租，带车位"）写成了房源描述，末尾还加"信息有限，
 *   建议联系房东确认"
 *
 * 用户的判断是对的——"chat engine 很 OK"，坏的是后面那道工序。
 * **手里有房源数据的是起草那一轮，成品就该由它写完**，中间不要再转一手。
 *
 * 少一次模型调用，还快了 3-6 秒。
 */
const FORMAT_COMMON = `- **全文 260 字符以内**，最多 3 条。评论区没有下一轮对话。
- 不要写链接、不要写联系方式（微信/电话/邮箱）。
- 不要写开场白，也**不要写任何形式的结尾邀请**："如需调整条件…"、"需要更多请
  告诉我"、"说继续查看下一批"、"愿意放宽条件吗"统统不要。**评论区没有下一轮**，
  写了就是穿帮。编号列表结束就结束，后面一个字都不要加（包括"以上均靠近…"
  这类总结）。
- 搜索工具有时会附一句"找不到完全符合要求的，已放宽…"——那是给你看的系统提示，
  **不要转述给用户**。放宽之后拿到的结果，照常按编号列表写出来就行。
- 一条都没搜到时，一句话说清楚没有符合的就结束，同样不要追问、不要提议放宽条件。`;

/**
 * 评论的成品格式，直接讲给**起草那一轮**听，而且**按角色分开写**。
 *
 * 求租者要看的是房源（编号叫"套"、必须有租金）；房东和找室友的人要看的是
 * **人**（编号叫"位"、要写对方的预算和入住时间）。一份格式套两种角色，
 * lister/roommate 那几条就会因为"第N套""租金"套不上去而干脆不编号——实测过。
 */
const COMMENT_FORMAT: Record<string, string> = {
  seeker: `## 输出格式（这段回答会被直接贴进小红书评论区）

${FORMAT_COMMON}
- 每套房源单独一行，行首 \`【第1套】\`\`【第2套】\`\`【第3套】\` 编号。
- 每行**必须**包含：所在城市/区域、房型、**租金**。
  租金是租客最看重的一条，**每一行都不能省**；帖子里确实没写价格就写
  "价格面议"，但不能整行不提钱。
- **剩下的字数，全部用来回答他自己问的那几件事。**
  他专门写出来的诉求（通勤多远、能不能养狗、有没有独卫、包不包水电、
  几个车位、能不能住满、接不接受情侣、押金怎么算…）就是他要的答案，
  **优先级高于任何"卖点"**。他问什么就答什么，别拿泳池健身房去顶替。
- **房源没写的那一项，就明写"未标"**（"租期未标"、"押金未标"、
  "是否可养宠未标"）。这不是废话——他看到"未标"才知道该去私信问什么；
  什么都不写，他只能自己猜。**沉默比说"不知道"更糟。**
- 他要的是**一段时间**（"10/5到12/20"、"住满一年"）时，光写起租日不算回答，
  要交代**能不能覆盖到他要的那天**；房源没写结束时间就写"可租到几时未标"。
- 数据里确实找不到的，**不许编**。写"未标"，不要拿"交通便利""生活方便"
  这种空话冒充答案——那等于没回答，还占了字数。
- **只写房源本身的信息。** 不要把对方提的条件（预算多少、几月入住、要什么户型）
  原样复述成房源描述——那是他自己写的，他知道；要写的是**这套房源在这一项上
  到底怎么样**。`,

  lister: `## 输出格式（这段回答会被直接贴进小红书评论区）

${FORMAT_COMMON}
- 你推给对方的是**正在找房的租客**，不是房源。每位单独一行，行首
  \`【第1位】\`\`【第2位】\`\`【第3位】\` 编号。
- 每行**必须**包含：对方想租的区域、**预算**、入住时间。预算是房东最看重的一条，
  **每一行都不能省**；对方没写预算就写"预算面议"。
  剩下的字数写他的条件（几个人住、有无宠物、租期长短挑最相关的一两个）。
- **只写这些租客的信息。** 不要复述房东自己帖子里的房源描述——那是他写的。`,

  roommate: `## 输出格式（这段回答会被直接贴进小红书评论区）

${FORMAT_COMMON}
- 你推给对方的是**同样在找室友/找合租的人**，不是房源。每位单独一行，行首
  \`【第1位】\`\`【第2位】\`\`【第3位】\` 编号。
- 每行**必须**包含：对方想住的区域、**预算**、入住时间。没写预算就写"预算面议"。
  剩下的字数写他的条件（性别、作息、有无宠物挑最相关的一两个）。
- **只写这些人的信息。** 不要复述对方自己帖子里的内容。`,
};

const ROLE_HINT: Record<string, string> = {
  seeker: `## 这一轮的帖主身份（已判定，不要再自行推翻）
帖主是**租客**，本人正在找房。用 **searchRental** 找房源推给 ta。`,
  lister: `## 这一轮的帖主身份（已判定，不要再自行推翻）
帖主是**房东/二房东**，本人有房要出租。用 **searchWanted** 找正在求租的人推给 ta。
**不要**给 ta 推房源——ta 手里就有房。也不要把 ta 自己帖子的内容复述回去。`,
  roommate: `## 这一轮的帖主身份（已判定，不要再自行推翻）
帖主在**找室友**（房子已定或将定，缺人一起住）。用 **searchWanted** 找同样在找
室友/找合租的人推给 ta。**不要**把 ta 自己帖子的内容复述回去。`,
};

/**
 * 聊天页的回答是 Markdown，小红书评论框是纯文本，星号和方括号会原样露出来。
 * 这里只做**格式**转换，一个字的内容都不改——不是在替模型改写。
 */
function toPlainComment(text: string): string {
  return (
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // 短锚文本（原帖 / 详情 / 链接…）是链接把手，不是内容：整段去掉，
      // 别留下孤零零两个字。长一点的锚文本才是真话，保留文字去掉链接。
      .replace(/[（(]?\[[^\]]{1,6}\]\([^)]*\)[）)]?/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
      .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(
        /[（(【]?\s*(原帖|详情|链接|详情见链接)\s*[】）)]?\s*(https?:\/\/\S+)?/g,
        ""
      )
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * 删掉结尾那句聊天页话术（"如需调整条件…我再重新筛选"）。
 *
 * 这不是又开始替模型改写——用户很早就明确要求过"结尾一句都不许有"，评论区也
 * 确实没有下一轮，那句话贴出去就是穿帮。催它的时候已经说过一遍不要写，它仍然
 * 会带上，所以按字面删掉这一行，仅此一条，别再往上加。
 */
const CHAT_PAGE_TAIL_RE =
  /如仍不满意|如需换一个|我再重新筛选|再为您调整|如需调整条件|告诉我，我再|随时告诉我|可告诉我|看更多|有需求告诉我|如[果需]需?要?更多|请告诉我|告诉我["“]?继续|帮您继续找|愿意放宽/;

/**
 * 编好号之后，**最后一条房源行以下的东西一律不要**。
 *
 * 模型很爱在列表后面加一句总结（"以上均靠近San Mateo，适合10.1起租，符合半岛
 * 20分钟车程要求。"）。这类句子每次措辞都不一样，靠关键词永远追不完；但位置是
 * 确定的——**它一定在最后一个【第N套】之后**。按结构删比按词删可靠。
 */
function dropAfterLastListing(text: string): string {
  const lines = text.split("\n");
  const last = lines.map((l) => LISTING_NO_RE.test(l)).lastIndexOf(true);
  return last === -1 ? text : lines.slice(0, last + 1).join("\n").trim();
}

function dropChatPageTail(text: string): string {
  const kept = dropAfterLastListing(
    text
      .split("\n")
      .filter((line) => !CHAT_PAGE_TAIL_RE.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  // **删空了就当没删过。** 没搜到房源时整条回复可能只有一句
  // "…您是否愿意放宽某些条件"，命中关键词后被删光，路由拿到空串直接 502
  // ——实测踩过。这里的规则是"删尾巴"，不是"允许把话删没"。
  return kept.length > 0 ? kept : text.trim();
}

/**
 * 这一轮到底有没有房源可推，**看工具查到了什么，不看文字长什么样**。
 *
 * 以前是靠正文形状猜（有没有固定开场白、含不含「｜」），模型排版一走样就误判成
 * "没有房源"，把油猴后面的评论步骤整段跳过。工具返回的数组是事实，不会因为
 * 措辞变化而变。
 */
function hasListingResults(toolOutputs: unknown[]): boolean {
  return toolOutputs.some((output) => {
    if (!output || typeof output !== "object") {
      return false;
    }
    const items =
      (output as { listings?: unknown }).listings ??
      (output as { wanted?: unknown }).wanted;
    return Array.isArray(items) && items.length > 0;
  });
}

/**
 * 检索状态码。**判据只能是它，不能是 `relaxedNote`。**
 *
 * `relaxedNote` 那句人话在评论渠道会被 `shapeToolResult` 抹成 null（见
 * presentation.ts：那是给用户看的原话，模型见了会原样贴进评论）。所以到这里时
 * 它**永远是空的**，拿它判"有没有放宽过"会一路判成 false。
 *
 * 状态码则是**故意留下来**的——presentation.ts 开头写明"状态码留着，它携带的是
 * 真实检索状态"，改写的只是后面那串聊天页话术。它是这一层唯一可靠的事实来源。
 */
function statusCodes(toolOutputs: unknown[]): Set<string> {
  const codes = new Set<string>();
  for (const output of toolOutputs) {
    if (!output || typeof output !== "object") {
      continue;
    }
    const action = (output as { action?: unknown }).action;
    if (typeof action !== "string") {
      continue;
    }
    for (const m of action.match(/\b[A-Z][A-Z_]{3,}(?=:)/g) ?? []) {
      codes.add(m);
    }
  }
  return codes;
}

/**
 * 这一轮拿到的**只是放宽后的结果**，不是真正符合要求的。
 *
 * searchWanted 的 Phase 2/3/4 报 `SHOW_RELAXED_WANTED`，searchRental 的旧级联报
 * `SHOW_RELAXED_LISTING`（CLAUDE.md 明说要保留的回退路径，`SEARCH_LEGACY_PICK_ONE=1`
 * 会走到）。searchRental 严格模式**从不放宽**——契约是宁可空手也不给近似的，
 * 所以它没有这类状态码，空结果由 `hasListingResults` 判。
 */
function wasRelaxed(codes: Set<string>): boolean {
  return codes.has("SHOW_RELAXED_WANTED") || codes.has("SHOW_RELAXED_LISTING");
}

function optString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 小红书评论草稿。**这条路由不对项目 AI 塞任何提示词。**
 *
 * 它做的就是替用户把话说了（见 AGENT_LOG「完全替代用户说话」）。
 *
 * ## 链路（六步，每一步的作用域都不一样，别合并）
 *
 *   1. **闸门** `classifyPostKind` —— 六分类，只有 seeker/lister/roommate 往下走。
 *      看房体验帖里全是租房词但帖主没在求租，冲上去推房源就是答非所问。
 *   2. **命中缓存就直接返回** —— 同一篇帖子 24 小时内处理过就复用上次那句。
 *      **不需要缓存表**：第 6 步存的就是发出去那一句，缓存本来就在库里。
 *      放在闸门之后、起草之前：闸门便宜，起草才是十几秒 + 搜索 + rerank 的大头。
 *      传 `force: true` 可以强制重跑。
 *   3. **排除自帖** —— 油猴复制正文时先入库，这里再拿同一段正文去搜，第一条就是
 *      帖主自己。按 rawText 找出那几条，标成"已看过"，让既有排除机制挡掉。
 *   4. **起草成品** `runPostScopedTurn` —— **单帖作用域，不读任何历史**。按闸门
 *      判出的身份**只放开对应的那个搜索工具**（房东只有 searchWanted，租客只有
 *      searchRental），从结构上堵掉"给房东推房子"；同时把 `COMMENT_FORMAT`
 *      一起讲清楚，让**手里有房源数据的这一轮直接写出成品**。
 *   5. **格式清洗** —— Markdown 转纯文本、删聊天页尾巴、拼开场白、`capComment`
 *      兜住 300 字。**没有第二次模型调用**（为什么砍掉见 COMMENT_FORMAT 上面那段）。
 *   6. **存最终版** —— 存的是评论区实际贴出去那句，不是第 4 步那份带 URL 的草稿。
 *      存错了会误导排查（用户就因为库里是草稿，以为线上"还在发 URL"）。
 *      **存的正文必须和第 2 步比对的逐字一致**，否则缓存永远命不中。
 *
 * ## 为什么起草和压缩必须分开作用域
 *
 * 曾经这四步全是 `runChatTurn`，于是每一步都带全套工具、读整段历史。用户报的
 * 6 个 case 里有 5 个是这一个错误造成的（AGENT_LOG 2026-08-25 有 chatId 和时间戳）：
 * 压缩那轮会重新搜索换掉候选、会把上一条用户消息当成压缩对象、会"重新生成"时
 * 编出原文没有的约束；同一帖主的第二篇帖会被第一篇的历史污染掉地理约束。
 *
 * **判断标准是「这一步的输入应该是什么」**：起草的输入是这篇帖子，压缩的输入是
 * 那段草稿，都不是"这个人说过的所有话"。
 *
 * 鉴权：默认无鉴权，与同目录其它 /api/xhs 路由一致。设了 XHS_API_TOKEN 才校验
 * X-Xhs-Token —— 这条路由要跑一轮带搜索的 agent，被人扫到会烧钱。
 */
export async function POST(request: Request) {
  const expectedToken = process.env.XHS_API_TOKEN?.trim();
  if (expectedToken && request.headers.get("x-xhs-token") !== expectedToken) {
    return jsonWithCors({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rawText = optString(payload.rawText);
  if (!rawText) {
    return jsonWithCors({ ok: false, error: "rawText is required" }, 400);
  }

  // raw：只跑第一轮，不缩写也不拼开场白，用来看模型原味回答
  const style = payload.style === "raw" ? "raw" : "comment";
  /** 强制重跑，跳过"同一篇帖子最近处理过"的缓存 */
  const force = payload.force === true;
  const modelId =
    optString(payload.model) ??
    process.env.XHS_COMMENT_REPLY_MODEL?.trim() ??
    DEFAULT_CHAT_MODEL;

  // 帖主身份：油猴从详情页 DOM 里抓的（.author-wrapper 的 profile 链接和昵称）
  const authorId = optString(payload.authorId);
  const authorName = optString(payload.authorName);

  const { longitude, latitude, city, country } = geolocation(request);
  const requestHints = { longitude, latitude, city, country };
  const startedAt = Date.now();

  try {
    // ---- 会话：帖主是一个渠道身份，评论就发生在跟 ta 的那条 conversation 里 ----
    // 认得出帖主 → 进真实会话（以后 ta 从私信/短信找过来，接的是同一串上下文）；
    // 认不出（老版本油猴没传）→ 建一条一次性会话，不阻塞。
    let chatId: string;
    let userId: string;
    let identified = false;
    if (authorId) {
      userId = await resolveInternalUserId({
        channel: "xhs",
        externalUserId: authorId,
        displayName: authorName,
      });
      chatId = await resolveChatIdForUser({
        userId,
        title: `xhs · ${authorName ?? authorId}`,
      });
      identified = true;
    } else {
      chatId = generateUUID();
      const [guest] = await createGuestUser();
      userId = guest.id;
      await saveChat({
        id: chatId,
        userId,
        title: "xhs · 匿名帖主",
        visibility: "private",
      });
    }

    // ---- 闸门：这篇帖子值不值得评论 ----
    // 只有 seeker/lister/roommate 才往下走。看房体验、求建议、无关帖直接返回
    // ——评错一条比不评一条难看得多，而且白烧一整轮带搜索的 agent。
    const postKind = await classifyPostKind(rawText);
    if (!shouldDraftComment(postKind.kind)) {
      console.log(
        "[comment-reply] 跳过",
        JSON.stringify({
          kind: postKind.kind,
          source: postKind.source,
          reason: postKind.reason,
        })
      );
      return jsonWithCors({
        ok: true,
        skipped: true,
        postKind: postKind.kind,
        postKindReason: postKind.reason,
        text: "",
        chatId,
        identified,
        hasListings: false,
        chars: 0,
        elapsedMs: Date.now() - startedAt,
      });
    }

    // ---- 别把帖主自己的帖推荐给帖主 ----
    // 油猴复制正文时先入库，几秒后这里再拿同一段正文去搜，第一条就是 ta 自己。
    // 复用既有的"已看过"排除机制：把自帖标成已看过，搜索工具自然会跳过。
    const storedRawText = rawText.slice(0, MAX_RAW_TEXT_CHARS);

    // ---- 同一篇帖子最近处理过就直接复用 ----
    // 放在闸门之后、起草之前：闸门是一次便宜调用（多数还走正则），起草才是
    // 十几秒 + 搜索 + rerank 的那一步，值得省的是后者。
    if (!force && style === "comment") {
      const cached = await findCachedComment(chatId, storedRawText);
      if (cached) {
        console.log(
          "[comment-reply] 命中缓存",
          JSON.stringify({
            chatId,
            postKind: postKind.kind,
            ageMs: Date.now() - cached.at.getTime(),
            chars: codePoints(cached.text),
          })
        );
        return jsonWithCors({
          ok: true,
          text: cached.text,
          chatId,
          identified,
          model: modelId,
          style,
          postKind: postKind.kind,
          cached: true,
          toolsUsed: [],
          // 只在有房源可推时才拼开场白，所以开场白就是 hasListings 的准确凭证
          hasListings: cached.text.startsWith(OPENING_LINE),
          chars: codePoints(cached.text),
          elapsedMs: Date.now() - startedAt,
        });
      }
    }

    const ownRecordIds = await findXhsRecordIdsByRawText(rawText);
    await Promise.all(
      ownRecordIds.map((recordId) => markListingAsSeen(chatId, recordId))
    );

    // ---- 起草：**单帖作用域**，不读任何历史 ----
    // 用 runPostScopedTurn 而不是 runChatTurn：一次评论草稿的输入就该是这一篇
    // 帖子，同一帖主上一篇搜到过什么对这一篇没有参考价值（Case C/D 就是被那个
    // 污染的：第二次进来丢掉了 Dublin/San Ramon 的地理约束）。
    // persist:false —— 库里要存的是**最终发出去那句话**，不是这份还带着 URL、
    // 还没压缩的草稿。压缩完再自己存（见下面 persistTurn）。
    const draftTurn = await runPostScopedTurn(
      {
        chatId,
        userId,
        text: storedRawText,
        channel: "xhs",
      },
      {
        selectedChatModel: modelId,
        requestHints,
        persist: false,
        // 身份 + 成品格式一起讲清楚：起草这一轮手里有房源数据，成品就该它写完
        extraSystem: `${ROLE_HINT[postKind.kind]}\n\n${COMMENT_FORMAT[postKind.kind]}`,
        onlyTools: ROLE_TOOLS[postKind.kind],
      }
    );

    /**
     * 把「帖子正文 + 最终评论」写进这条 conversation。
     *
     * 存最终版而不是草稿：网页上看到的必须跟评论区实际贴出去的一致，否则排查
     * 问题时会被带偏（用户就因为库里存的是带 URL 的草稿，以为"还在发 url"）。
     * 压缩指令本身不存——那是排版动作，不是帖主提的需求。
     */
    const persistTurn = async (finalText: string) => {
      const now = Date.now();
      await saveMessages({
        messages: [
          {
            id: generateUUID(),
            chatId,
            role: "user",
            // 存的这一份必须和 `findCachedComment` 比对的那一份**逐字一致**，
            // 否则下次永远命不中缓存
            parts: [{ type: "text", text: storedRawText }],
            attachments: [],
            createdAt: new Date(now),
          },
          {
            id: generateUUID(),
            chatId,
            role: "assistant",
            parts: [{ type: "text", text: finalText }],
            attachments: [],
            createdAt: new Date(now + 1),
          },
        ] as DBMessage[],
      });
    };

    const hasListings = hasListingResults(draftTurn.toolOutputs);
    // 工具只可能在起草那一步用到——压缩没有工具
    const toolsUsed = draftTurn.toolsUsed;
    const searched = toolsUsed.some(
      (t) => t === "searchRental" || t === "searchWanted"
    );
    const codes = statusCodes(draftTurn.toolOutputs);
    /**
     * **搜过了，但没有一条是真正符合的。**
     *
     * 两种情况合并成同一个结论：一条都没搜到（`!hasListings`），或者搜到的只是
     * 放宽条件后的近似结果（`wasRelaxed`）。后者以前是**当成正常结果发出去的**
     * ——`COMMENT_GUIDE.SHOW_RELAXED_WANTED` 明确让模型"不要提放宽这件事，照常按
     * 编号列表写出来"，于是租客看到三条像模像样的房源，不知道其中没有一条满足
     * 他提的条件。
     *
     * **出了服务范围的不算**：`OUT_OF_BAY` 时再怎么放宽也变不出奥克兰的房子，
     * 那句"愿意放宽条件可以私聊我"是张空头支票，维持原有行为（如实说明只收录湾区）。
     *
     * **没调过搜索工具的也不算**：没有任何证据说明"没有符合的"，不能替它下结论。
     */
    const noExactMatch =
      searched &&
      !codes.has("OUT_OF_BAY") &&
      (!hasListings || wasRelaxed(codes));

    if (style === "raw") {
      await persistTurn(draftTurn.text);
      return jsonWithCors({
        ok: true,
        text: draftTurn.text,
        chatId,
        identified,
        model: modelId,
        style,
        postKind: postKind.kind,
        toolsUsed,
        hasListings,
        chars: codePoints(draftTurn.text),
        elapsedMs: Date.now() - startedAt,
      });
    }

    // ---- 没有完全符合的：发那一句固定的话，**把草稿整份丢掉** ----
    // 丢掉不是浪费——那一轮的价值在 toolOutputs（我们正是靠它判出"没有符合的"），
    // 它写的正文在这种情况下要么是编号列表（近似房源，不该发），要么是每轮都不
    // 一样的"数据库里没有…"（不该让评论区看见内部实现）。
    if (noExactMatch) {
      await persistTurn(NO_EXACT_MATCH_LINE);
      console.log(
        "[comment-reply] 无完全匹配",
        JSON.stringify({
          chatId,
          postKind: postKind.kind,
          toolsUsed: [...new Set(toolsUsed)],
          statusCodes: [...codes],
          relaxed: wasRelaxed(codes),
          hadApproximateResults: hasListings,
          elapsedMs: Date.now() - startedAt,
        })
      );
      return jsonWithCors({
        ok: true,
        text: NO_EXACT_MATCH_LINE,
        chatId,
        identified,
        model: modelId,
        style,
        postKind: postKind.kind,
        toolsUsed: [...new Set(toolsUsed)],
        noExactMatch: true,
        hasListings: false,
        chars: codePoints(NO_EXACT_MATCH_LINE),
        elapsedMs: Date.now() - startedAt,
      });
    }

    // ---- 只做格式清洗，**不再压缩** ----
    // 起草那一轮已经按 COMMENT_FORMAT 写成了成品（编号 + 带租金 + 260 字以内），
    // 这里只把 Markdown 转纯文本、删掉聊天页尾巴。真超了长度由 capComment 兜底。
    const condensed = dropChatPageTail(toPlainComment(draftTurn.text));

    if (!condensed) {
      return jsonWithCors({ ok: false, error: "Model returned no text" }, 502);
    }

    // ---- 死代码拼开场白。没房源可推时不拼——那句话会变成假的 ----
    // 上限在拼完开场白之后才卡：开场白也占字数，先卡后拼等于白卡。
    const text = capComment(
      hasListings ? `${OPENING_LINE}\n\n${condensed}` : condensed,
      DM_HARD_LIMIT
    );

    // 存最终版——网页上看到的就是评论区实际贴出去的那一句
    await persistTurn(text);

    console.log(
      "[comment-reply]",
      JSON.stringify({
        model: modelId,
        chatId,
        identified,
        authorId,
        postKind: postKind.kind,
        postKindSource: postKind.source,
        ownRecordsExcluded: ownRecordIds.length,
        toolsUsed: [...new Set(toolsUsed)],
        hasListings,
        draftChars: codePoints(draftTurn.text),
        chars: codePoints(text),
        elapsedMs: Date.now() - startedAt,
        sourceUrl: optString(payload.sourceUrl),
      })
    );

    return jsonWithCors({
      ok: true,
      text,
      chatId,
      identified,
      model: modelId,
      style,
      postKind: postKind.kind,
      toolsUsed: [...new Set(toolsUsed)],
      hasListings,
      chars: codePoints(text),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof ChannelTableMissingError) {
      return jsonWithCors(
        { ok: false, error: error.message, needsMigration: true },
        501
      );
    }
    // AI SDK 的错误对象直接丢给 console.error 会让 util.inspect 自身抛异常
    // （见 .claude/AGENT_LOG.md 的 fail-open 事故），只打名字和消息。
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    console.log("[comment-reply] failed", `${name}: ${message}`);
    return jsonWithCors({ ok: false, error: `AI reply failed: ${name}` }, 502);
  }
}
