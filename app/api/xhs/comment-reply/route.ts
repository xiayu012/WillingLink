import { geolocation } from "@vercel/functions";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { resolveChatIdForUser } from "@/lib/chat/conversation";
import { runChatTurn } from "@/lib/chat/engine";
import {
  ChannelTableMissingError,
  resolveInternalUserId,
} from "@/lib/chat/identity";
import { createGuestUser, saveChat } from "@/lib/db/queries";
import { generateUUID } from "@/lib/utils";

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

/** 第二轮就说这一句——跟真人在聊天页嫌回答太长时说的话一模一样。 */
const CONDENSE_MESSAGE = "请缩写至260字符左右，不要带联系方式";

/**
 * 没缩到位就再说一遍，**而且说得更具体**——真人嫌长时就是这么催的：
 * "只留三条、每条一行、别写结尾那句"。这仍然是以用户身份说话，不是往系统
 * 提示词里塞规则。只催一次，还不听就用它给的，不跟它耗。
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
  return text
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
    .replace(/[（(【]?\s*(原帖|详情|链接|详情见链接)\s*[】）)]?\s*(https?:\/\/\S+)?/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
 * 它做的就是替用户把话说了（见 AGENT_LOG「完全替代用户说话」）：
 *
 *   1. 把复制来的帖子正文原样发给项目 AI —— 跟人在聊天页粘一段帖子问"有房源吗"
 *      完全一样，同一套 system prompt、同一批工具，没有额外渠道规则。
 *   2. 模型照常输出一大段。
 *   3. 再以用户的身份说一句「请缩写至260字符左右」。
 *   4. 拿它缩写后的文字，**死代码**在最前面拼上那行开场白，进剪贴板。
 *
 * 整个过程留在这个帖主的 conversation 里，网页打开能看到全部四条消息。
 *
 * 之前这里堆过一大套东西——追加渠道 system prompt、删聊天页话术、按结构化列
 * 确定性拼装条目、补固定开场白、按字数裁剪。**全部删掉了**：那些都是在跟模型
 * 较劲，而正确做法是像用户一样跟它说话，需要什么就直接说。
 *
 * 鉴权：默认无鉴权，与同目录其它 /api/xhs 路由一致。设了 XHS_API_TOKEN 才校验
 * X-Xhs-Token —— 这条路由每次要跑两轮带搜索的 agent，被人扫到会烧钱。
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

    // ---- 第一轮：帖子正文原样发过去，什么都不加 ----
    const first = await runChatTurn(
      {
        chatId,
        userId,
        text: rawText.slice(0, MAX_RAW_TEXT_CHARS),
        channel: "xhs",
      },
      { selectedChatModel: modelId, requestHints }
    );

    const hasListings = hasListingResults(first.toolOutputs);

    if (style === "raw") {
      return jsonWithCors({
        ok: true,
        text: first.text,
        chatId,
        identified,
        model: modelId,
        style,
        toolsUsed: first.toolsUsed,
        hasListings,
        chars: codePoints(first.text),
        elapsedMs: Date.now() - startedAt,
      });
    }

    // ---- 第二轮：像用户一样说一句"请缩写至260字符左右" ----
    const second = await runChatTurn(
      {
        chatId,
        userId,
        text: CONDENSE_MESSAGE,
        channel: "xhs",
      },
      { selectedChatModel: modelId, requestHints }
    );

    let condensed =
      dropChatPageTail(toPlainComment(second.text)) ||
      dropChatPageTail(toPlainComment(first.text));
    const toolsUsed = [...first.toolsUsed, ...second.toolsUsed];

    if (codePoints(condensed) > RETRY_ABOVE_CODE_POINTS) {
      const third = await runChatTurn(
        {
          chatId,
          userId,
          text: CONDENSE_AGAIN_MESSAGE,
          channel: "xhs",
        },
        { selectedChatModel: modelId, requestHints }
      );
      const shorter = dropChatPageTail(toPlainComment(third.text));
      // 只在真的更短时才采纳：催完反而更长的情况实测出现过（739 字符）
      if (shorter && codePoints(shorter) < codePoints(condensed)) {
        condensed = shorter;
        toolsUsed.push(...third.toolsUsed);
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
        toolsUsed: [...new Set(toolsUsed)],
        hasListings,
        firstChars: codePoints(first.text),
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
