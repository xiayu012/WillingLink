import { geolocation } from "@vercel/functions";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { resolveChatIdForUser } from "@/lib/chat/conversation";
import { runChatTurn } from "@/lib/chat/engine";
import { ChannelTableMissingError, resolveInternalUserId } from "@/lib/chat/identity";
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
- **最多 3 条**：无论工具返回几条房源（searchRental）或几个求租者（searchWanted），都只挑最匹配的 3 条写进评论（这条覆盖上面"显示每一条"的要求）。每条一段：标题｜租金｜房型｜位置｜可入住时间｜这条为什么值得看，条与条之间空一行。**不要**逐字段分行（"期望位置: ……""预算: ……"），**不要**贴原文简介。
- **每条都要写足信息**：租金、房型、具体位置、可入住时间、包水电/车位/家具这些只要工具给了就写进去。**这一步不用担心太长**，后面有专门一步负责压到评论区的长度——你写得越全，压完留下的信息越多；你写得干瘪，压完就只剩几个词。
- **开场白只有固定的一行**：\`看看这些怎么样：\`——一字不改，不要在它前面加任何话，也不要换成别的说法。房源和求租者都用这一行开头。
- 缺的字段**直接不写**，别写"价格未知""可入住时间未知""月租面议"——评论区字数金贵，占位词纯属浪费，"面议"更是帖子没说过的话。
- **三条必须是三个不同的**：库里有重复入库的近似帖，标题或地址一样的只留一条，凑不满就少写一条。
- **不要结尾**：最后一条写完就结束。禁止任何总结句、点评句、邀请私信、祝福语（"这些房源都在……""通勤方便""可以私信我""祝你早日找到理想的家"这类一句都不许有）。
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

  // 同一条写两遍要去掉，两种来源都见过：库里有重复入库的近似帖；补字数那一遍
  // 会把唯一一条素材改写成三条凑长度。所以判重看**「｜」前的标题**，不是整行
  // ——重复行往往只是后半段措辞不同。
  const seen = new Set<string>();

  const kept = lines
    .filter((line) => !CHAT_PAGE_TAIL_RE.test(line))
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return true;
      }
      // 有分隔符就按标题判重；模型偶尔不写分隔符，那就拿前 20 个字符当标题
      // ——库里那些重复入库的近似帖，开头往往一模一样，只有后半段措辞不同。
      const key = trimmed.includes("｜")
        ? trimmed.slice(0, trimmed.indexOf("｜")).trim()
        : [...trimmed].slice(0, 20).join("");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return stripTrailingProse(kept).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 删掉结尾的总结句。
 *
 * 用户要的是"最后一条房源写完就结束"，但模型总忍不住补一句
 * "这些房源符合您对水电网煤全包、有停车位……的需求。可继续告诉我是否调整条件。"
 * 这种话千变万化，穷举关键词是打地鼠，所以改判结构：条目行一定含「｜」，
 * 从末尾往前，**在出现过条目行之后**的无「｜」行一律是散文收尾，删掉。
 * 只从尾部删，中间不动，避免误伤。
 */
function stripTrailingProse(lines: string[]): string[] {
  if (!lines.some((line) => line.includes("｜"))) {
    return lines;
  }
  const out = [...lines];
  while (out.length > 0) {
    const last = out.at(-1)?.trim() ?? "";
    if (last.length === 0 || !last.includes("｜")) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/**
 * 最后一道确定性闸门：缩写那一轮偶尔压不到位（实测回过 363 字符）。
 * 按空行切块，从**末尾整块整块地丢**，直到落进上限——丢的是整条房源，不会把
 * 某一条截成半句，也不会动开场白和第一条。模型压不动就少推一条，这是能给的
 * 最诚实的处理。
 */
function trimToBudget(text: string): string {
  if (codePoints(text) <= MAX_CODE_POINTS) {
    return text;
  }
  const blocks = text
    .split(/\n\s*\n/)
    .filter((block) => block.trim().length > 0);
  while (
    blocks.length > 2 &&
    codePoints(blocks.join("\n\n")) > MAX_CODE_POINTS
  ) {
    blocks.pop();
  }
  return blocks.join("\n\n");
}

/** 只要真的在列条目（用「｜」分隔的行），就保证开头是那句固定开场白。 */
function ensureFixedOpening(text: string): string {
  if (!text.includes("｜") || text.startsWith(FIXED_OPENING)) {
    return text;
  }
  return `${FIXED_OPENING}\n\n${text}`;
}

const TARGET_CODE_POINTS = 260;
const MIN_CODE_POINTS = 235;
const MAX_CODE_POINTS = 285;

const codePoints = (text: string) => [...text].length;

/**
 * 把工具真正查到的条目摘出来当"素材库"。
 *
 * 补字数这一步必须有素材：模型第一遍常常把 8 条房源压成 90 字。素材里全是库里
 * 的真实字段，凑字数就是把这些已有信息铺开，不是无中生有。
 */
const MATERIAL_FIELDS = [
  "title",
  "rent",
  "deposit",
  "bedrooms",
  "bathrooms",
  "roomType",
  "locationText",
  "propertyName",
  "city",
  "availableFrom",
  "leaseEndDate",
  "furnished",
  "listingType",
  "petFriendly",
  "couplesOk",
  "utilitiesIncluded",
  "parkingIncluded",
  "preferredLocations",
  "budgetText",
  "moveInDate",
  "leaseDuration",
  "wantedType",
  "occupation",
  "householdSize",
  "requirements",
] as const;

type MaterialRow = Record<string, unknown>;

function collectMaterial(outputs: unknown[]): MaterialRow[] {
  const rows: MaterialRow[] = [];

  {
    for (const output of outputs) {
      if (!output || typeof output !== "object") {
        continue;
      }
      const items =
        (output as { listings?: unknown }).listings ??
        (output as { wanted?: unknown }).wanted;
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items.slice(0, 6)) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const row: MaterialRow = {};
        for (const field of MATERIAL_FIELDS) {
          const value = (item as Record<string, unknown>)[field];
          if (value !== null && value !== undefined && value !== "") {
            row[field] = value;
          }
        }
        if (Object.keys(row).length > 0) {
          rows.push(row);
        }
      }
    }
  }

  return rows;
}

/**
 * 这些列里存的是给机器看的值，直接印进评论区就是一行天书（真出现过
 * "｜rent""｜yes"）。列本身还带着历史脏数据（见 AGENT_LOG 的入库现实），
 * 所以取值时统一挡一道。
 */
const JUNK_VALUES = new Set([
  "null",
  "undefined",
  "yes",
  "no",
  "true",
  "false",
  "unknown",
  "n/a",
  "none",
  "rent",
  "wanted",
  "listing",
  "待定",
  "未知",
  "面议",
]);

const str = (value: unknown): string | null => {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0 || JUNK_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
};

/** 金额类字段必须带数字，否则就是脏数据（"rent"、"面议"这种）。 */
const money = (value: unknown): string | null => {
  const text = str(value);
  return text && /\d/.test(text) ? text : null;
};

const cut = (value: string | null, max: number) =>
  value && [...value].length > max ? `${[...value].slice(0, max).join("")}…` : value;

/** 房型：兼容房源（bedrooms/bathrooms/roomType）和求租（wantedType）两种行。 */
function shapeSegment(row: MaterialRow): string | null {
  const bed = str(row.bedrooms);
  const bath = str(row.bathrooms);
  const room = str(row.roomType) ?? str(row.wantedType);
  const size = [bed && `${bed}室`, bath && `${bath}卫`].filter(Boolean).join("");
  return [size, room].filter(Boolean).join(" ") || null;
}

function tagSegment(row: MaterialRow): string | null {
  const tags = [
    row.utilitiesIncluded === true && "包水电",
    row.parkingIncluded === true && "有车位",
    row.petFriendly === true && "宠物友好",
    row.couplesOk === true && "情侣可",
  ].filter((tag): tag is string => typeof tag === "string");
  return tags.length > 0 ? tags.join(" ") : null;
}

/**
 * 一条目的可选片段，按重要性排序。凑字数时从前往后逐轮加，加到接近目标长度
 * 为止——**每一段都是库里的真实字段**，没有任何生成成分。
 */
const SEGMENT_BUILDERS: ((row: MaterialRow) => string | null)[] = [
  (row) => {
    // 房源写租金，求租帖写预算——标签不同，别把求租者的预算说成租金。
    const rent = money(row.rent);
    const budget = rent ? null : money(row.budgetText);
    const value = rent ?? budget;
    if (!value) {
      return null;
    }
    if (/[$￥刀元月]|\/mo/i.test(value)) {
      return value;
    }
    return budget ? `预算${value}` : `租金${value}`;
  },
  shapeSegment,
  // 截断上限放宽：真正的长度闸门是下面按预算逐段加的循环，加不下就整段不加，
  // 不该在这里先切成 "San Jose, Palo Alto, Mount…" 那样的半截地名。
  (row) =>
    cut(str(row.locationText) ?? str(row.preferredLocations) ?? str(row.city), 60),
  (row) => {
    const from = str(row.availableFrom) ?? str(row.moveInDate);
    return from && (/入住|起租|可租/.test(from) ? from : `${from}可入住`);
  },
  tagSegment,
  (row) => {
    const lease = str(row.leaseDuration);
    if (lease) {
      return /租/.test(lease) ? lease : `租期${lease}`;
    }
    const until = str(row.leaseEndDate);
    return until && `租至${until}`;
  },
  (row) => {
    // 押金列里也有 "1-month security deposit" 这类叙述，读起来像半句英文；
    // 只收真正的金额。
    const deposit = money(row.deposit);
    return deposit && /[$￥刀元]|^\d[\d,.]*$/.test(deposit)
      ? `押金${deposit}`
      : null;
  },
  // propertyName 不进评论：这一列在库里大多不是小区名，而是 "Center"、
  // "single family house"、"for rent in Sunnyvale 94087" 这类碎片，印出来是噪音。
  (row) => cut(str(row.requirements), 30),
];

const titleKey = (row: MaterialRow) => cut(str(row.title), 10) ?? "";

/** 草稿里已经挑好的条目优先；对不上就按工具给的相关度顺序取前几条。 */
function pickRows(draft: string, rows: MaterialRow[]): MaterialRow[] {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = titleKey(row) || JSON.stringify(row).slice(0, 40);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const inDraft = unique.filter((row) => {
    const head = str(row.title)?.slice(0, 8);
    return head ? draft.includes(head) : false;
  });

  // 草稿挑中的排前面，不够 3 条再按工具给的相关度顺序补齐——补进来的同样是
  // 过了严格筛选和终审的行，不是凑数用的次品。
  const ordered = [...inDraft, ...unique.filter((row) => !inDraft.includes(row))];
  return ordered.slice(0, 3);
}

/**
 * 缩写指令。**这是发给项目 AI 的一条用户消息**，不是另起炉灶的第二个系统提示词
 * ——用户要的是"跟项目 AI 聊天说要缩写到 260 字符"，所以它就是同一条会话里的
 * 下一轮，模型看得见自己上一条回复，也留在聊天记录里。
 */
function condenseInstruction(currentChars: number): string {
  return `刚才那条评论 ${currentChars} 个字符，太长了，发不进小红书评论区。请把它压到 ${TARGET_CODE_POINTS} 个字符左右（${MIN_CODE_POINTS}-${MAX_CODE_POINTS}）。

