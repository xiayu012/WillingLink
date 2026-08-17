import { randomUUID } from "node:crypto";
import { geolocation } from "@vercel/functions";
import { generateText, stepCountIs } from "ai";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { findNearestTransit } from "@/lib/ai/tools/find-nearest-transit";
import { getTransitTime } from "@/lib/ai/tools/get-transit-time";
import { queryListings } from "@/lib/ai/tools/query-listings";
import { createSearchRentalTool } from "@/lib/ai/tools/search-rental";
import { createSearchWantedTool } from "@/lib/ai/tools/search-wanted";
import { stripMemoryFromDisplay } from "@/lib/utils";

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

/**
 * 输出渠道说明。聊天页的回答是 Markdown、可以很长、可以带图；小红书评论区
 * 是纯文本框，Markdown 会原样露出星号和方括号，链接也点不动。所以除了系统
 * 提示词本身（搜索工具怎么用、房源怎么组织、绝不编造）全部照旧之外，只额外
 * 追加这一段渠道约束。style="raw" 时不追加，拿到的就是聊天页原味回答。
 */
const COMMENT_CHANNEL_SECTION = `## 本次输入是一条帖子，输出去评论区（硬规则，覆盖上面的角色推断与排版要求）

用户消息里的文字**不是有人在跟你说话**，而是小红书上一条帖子的正文原文（可能带话题标签和表情）。你的回答会被**原样粘贴到这条帖子的评论区**，读者是发帖人本人。所以第一步先判断帖子类型，再决定做什么：

- **求租帖**（发帖人自己在找房）→ 把帖子里的条件当成 ta 的需求，调 searchRental，用真实找到的房源回复 ta。
- **招租帖**（发帖人有房要出租/转租/招室友）→ 调 searchWanted，把合适的求租者介绍给 ta。**绝不能**把招租帖里的房源条件当成 ta 的找房需求去调 searchRental。
- **经验帖/科普/吐槽/与租房无关** → **不调任何工具，一条房源都不要提**，只写一两句真诚的评论。宁可什么都不推荐，也不能凭空编出房源。

排版要求：

- **纯文本**：不要任何 Markdown —— 不要 \`**\`、\`#\`、\`-\`、表格、\`[文字](链接)\`、\`![](图片)\`。需要分隔就用换行和「｜」。
- **不要输出任何网址**：评论区里链接点不动，贴出来只是噪音。想让对方看原帖或更多房源，就请对方私信。
- **最多 3 条**：无论工具返回几条房源（searchRental）或几个求租者（searchWanted），都只挑最匹配的 3 条写进评论（这条覆盖上面"显示每一条"的要求）。每条压缩成 **1 行**：标题｜租金｜房型｜位置｜可入住时间，条与条之间空一行。**不要**逐字段分行（"期望位置: ……""预算: ……"），**不要**贴原文简介。
- **开场白只有固定的一行**：\`看看这些怎么样：\`——一字不改，不要在它前面加任何话，也不要换成别的说法。房源和求租者都用这一行开头。
- 缺的字段**直接不写**，别写"价格未知""可入住时间未知""月租面议"——评论区字数金贵，占位词纯属浪费，"面议"更是帖子没说过的话。
- **三条必须是三个不同的**：库里有重复入库的近似帖，标题或地址一样的只留一条，凑不满就少写一条。
- **不要结尾**：最后一条写完就结束。禁止任何总结句、点评句、邀请私信、祝福语（"这些房源都在……""通勤方便""可以私信我""祝你早日找到理想的家"这类一句都不许有）。
- **全文 260 个字符左右**（240-280，含标点换行）。写不下就少放一条，而不是把每条压成半句。
- **工具 action 里的引导语一律不要照抄**："已放宽关键词""找不到完全符合要求的，先给你看一条""如仍不满意，可告诉我具体要求，我再为您调整""换一个"——这些是聊天页话术，评论区没有下一轮，照抄会露馅。同样不要暴露"数据库""工具""搜索结果""action"这类系统内部说法，像一个真人邻居在回帖。
- 没有匹配上、或者这是经验帖不该推荐时：**不要写那行固定开场白**，只用一两句如实说明，**绝不编造**。`;

/** 固定开场白：用户要求一字不差，所以不靠模型自觉，落地时兜一道。 */
const FIXED_OPENING = "看看这些怎么样：";

/**
 * 聊天页话术的兜底清理。
 *
 * prompt 里已经禁了，但 searchWanted（仍是旧的"换一个"级联）会把
 * "已放宽关键词…先给你看一条""如仍不满意，可告诉我具体要求，我再为您调整"
 * 这类引导语直接写进 action 字段，模型照抄的概率很高——两条指令打架时它听
 * 工具的。这些话在评论区一句都不成立，所以按字面删掉，不指望模型自觉。
 *
 * 注意只删"放宽/先给你看一条"这种级联话术；"目前没有完全符合的房源"是我们
 * 要保留的如实回答，不能一起删掉。
 */
