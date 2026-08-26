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
const LISTING_NO_RE = /^\s*【第\s*\d+\s*套】/;

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
      ...kept.map((l, i) => l.replace(LISTING_NO_RE, `【第${i + 1}套】`)),
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
  /如仍不满意|如需换一个|我再重新筛选|再为您调整|如需调整条件|告诉我，我再|随时告诉我|可告诉我|看更多|有需求告诉我/;

function dropChatPageTail(text: string): string {
  return text
    .split("\n")
    .filter((line) => !CHAT_PAGE_TAIL_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 *   4. **起草** `runPostScopedTurn` —— **单帖作用域，不读任何历史**。按闸门判出的
 *      身份**只放开对应的那个搜索工具**（房东只有 searchWanted，租客只有
 *      searchRental），从结构上堵掉"给房东推房子"。
 *   5. **压缩** `transformText` —— **纯变换，没有工具没有历史不写库**。
 *      压完死代码拼开场白，进剪贴板。
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
        extraSystem: ROLE_HINT[postKind.kind],
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

    // ---- 压缩：**纯变换**，没有工具、没有历史、不写库 ----
    const draft = dropChatPageTail(toPlainComment(draftTurn.text));
    let condensed =
      dropChatPageTail(
        toPlainComment(
          await transformText({
            input: draft,
            instruction: CONDENSE_MESSAGE,
            selectedChatModel: modelId,
          })
        )
      ) || draft;

    if (codePoints(condensed) > RETRY_ABOVE_CODE_POINTS) {
      const shorter = dropChatPageTail(
        toPlainComment(
          await transformText({
            // 仍然拿第一版草稿去压，不是拿上一次压缩的结果
            input: draft,
            instruction: CONDENSE_AGAIN_MESSAGE,
            selectedChatModel: modelId,
          })
        )
      );
      // 只在真的更短时才采纳：催完反而更长的情况实测出现过（739 字符）
      if (shorter && codePoints(shorter) < codePoints(condensed)) {
        condensed = shorter;
      }
    }

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
