import { geolocation } from "@vercel/functions";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { resolveChatIdForUser } from "@/lib/chat/conversation";
import { runPostScopedTurn, transformText } from "@/lib/chat/engine";
import {
  ChannelTableMissingError,
  resolveInternalUserId,
} from "@/lib/chat/identity";
import {
  createGuestUser,
  findXhsRecordIdsByRawText,
  saveChat,
} from "@/lib/db/queries";
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
const CONDENSE_MESSAGE = "请缩写至260字符左右，不要带联系方式";

/**
 * 没缩到位就再说一遍，**而且说得更具体**："只留三条、每条一行、别写结尾那句"。
 * 只催一次，还不听就用它给的，不跟它耗。
 *
 * 第二次压缩仍然拿**第一轮的草稿**当输入，不是拿上一次压缩的结果——层层转述
 * 会越缩越离原意。
 */
const CONDENSE_AGAIN_MESSAGE =
  "还是太长了。只保留最多3条，每条压成一行，全文260字符以内，不要写联系方式（微信/电话/邮箱都不要），不要分点小标题，也不要最后那句让我调整条件的话。";
/** 超过这个长度才值得再催一次（缩到 300 出头就算它听话了） */
const RETRY_ABOVE_CODE_POINTS = 400;

const codePoints = (text: string) => [...text].length;

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
 * ## 链路（四步，每一步的作用域都不一样，别合并）
 *
 *   1. **闸门** `classifyPostKind` —— 六分类，只有 seeker/lister/roommate 往下走。
 *      看房体验帖里全是租房词但帖主没在求租，冲上去推房源就是答非所问。
 *   2. **排除自帖** —— 油猴复制正文时先入库，这里再拿同一段正文去搜，第一条就是
 *      帖主自己。按 rawText 找出那几条，标成"已看过"，让既有排除机制挡掉。
 *   3. **起草** `runPostScopedTurn` —— **单帖作用域，不读任何历史**。有工具，
 *      要搜房源。写库是为了以后帖主从私信找过来接得上，不是为了这次。
 *   4. **压缩** `transformText` —— **纯变换，没有工具没有历史不写库**。
 *      压完死代码拼开场白，进剪贴板。
 *
 * ## 为什么第 3、4 步必须分开作用域
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
    const ownRecordIds = await findXhsRecordIdsByRawText(rawText);
    await Promise.all(
      ownRecordIds.map((recordId) => markListingAsSeen(chatId, recordId))
    );

    // ---- 起草：**单帖作用域**，不读任何历史 ----
    // 用 runPostScopedTurn 而不是 runChatTurn：一次评论草稿的输入就该是这一篇
    // 帖子，同一帖主上一篇搜到过什么对这一篇没有参考价值（Case C/D 就是被那个
    // 污染的：第二次进来丢掉了 Dublin/San Ramon 的地理约束）。
    const draftTurn = await runPostScopedTurn(
      {
        chatId,
        userId,
        text: rawText.slice(0, MAX_RAW_TEXT_CHARS),
        channel: "xhs",
      },
      { selectedChatModel: modelId, requestHints }
    );

    const hasListings = hasListingResults(draftTurn.toolOutputs);
    // 工具只可能在起草那一步用到——压缩没有工具
    const toolsUsed = draftTurn.toolsUsed;

    if (style === "raw") {
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
    const text = hasListings ? `${OPENING_LINE}\n\n${condensed}` : condensed;

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