- **${MIN_CODE_POINTS}-${MAX_CODE_POINTS} 之间才算合格，太短一样不行**：压到 ${TARGET_CODE_POINTS} 附近就停手，别一路砍到只剩几十个字。字数没用满就把每条写细一点（把租金、房型、位置、时间、包水电/车位/家具这些补回去）。
- 这是压缩不是重写：每条的关键信息尽量留住，删的是虚词和客套。
- 第一行仍然固定是：${FIXED_OPENING}
- 之后每条一行，格式仍然是 标题｜租金｜房型｜位置｜可入住时间｜亮点（**保留「｜」分隔**），最多 3 条，条与条之间空一行。
- **不许新增任何刚才没出现过的事实**，一个租金、一个地址都不许编；写不下就少放一条。
- 不要重复同一条，不要写"未知""面议"这类占位词。
- 结尾不要任何总结、点评、邀请私信或祝福，最后一条写完就结束。
- 只输出压缩后的评论正文。`;
}

/**
 * 把条目行按真实字段拼到 260 上下——**确定性拼装，不过 LLM**。
 *
 * 两条都是实测逼出来的：
 * 1. 试过让 gpt-4.1-mini 拿着素材"改写到 260 字"，它在素材只有 1 条时直接**编出
 *    两条不存在的房源**（连租金和"社区配备游泳池"都编了）。凑字数的压力必然压过
 *    "不许编造"的指令，这条路堵死。
 * 2. 只在字数越界时才接管也不行：模型自己写的行里混着 "rent unknown""月租面议"
 *    "month-to-month" 这种从脏字段直译过来的垃圾，长度恰好达标时就原样发出去了。
 *
 * 所以**只要工具真的查到了条目，条目区就一律由这里拼**：模型负责判断帖子类型、
 * 调对工具、挑中哪几条（pickRows 沿用它的选择），排版和取值归我们。每加一段都是
 * 库里有的值，加到接近上限为止；素材不够就短——短了没关系，编造不行。
 */
function buildToTargetLength(
  draft: string,
  rows: MaterialRow[]
): { text: string; rebuilt: boolean } {
  const picked = pickRows(draft, rows);
  if (picked.length === 0) {
    // 经验帖、无匹配：本来就没条目可列，模型那两句如实回答原样返回。
    return { text: draft, rebuilt: false };
  }

  const titles = picked.map((row) => cut(str(row.title), 40) ?? "房源");
  const segments = picked.map((row) =>
    SEGMENT_BUILDERS.map((build) => build(row)).filter(
      (segment): segment is string => Boolean(segment)
    )
  );
  const taken = picked.map(() => 0);

  const render = () =>
    [
      FIXED_OPENING,
      ...titles.map((title, index) =>
        [title, ...segments[index].slice(0, taken[index])].join("｜")
      ),
    ].join("\n\n");

  // 轮流给每条加一段，长度均匀，不会第一条很详细后面两条光秃秃
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = 0; index < picked.length; index += 1) {
      if (taken[index] >= segments[index].length) {
        continue;
      }
      taken[index] += 1;
      if (codePoints(render()) > MAX_CODE_POINTS) {
        taken[index] -= 1;
        return { text: render(), rebuilt: true };
      }
      progressed = true;
    }
  }

  return { text: render(), rebuilt: true };
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

  // 帖主身份：油猴从详情页 DOM 里抓的（.author-wrapper 里的 profile 链接和昵称）
  const authorId = optString(payload.authorId);
  const authorName = optString(payload.authorName);

  const { longitude, latitude, city, country } = geolocation(request);
  const requestHints = { longitude, latitude, city, country };
  const startedAt = Date.now();

  try {
    // ---- 会话：帖主是一个渠道身份，评论就发生在跟 ta 的那条 conversation 里 ----
    // 认得出帖主 → 进真实会话（以后 ta 从私信/短信找过来，接的是同一串上下文）；
    // 认不出（老版本油猴没传） → 建一条一次性会话，行为跟以前一样，不阻塞。
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

    // ---- 第一轮：把帖子正文当成这条会话里的一条用户消息 ----
    const first = await runChatTurn(
      {
        chatId,
        userId,
        text: rawText.slice(0, MAX_RAW_TEXT_CHARS),
        channel: "xhs",
      },
      {
        selectedChatModel: modelId,
        requestHints,
        extraSystem: style === "comment" ? COMMENT_CHANNEL_SECTION : undefined,
      }
    );

    const draft =
      style === "comment"
        ? ensureFixedOpening(stripChatPageBoilerplate(toPlainComment(first.text)))
        : first.text;

    const material = style === "comment" ? collectMaterial(first.toolOutputs) : [];

    if (!draft && material.length === 0) {
      return jsonWithCors({ ok: false, error: "Model returned no text" }, 502);
    }

    // ---- 第二轮：太长就在**同一条会话里**跟它说"缩写到 260" ----
    // 这一句和它的回答都会留在聊天记录里，跟人在聊天页说"太长了压一压"没区别。
    let text = draft;
    let condensed = false;
    let rebuilt = false;
    const toolsUsed = [...first.toolsUsed];

    if (style === "comment") {
      if (draft && codePoints(draft) > MAX_CODE_POINTS) {
        const second = await runChatTurn(
          {
            chatId,
            userId,
            text: condenseInstruction(codePoints(draft)),
            channel: "xhs",
          },
          {
            selectedChatModel: modelId,
            requestHints,
            extraSystem: COMMENT_CHANNEL_SECTION,
          }
        );
        const shorter = ensureFixedOpening(
          stripChatPageBoilerplate(toPlainComment(second.text))
        );
        if (shorter) {
          text = shorter;
          condensed = true;
          toolsUsed.push(...second.toolsUsed);
        }
      } else if (!draft) {
        // 模型调完工具就收工、一个字没写：条目还在手上，按真实字段拼一条
        const built = buildToTargetLength(draft, material);
        text = built.text;
        rebuilt = built.rebuilt;
      }
    }

    if (style === "comment") {
      text = trimToBudget(text);
    }

    if (!text) {
      return jsonWithCors({ ok: false, error: "Model returned no text" }, 502);
    }

    // 油猴要据此决定后面还走不走评论那一步：没房源就别占剪贴板、别框评论框，
    // 直接跳到分享。
    //
    // 判据只看**固定开场白 + 后面确实有内容行**，不看「｜」：提示词说了没房源
    // 时不许写那行开场白，所以它就是最可靠的信号。曾经把"含｜"也当必要条件，
    // 结果模型某次没用分隔符写了三条真房源，hasListings 被判成 false，
    // 整个评论步骤被白白跳过——排版走样不该等于"没有房源"。
    const hasListings =
      text.startsWith(FIXED_OPENING) &&
      text.slice(FIXED_OPENING.length).trim().length > 0;

    console.log(
      "[comment-reply]",
      JSON.stringify({
        model: modelId,
        style,
        chatId,
        identified,
        authorId,
        toolsUsed: [...new Set(toolsUsed)],
        hasListings,
        chars: codePoints(text),
        draftChars: codePoints(draft),
        condensed,
        rebuilt,
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
      condensed,
      rebuilt,
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
