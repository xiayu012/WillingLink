/**
 * 搜索工具返回值里的 `action` 字段，是**写给聊天页的舞台指示**。
 *
 * 那些句子长这样：
 *   "展示完后告诉用户还可以继续说「继续」（还有 3 个）"
 *   "再问用户是否愿意放宽相应要求"
 *   "先问用户它属于哪个城市或给个地址/邮编，再重搜"
 *   "End with: '如仍不满意，可告诉我具体要求，我再为您调整。'"
 *
 * 在私信/网页里全都成立，因为**有下一轮**。贴进小红书评论区就全部作废：评论区
 * 是一次性的，追问没人回，"说继续"没人能继续。
 *
 * 这就是 comment-reply 长期"不优雅"而 chat engine 一切正常的根因（AGENT_LOG
 * 2026-08-26）。模型对**工具返回值**的服从度远高于 system prompt——system 里写
 * 十遍"不要写结尾邀请"，也顶不过工具结果里那句 "End with: 如仍不满意…"。之前
 * 靠正则删尾巴属于按下葫芦浮起瓢：措辞每次都变，正则加宽到能删掉整条回复，
 * 反而把无结果的那句话删空成了 502。
 *
 * 治本是**不让模型看见那些指示**：状态码（SHOW_LISTINGS / NO_MATCH / …）留着，
 * 它携带的是真实检索状态；后面那串聊天页话术换成评论区的说法。
 *
 * 用法：工具工厂收一个 presentation 参数，在 execute 的出口过一道
 * `shapeToolResult`。chat 模式原样返回，一个字节都不动。
 */

export type ToolPresentation = "chat" | "comment";

/** action 字符串开头的状态码，形如 `SHOW_LISTINGS:`、`NO_MATCH:` */
const STATUS_CODE_RE = /\b([A-Z][A-Z_]{3,})(?=:)/g;

/** 评论区版本的指示，按状态码分类。评论区的共同点：说完就结束，不追问。 */
/**
 * 每条都必须写出钱。**这句话放在工具结果里，比放在 system 里管用得多**——
 * 实测 system 写了"每一行都不能省租金"，模型照样有 1/3 的行只写形容词
 * （"安静安全社区，适合单身国际学生"）。租金是看房人唯一真正拿来做决定的字段。
 */
const MONEY_RULE =
  "每一条都必须写出**具体数字金额**，写在卖点之前；结果里查不到金额的那条写" +
  "「租金面议」。注意「租金包水电网」不算写了金额——那说的是包含项，不是价钱。" +
  "有几条就写几条，**不要为了凑满三条编一条出来**（写「暂无符合的第三位」这种" +
  "占位行是错的，少一条就少一条）。";

const COMMENT_GUIDE: Record<string, string> = {
  SHOW_LISTINGS: `把结果按 system 里的输出格式写成编号列表。${MONEY_RULE}写完最后一条就结束。`,
  SHOW_WANTED: `把结果按 system 里的输出格式写成编号列表。${MONEY_RULE}写完最后一条就结束。`,
  SHOW_RELAXED_WANTED:
    `这些是放宽条件后的结果。**不要提放宽这件事**，照常按编号列表写出来。${MONEY_RULE}写完就结束。`,
  NO_MATCH: "没有符合的。一句话如实说完就结束——不要追问，不要提议放宽条件。",
  NO_RESULTS: "没有可推荐的。一句话如实说完就结束——不要追问。",
  NO_MORE: "已经展示完了。一句话如实说完就结束——不要追问，不要让对方说「继续」。",
  OUT_OF_BAY: "对方要找的地方不在湾区。一句话如实说明我们只收录湾区，就结束。",
  LOCATION_UNKNOWN:
    "有个地点系统查不到在哪。**不要反问对方**（评论区没有下一轮），按其它条件写结果即可。",
  SEARCH_FAILED: "检索出错了。一句话说明暂时查不到，就结束。",
};

const FALLBACK_GUIDE =
  "按 system 里的输出格式作答，说完就结束——评论区没有下一轮，不要追问。";

/**
 * 把 action 里的聊天页话术换成评论区话术，只保留状态码。
 *
 * 一条 action 里可能出现多个状态码（如 LOCATION_UNKNOWN + SHOW_LISTINGS 拼在
 * 一起），全部保留，指示按出现顺序拼。
 */
function toCommentAction(action: string): string {
  const codes = [...new Set(action.match(STATUS_CODE_RE) ?? [])];
  if (codes.length === 0) {
    return FALLBACK_GUIDE;
  }
  const guides = codes.map((c) => COMMENT_GUIDE[c] ?? FALLBACK_GUIDE);
  return codes
    .map((c, i) => `${c}: ${guides[i]}`)
    .join(" ");
}

/**
 * 工具结果出口的统一整形。
 *
 * @param result 工具本来要返回的对象
 * @param presentation 目标渠道；`chat` 原样放行
 */
export function shapeToolResult<T extends Record<string, unknown>>(
  result: T,
  presentation: ToolPresentation
): T {
  if (presentation === "chat") {
    return result;
  }

  const shaped: Record<string, unknown> = { ...result };

  if (typeof shaped.action === "string") {
    shaped.action = toCommentAction(shaped.action);
  }

  // relaxedNote 是一句**给用户看的原话**（"找不到完全符合要求的，已放宽关键词，
  // 先给你看一条"）。模型见了就会原样贴进评论里——实测 49 例里有一条整段回复
  // 就只有这句话。评论区不需要解释检索过程，直接不给它看。
  if ("relaxedNote" in shaped) {
    shaped.relaxedNote = null;
  }

  return shaped as T;
}

/**
 * 给已经建好的 tool 对象套一层出口整形。
 *
 * searchRental 有严格版和 legacy 版两个工厂（legacy 是 CLAUDE.md 里明说要保留的
 * 回退路径），逐个改 execute 会改两遍、还容易漏。包一层对两个都生效。
 */
export function withPresentation<
  T extends { execute?: (...args: never[]) => unknown },
>(baseTool: T, presentation: ToolPresentation): T {
  if (presentation === "chat" || typeof baseTool.execute !== "function") {
    return baseTool;
  }
  const inner = baseTool.execute.bind(baseTool);
  return {
    ...baseTool,
    execute: async (...args: never[]) => {
      const result = await inner(...args);
      return result && typeof result === "object"
        ? shapeToolResult(result as Record<string, unknown>, presentation)
        : result;
    },
  };
}