const RELAXED_LEAD_RE = /放宽|先给你看一条/;
const CHAT_PAGE_TAIL_RE =
  /如仍不满意|如需换一个|我再重新筛选|再为您调整|如需调整条件/;

function stripChatPageBoilerplate(text: string): string {
  const lines = text.split("\n");

  const firstIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstIdx >= 0 && RELAXED_LEAD_RE.test(lines[firstIdx])) {
    lines.splice(firstIdx, 1);
  }

  // 库里有重复入库的近似帖，模型偶尔会把同一条房源写两遍；一模一样的行留一条。
  const seen = new Set<string>();

  return lines
    .filter((line) => !CHAT_PAGE_TAIL_RE.test(line))
    .filter((line) => {
      const key = line.trim();
      if (key.length === 0) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 只要真的在列条目（用「｜」分隔的行），就保证开头是那句固定开场白。 */
function ensureFixedOpening(text: string): string {
  if (!text.includes("｜") || text.startsWith(FIXED_OPENING)) {
    return text;
  }
  return `${FIXED_OPENING}\n\n${text}`;
}

/** 模型偶尔仍会漏出 Markdown 记号；粘进评论框前做一次无损清理。 */
function toPlainComment(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function optString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 油猴脚本复制正文后调这里：把正文当成"用户在聊天页发的一条消息"跑一遍项目
 * AI（同一套 system prompt、同一批工具），把最终文字回给脚本粘到评论区。
 *
 * 鉴权：默认无鉴权，与同目录其它 /api/xhs 路由一致。设了 XHS_API_TOKEN 环境
 * 变量就必须带 X-Xhs-Token 头 —— 这个路由每次调用会跑一轮带搜索的 agent，
 * 比 rental-ingest 贵得多，被人扫到会烧钱。
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

  const style = payload.style === "raw" ? "raw" : "comment";
  const modelId =
    optString(payload.model) ??
    process.env.XHS_COMMENT_REPLY_MODEL?.trim() ??
    DEFAULT_CHAT_MODEL;

  // 每次请求一个独立会话 id：searchRental 的批次缓存按它分区，不同帖子之间
  // 不会串批，也不会污染真实用户的聊天会话。
  const chatId = randomUUID();
  const { longitude, latitude, city, country } = geolocation(request);
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model: getLanguageModel(modelId),
      system:
        style === "comment"
          ? `${systemPrompt({ requestHints: { longitude, latitude, city, country } })}\n\n${COMMENT_CHANNEL_SECTION}`
          : systemPrompt({
              requestHints: { longitude, latitude, city, country },
            }),
      messages: [
        {
          role: "user",
          content: rawText.slice(0, MAX_RAW_TEXT_CHARS),
        },
      ],
      stopWhen: stepCountIs(5),
      tools: {
        searchRental: createSearchRentalTool(chatId),
        searchWanted: createSearchWantedTool(chatId),
        queryListings,
        findNearestTransit,
        getTransitTime,
      },
    });

    // 工具调用收尾那一步偶尔不带文字，取最后一段非空文本兜底。
    const rawAnswer =
      result.text.trim() ||
      result.steps
        .map((step) => step.text.trim())
        .filter(Boolean)
        .at(-1) ||
      "";

    const stripped = stripMemoryFromDisplay(rawAnswer);
    const text =
      style === "comment"
        ? ensureFixedOpening(
            stripChatPageBoilerplate(toPlainComment(stripped))
          )
        : stripped;

    if (!text) {
      return jsonWithCors({ ok: false, error: "Model returned no text" }, 502);
    }

    const toolsUsed = [
      ...new Set(
        result.steps.flatMap((step) =>
          step.toolCalls.map((call) => call.toolName)
        )
      ),
    ];

    console.log(
      "[comment-reply]",
      JSON.stringify({
        model: modelId,
        style,
        toolsUsed,
        chars: [...text].length,
        elapsedMs: Date.now() - startedAt,
        sourceUrl: optString(payload.sourceUrl),
      })
    );

    return jsonWithCors({
      ok: true,
      text,
      model: modelId,
      style,
      toolsUsed,
      chars: [...text].length,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    // AI SDK 的错误对象直接丢给 console.error 会让 util.inspect 自身抛异常
    // （见 .claude/AGENT_LOG.md 的 fail-open 事故），只打名字和消息。
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    console.log("[comment-reply] failed", `${name}: ${message}`);
    return jsonWithCors({ ok: false, error: `AI reply failed: ${name}` }, 502);
  }
}
