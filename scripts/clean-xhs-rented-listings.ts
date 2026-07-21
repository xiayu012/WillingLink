import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";
import {
  type CheckedLog,
  forgetChecked,
  isWithinCooldown,
  loadCheckedLog,
  priorityTimestamp,
  pruneCheckedLog,
  recordCheckedResult,
  saveCheckedLog,
  summarizeCheckedLog,
} from "./lib/xhs-checked-log";

loadDotenv({ path: ".env.local" });
loadDotenv();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_LIMIT = 800;
const DEFAULT_MIN_DELAY_SECONDS = 45;
const DEFAULT_MAX_DELAY_SECONDS = 171;
const DEFAULT_COOLDOWN_HOURS = 18;
const DEFAULT_BLOCK_PAUSE_MIN_MINUTES = 60;
const DEFAULT_BLOCK_PAUSE_MAX_MINUTES = 180;
const ERROR_BACKOFF_THRESHOLD = 3;
const PAGE_TIMEOUT_MS = 45_000;
const CONTENT_TIMEOUT_MS = 20_000;
const BLOCK_DETECT_MIN_WAIT_MS = 800;
const BLOCK_DETECT_MAX_WAIT_MS = 1500;
const PROFILE_DIR = join(
  process.cwd(),
  ".playwright",
  "xhs-rental-cleaner-profile"
);
const DEFAULT_LOG_PATH = join(
  process.cwd(),
  ".playwright",
  "xhs-rental-checked-log.json"
);
const XHS_URL_PATTERN = "%xiaohongshu.com%";
const XHSLINK_URL_PATTERN = "%xhslink.com%";

const RENTED_PATTERNS = [
  /已\s*(?:出租|租出|租掉|出掉|租走|被租)/u,
  /(?:已经|已經|己经)\s*(?:出租|租出|租掉|出掉|租走|被租|没有了|沒了|没了)/u,
  /(?:房子|房间|房間|房源|卧室|臥室|这间|這間).{0,12}(?:已|已经|已經).{0,12}(?:租|出)/u,
  /(?:租|出).{0,4}(?:掉了|出去了|走了)/u,
  /(?:房子|房间|房間|房源|卧室|臥室).{0,12}(?:没有了|沒了|没了|暂无|暫無)/u,
  // 标题/正文里常见的短标签，如「【已租】」「[已租]」，"已"后面只跟单字"租"就结束
  /(?:^|[[【(（])\s*已\s*租\s*(?:[\]】)）]|$)/u,
] as const;

const QUESTION_OR_UNCERTAIN_PATTERN =
  /(?:吗|嗎|嘛|\?|？|请问|請問|还有|還有|还在|還在|还没|還沒|有没有|有沒有)/u;

const UNAVAILABLE_CONTENT_PATTERN = /该内容暂时无法查看/u;
const UNAVAILABLE_TOAST_POLL_MS = 300;
const UNAVAILABLE_TOAST_WINDOW_MS = 15_000;

const BLOCK_OR_LOGIN_PATTERN =
  /(扫码登录|登录后查看更多|请先登录|完成验证后继续访问|请完成验证|访问(?:过于|太)频繁|操作(?:过于|太)频繁|异常访问|网络异常，请稍后重试)/u;

const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";
const DEFAULT_AI_MODEL = "gpt-5.6-terra";
const DEFAULT_AI_MIN_CONFIDENCE = 0.7;
const AI_JUDGE_TIMEOUT_MS = 30_000;
const MIN_EVIDENCE_QUOTE_LENGTH = 2;

const AI_JUDGE_SYSTEM_PROMPT = `你是小红书租房帖状态判断器，负责判断房源当前是否已经确定不可租（已出租/已租出/租满/下架等）。你的判断会直接触发删除数据库记录，这个操作不可撤销：错判"已出租"（把还能租的房源删掉）的代价，远大于错判"未出租"（把已经租出去的房源留着多检查几次）。所以必须非常谨慎、保守，宁可漏判，不能错判。

你会看到：今天日期、帖子发布/编辑时间、标题、正文，以及作者本人在评论区的发言和对应日期（评论区已经提前排除了所有路人发言，你看到的评论全部是作者本人说的话，可以直接当作房东自己的话来用，不用怀疑是路人）。

【绝对禁止的两种错误推理】（过去已经因为这两种推理错删过还在出租的房源，务必避免）：
1. 禁止用"日期已经过去"来反推房源已经出租。比如正文写"入住截止到7月17日"，检查时是7月20日——这只能说明"帖子里写的这个日期已经过去了"，不能因此推断房源租出去了，也不能因此把作者当时的"可以""好的"之类的简短回复曲解成"没有房间了"的暗示。日期信息只能用来判断"多条信息里哪条更新"，永远不能单独作为已出租的证据。
2. 禁止把模糊、双关、需要脑补才能理解的用词当作已出租的证据，常见的坑：
   - "出" 单独出现（不是"已出""出了""出掉"），一般是回应别人"是不是在出租"的确认词，意思是"对，这个在出租/出售中"，跟"已经出租完毕"完全相反，不能当证据。
   - "私你了"/"私您了"/"已私信"/"已经加你了"，表示作者主动私信联系了对方，只是在跟进咨询，跟房源是否已经租出完全无关。
   - "可以"/"好的"/"在"/"嗯"/"是的" 等简短确认词，本身不包含任何关于房源状态的信息，不能单独作为证据。

【判断规则】
- 只有当标题、正文或某条作者评论里，存在一段可以逐字摘出来的原文，而且这段原文本身（不需要你做任何额外推理、不需要联想上下文）就清楚地表达"已经出租/卖出/租满/下架"的完成语气（例如"已出租""已经租出去了""租出去了""租掉了""租满了""没有房间了""客满""下架"，或者独立的"已出""【已出】""[已出]"），才能判定为已出租。
- 找到证据后，把这段原文一字不改地填进 evidenceQuote 字段；如果找不到符合上述标准的原文，直接判定为未出租，evidenceQuote 填空字符串 ""。
- 如果多条信息互相矛盾，只用发布/编辑时间和评论日期判断"哪条信息更新"，采信更新的那条；但仍然要求那条更新的信息本身包含上面说的明确已出租原文，才能判定为已出租，光靠"这条更新所以应该更可信"这种推理本身不算证据。
- 找不到明确证据时，一律判定为未出租（仍然可租）。

只输出 JSON，格式为：
{"rented": boolean, "confidence": 0到1之间的数字, "reason": "一句话原因", "evidenceQuote": "你依据的逐字原文，找不到证据时填空字符串"}
不要输出任何其它文字。`;

type ListingRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
};

type ElementTexts = {
  title: string;
  noteContent: string;
  comments: string;
};

type AuthorComment = {
  text: string;
  date: string;
};

/** 判断已出租时需要的完整时间上下文：帖子编辑/发布时间 + 每条作者本人评论各自的日期。 */
type ListingContext = {
  title: string;
  noteContent: string;
  postDate: string;
  authorComments: AuthorComment[];
};

type DeleteSignal =
  | {
      kind: "rented";
      element: keyof ElementTexts;
      snippet: string;
      pattern: string;
    }
  | {
      kind: "unavailable";
      snippet: string;
    }
  | {
      kind: "ai";
      reason: string;
      confidence: number;
    };

type AiJudgement = {
  rented: boolean;
  confidence: number;
  reason: string;
  evidenceQuote: string;
};

type AiJudgeConfig = {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  minConfidence: number;
};

type ScheduledCandidates = {
  candidates: ListingRow[];
  log: CheckedLog;
  totalActive: number;
  activeIds: string[];
};

/** 命中疑似风控/登录墙时抛出，让调用方整体暂停而不是当作单条检查失败。 */
class XhsBlockedError extends Error {
  readonly snippet: string;

  constructor(snippet: string) {
    super(`检测到疑似风控/登录墙：${snippet}`);
    this.name = "XhsBlockedError";
    this.snippet = snippet;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function envNumber(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue || rawValue.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name];
  if (!rawValue || rawValue.trim().length === 0) {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(
    rawValue.trim().toLowerCase()
  );
}

function envString(name: string, fallback: string): string {
  const rawValue = process.env[name];
  if (!rawValue || rawValue.trim().length === 0) {
    return fallback;
  }
  return rawValue.trim();
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ignoreOptionalError(): void {
  // 小红书页面有些区域会按登录状态或懒加载缺失，缺失时继续检查已拿到的文本。
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return text.slice(start, end).trim();
}

function findRentedSignalByRule(texts: ElementTexts): DeleteSignal | null {
  const entries = Object.entries(texts) as [keyof ElementTexts, string][];

  for (const [element, rawText] of entries) {
    const text = normalizeVisibleText(rawText);
    if (text.length === 0) {
      continue;
    }

    for (const pattern of RENTED_PATTERNS) {
      const match = pattern.exec(text);
      if (!match || match.index === undefined) {
        continue;
      }

      const snippet = snippetAround(text, match.index, match[0].length);
      if (QUESTION_OR_UNCERTAIN_PATTERN.test(snippet)) {
        continue;
      }

      return {
        kind: "rented",
        element,
        snippet,
        pattern: pattern.source,
      };
    }
  }

  return null;
}

function formatDeleteSignal(signal: DeleteSignal): string {
  if (signal.kind === "unavailable") {
    return `内容不可查看：${signal.snippet}`;
  }

  if (signal.kind === "ai") {
    return `AI 判断已出租（置信度 ${signal.confidence.toFixed(2)}）：${signal.reason}`;
  }

  return `规则命中已出租 ${signal.element}：${signal.snippet}`;
}

function parseAiJudgement(raw: unknown): AiJudgement | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.rented !== "boolean") {
    return null;
  }

  const confidence =
    typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.min(1, Math.max(0, value.confidence))
      : 0.5;
  const reason =
    typeof value.reason === "string" && value.reason.trim().length > 0
      ? value.reason.trim()
      : "AI 未提供原因";
  const evidenceQuote =
    typeof value.evidenceQuote === "string" ? value.evidenceQuote.trim() : "";

  return { rented: value.rented, confidence, reason, evidenceQuote };
}

function collectListingSourceTexts(context: ListingContext): string[] {
  return [
    context.title,
    context.noteContent,
    ...context.authorComments.map((comment) => comment.text),
  ];
}

/**
 * AI 判定已出租时必须给出能在原文里逐字找到的证据；找不到就说明这是脑补/推理出来的
 * 结论（比如靠日期推算、或者曲解"出""私你了"这类模糊用词），一律当作没有证据。
 */
function isEvidenceQuoteVerified(
  context: ListingContext,
  evidenceQuote: string
): boolean {
  const normalizedQuote = normalizeVisibleText(evidenceQuote);
  if (normalizedQuote.length < MIN_EVIDENCE_QUOTE_LENGTH) {
    return false;
  }

  return collectListingSourceTexts(context).some((text) =>
    normalizeVisibleText(text).includes(normalizedQuote)
  );
}

function formatAuthorCommentsForPrompt(comments: AuthorComment[]): string {
  if (comments.length === 0) {
    return "（作者本人没有在评论区发言）";
  }

  return comments
    .map((comment) => `- [${comment.date || "日期未知"}] ${comment.text}`)
    .join("\n");
}

/**
 * 用 OpenAI 判断帖子是否已经出租/下架。纯规则正则容易漏掉像"【已租】"这类
 * 没有恰好命中固定词组的写法，AI 能理解语义，作为主判断；请求失败或未配置
 * API key 时返回 null，由调用方回退到规则判断。
 */
async function judgeRentedWithAi(
  config: Pick<AiJudgeConfig, "apiKey" | "model">,
  context: ListingContext
): Promise<AiJudgement | null> {
  if (!config.apiKey) {
    return null;
  }

  const todayText = new Date().toISOString().slice(0, 10);
  const userContent = [
    `今天日期：${todayText}`,
    `帖子发布/编辑时间：${context.postDate || "（未知）"}`,
    `标题：${context.title.trim() || "（无）"}`,
    `正文：${context.noteContent.trim().slice(0, 2000) || "（无）"}`,
    `作者本人评论（已排除所有路人发言）：\n${formatAuthorCommentsForPrompt(context.authorComments)}`,
  ].join("\n\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_JUDGE_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AI_JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.warn(
        `[ai] 请求失败 status=${response.status}：${errorBody.slice(0, 200)}`
      );
      return null;
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[ai] 响应中没有 content");
      return null;
    }

    return parseAiJudgement(JSON.parse(content));
  } catch (error) {
    console.warn("[ai] 判断失败，回退到规则判断:", error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * AI 是主判断：AI 明确给出结论（无论是否已出租）就直接采信；
 * 只有 AI 未启用/请求失败/置信度不够时，才回退到正则规则判断。
 */
async function resolveDeleteSignal(
  texts: ElementTexts,
  context: ListingContext,
  aiConfig: AiJudgeConfig
): Promise<DeleteSignal | null> {
  if (aiConfig.enabled) {
    const judgement = await judgeRentedWithAi(aiConfig, context);
    if (judgement) {
      console.log(
        `[ai] rented=${judgement.rented} confidence=${judgement.confidence.toFixed(2)} reason=${judgement.reason} quote="${judgement.evidenceQuote}"`
      );

      if (judgement.rented) {
        const quoteVerified = isEvidenceQuoteVerified(
          context,
          judgement.evidenceQuote
        );
        if (!quoteVerified) {
          console.warn(
            `[ai] AI 判断已出租但引用的原文核对不到，视为推测过头，忽略该结论：${judgement.evidenceQuote || "(空)"}`
          );
        } else if (judgement.confidence >= aiConfig.minConfidence) {
          return {
            kind: "ai",
            reason: judgement.reason,
            confidence: judgement.confidence,
          };
        }
        // 引用没通过校验，或置信度不够，交给规则再确认一次
      } else {
        return null;
      }
    }
  }

  return findRentedSignalByRule(texts);
}

async function detectUnavailableToast(
  page: Page
): Promise<DeleteSignal | null> {
  const deadline = Date.now() + UNAVAILABLE_TOAST_WINDOW_MS;

  while (Date.now() < deadline) {
    const toastVisible = await page
      .getByText(UNAVAILABLE_CONTENT_PATTERN)
      .first()
      .isVisible()
      .catch(() => false);
    if (toastVisible) {
      return {
        kind: "unavailable",
        snippet: "该内容暂时无法查看",
      };
    }

    const bodyText = normalizeVisibleText(
      await page
        .locator("body")
        .innerText({ timeout: 1000 })
        .catch(() => "")
    );
    if (UNAVAILABLE_CONTENT_PATTERN.test(bodyText)) {
      return {
        kind: "unavailable",
        snippet: "该内容暂时无法查看",
      };
    }

    await delay(UNAVAILABLE_TOAST_POLL_MS);
  }

  return null;
}

/** 检测扫码登录/验证墙/访问频繁等风控信号；持续存在的墙面，不需要像浮层提示那样长时间轮询。 */
async function detectBlockedOrLoginRequired(
  page: Page
): Promise<string | null> {
  await humanPause(BLOCK_DETECT_MIN_WAIT_MS, BLOCK_DETECT_MAX_WAIT_MS);

  const bodyText = normalizeVisibleText(
    await page
      .locator("body")
      .innerText({ timeout: 2000 })
      .catch(() => "")
  );
  const match = BLOCK_OR_LOGIN_PATTERN.exec(bodyText);
  if (!match || match.index === undefined) {
    return null;
  }

  return snippetAround(bodyText, match.index, match[0].length);
}

async function createBrowserContext(
  headless: boolean
): Promise<BrowserContext> {
  await mkdir(PROFILE_DIR, { recursive: true });

  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    locale: "zh-CN",
    timezoneId: "America/Los_Angeles",
    viewport: {
      width: randomInt(1280, 1440),
      height: randomInt(800, 1000),
    },
  });
}

function safeInnerText(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .innerText({ timeout: 5000 })
    .catch(() => "");
}

async function waitForXhsContent(page: Page): Promise<void> {
  await page
    .locator("#detail-title, .note-content, .comments-container")
    .first()
    .waitFor({ timeout: CONTENT_TIMEOUT_MS })
    .catch(ignoreOptionalError);
}

/**
 * 只提取评论区里"作者本人"的发言（通过 .author-wrapper 里是否带"作者" tag 判断），
 * 路人的评论完全不采集，从源头上保证后续判断绝对不会被路人干扰。
 */
function extractAuthorComments(page: Page): Promise<AuthorComment[]> {
  return page
    .evaluate(() => {
      const items = Array.from(
        document.querySelectorAll(".comments-container .comment-item")
      );
      const results: { text: string; date: string }[] = [];

      for (const item of items) {
        const tagEl = item.querySelector(".author-wrapper .tag");
        const isAuthor = tagEl?.textContent?.trim() === "作者";
        if (!isAuthor) {
          continue;
        }

        const contentEl = item.querySelector(".content");
        const dateEl = item.querySelector(".info .date span");
        const text = contentEl?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (text.length === 0) {
          continue;
        }

        results.push({
          text,
          date: dateEl?.textContent?.trim() ?? "",
        });
      }

      return results;
    })
    .catch(() => []);
}

async function humanPause(minMs = 900, maxMs = 3500): Promise<void> {
  await delay(randomInt(minMs, maxMs));
}

async function lightlyScroll(page: Page): Promise<void> {
  const scrollCount = randomInt(1, 3);
  let index = 0;

  while (index < scrollCount) {
    await page.mouse.wheel(0, randomInt(350, 950));
    await humanPause(800, 2400);
    index += 1;
  }
}

async function readListingPage(
  page: Page,
  sourceUrl: string,
  aiConfig: AiJudgeConfig
): Promise<{ signal: DeleteSignal | null; texts: ElementTexts }> {
  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  const blockedSnippet = await detectBlockedOrLoginRequired(page);
  if (blockedSnippet) {
    throw new XhsBlockedError(blockedSnippet);
  }

  const unavailableSignal = await detectUnavailableToast(page);
  if (unavailableSignal) {
    return {
      signal: unavailableSignal,
      texts: {
        title: "",
        noteContent: "",
        comments: "",
      },
    };
  }

  await waitForXhsContent(page);
  await humanPause(1500, 5000);

  const title = await safeInnerText(page, "#detail-title");
  const noteContent = await safeInnerText(page, ".note-content");
  const postDate = normalizeVisibleText(
    await safeInnerText(page, ".note-content .bottom-container .date")
  );

  await page
    .locator(".comments-container")
    .first()
    .scrollIntoViewIfNeeded({ timeout: 5000 })
    .catch(ignoreOptionalError);
  await lightlyScroll(page);

  const authorComments = await extractAuthorComments(page);
  const comments = formatAuthorCommentsForPrompt(authorComments);
  const texts: ElementTexts = { title, noteContent, comments };
  const context: ListingContext = {
    title,
    noteContent,
    postDate,
    authorComments,
  };

  return {
    signal: await resolveDeleteSignal(texts, context, aiConfig),
    texts,
  };
}

function loadCandidates(sql: postgres.Sql): Promise<ListingRow[]> {
  return sql<ListingRow[]>`
    SELECT id, "sourceUrl", title
    FROM "XhsRentalListing"
    WHERE (
      "sourceUrl" ILIKE ${XHS_URL_PATTERN}
      OR "sourceUrl" ILIKE ${XHSLINK_URL_PATTERN}
    )
      AND "sourceUrl" NOT LIKE 'pending:%'
    ORDER BY random()
  `;
}

/**
 * 拉取数据库全量候选，用本地记录裁剪掉已不存在的 id、过滤掉冷却期内的，
 * 再按"最久未查看"升序排列（从未查看过的排最前面）。
 */
async function fetchScheduledCandidates(
  sql: postgres.Sql,
  log: CheckedLog,
  cooldownMs: number
): Promise<ScheduledCandidates> {
  const dbRows = await loadCandidates(sql);
  const activeIds = dbRows.map((row) => row.id);
  const activeIdSet = new Set(activeIds);
  const prunedLog = pruneCheckedLog(log, activeIdSet);
  const now = Date.now();

  const eligible = dbRows.filter(
    (row) => !isWithinCooldown(prunedLog, row.id, cooldownMs, now)
  );

  const sorted = eligible
    .map((row, index) => ({
      row,
      index,
      priority: priorityTimestamp(prunedLog, row.id),
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);

  return {
    candidates: sorted,
    log: prunedLog,
    totalActive: dbRows.length,
    activeIds,
  };
}

async function deleteListing(
  sql: postgres.Sql,
  row: ListingRow
): Promise<boolean> {
  const deletedRows = await sql<{ id: string }[]>`
    DELETE FROM "XhsRentalListing"
    WHERE id = ${row.id}::uuid
      AND "sourceUrl" = ${row.sourceUrl}
    RETURNING id
  `;

  return deletedRows.length > 0;
}

async function sleepBetweenChecks(
  minDelaySeconds: number,
  maxDelaySeconds: number
): Promise<void> {
  const seconds = randomInt(minDelaySeconds, maxDelaySeconds);
  console.log(`[sleep] 等待 ${seconds}s 后检查下一条...`);
  await delay(seconds * 1000);
}

async function main(): Promise<void> {
  const postgresUrl = requireEnv("POSTGRES_URL");
  const dailyLimit = envNumber("XHS_CLEANER_DAILY_LIMIT", DEFAULT_DAILY_LIMIT);
  const minDelaySeconds = envNumber(
    "XHS_CLEANER_MIN_DELAY_SECONDS",
    DEFAULT_MIN_DELAY_SECONDS
  );
  const maxDelaySeconds = envNumber(
    "XHS_CLEANER_MAX_DELAY_SECONDS",
    DEFAULT_MAX_DELAY_SECONDS
  );
  const cooldownHours = envNumber(
    "XHS_CLEANER_COOLDOWN_HOURS",
    DEFAULT_COOLDOWN_HOURS
  );
  const blockPauseMinMinutes = envNumber(
    "XHS_CLEANER_BLOCK_PAUSE_MIN_MINUTES",
    DEFAULT_BLOCK_PAUSE_MIN_MINUTES
  );
  const blockPauseMaxMinutes = envNumber(
    "XHS_CLEANER_BLOCK_PAUSE_MAX_MINUTES",
    DEFAULT_BLOCK_PAUSE_MAX_MINUTES
  );
  const logPath = envString("XHS_CLEANER_LOG_PATH", DEFAULT_LOG_PATH);
  const headless = envBoolean("XHS_CLEANER_HEADLESS", false);
  const dryRun = envBoolean("XHS_CLEANER_DRY_RUN", false);
  const aiJudgeRequested = envBoolean("XHS_CLEANER_AI_JUDGE", true);
  const aiModel = envString("XHS_CLEANER_AI_MODEL", DEFAULT_AI_MODEL);
  const aiMinConfidence = envNumber(
    "XHS_CLEANER_AI_MIN_CONFIDENCE",
    DEFAULT_AI_MIN_CONFIDENCE
  );

  if (minDelaySeconds > maxDelaySeconds) {
    throw new Error(
      "XHS_CLEANER_MIN_DELAY_SECONDS must be <= XHS_CLEANER_MAX_DELAY_SECONDS"
    );
  }
  if (blockPauseMinMinutes > blockPauseMaxMinutes) {
    throw new Error(
      "XHS_CLEANER_BLOCK_PAUSE_MIN_MINUTES must be <= XHS_CLEANER_BLOCK_PAUSE_MAX_MINUTES"
    );
  }
  if (aiMinConfidence > 1) {
    throw new Error("XHS_CLEANER_AI_MIN_CONFIDENCE must be between 0 and 1");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim() || null;
  if (aiJudgeRequested && !openaiApiKey) {
    console.warn(
      "[ai] 已请求启用 AI 判断，但没有配置 OPENAI_API_KEY，将只用正则规则判断"
    );
  }
  const aiConfig: AiJudgeConfig = {
    enabled: aiJudgeRequested && Boolean(openaiApiKey),
    apiKey: openaiApiKey,
    model: aiModel,
    minConfidence: aiMinConfidence,
  };

  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  const sql = postgres(postgresUrl, { max: 1 });
  const context = await createBrowserContext(headless);

  let checkedLog = await loadCheckedLog(logPath);
  let candidates: ListingRow[] = [];
  let checkedInWindow = 0;
  let deletedInWindow = 0;
  let windowStartedAt = Date.now();

  const persistLog = async (): Promise<void> => {
    await saveCheckedLog(logPath, checkedLog).catch((error) => {
      console.error("[log] 保存记录文件失败:", error);
    });
  };

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n[shutdown] 收到 ${signal}，正在保存记录并退出...`);
    await persistLog();
    await context.close().catch(ignoreOptionalError);
    await sql.end({ timeout: 5 }).catch(ignoreOptionalError);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("[shutdown] 出错:", error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("[shutdown] 出错:", error);
      process.exit(1);
    });
  });

  console.log(
    `[start] dailyLimit=${dailyLimit}, delay=${minDelaySeconds}-${maxDelaySeconds}s, cooldown=${cooldownHours}h, blockPause=${blockPauseMinMinutes}-${blockPauseMaxMinutes}min, headless=${headless}, dryRun=${dryRun}`
  );
  console.log(
    `[ai] enabled=${aiConfig.enabled}, model=${aiConfig.model}, minConfidence=${aiConfig.minConfidence}`
  );
  console.log(`[browser] 使用持久化 profile：${PROFILE_DIR}`);
  console.log(`[log] 使用本地记录文件：${logPath}`);

  try {
    while (true) {
      const windowElapsedMs = Date.now() - windowStartedAt;
      if (windowElapsedMs >= DAY_MS) {
        checkedInWindow = 0;
        deletedInWindow = 0;
        windowStartedAt = Date.now();
      }

      if (checkedInWindow >= dailyLimit) {
        const sleepMs =
          Math.max(0, DAY_MS - windowElapsedMs) + randomInt(5, 15) * 60 * 1000;
        console.log(
          `[limit] 24小时窗口已检查 ${checkedInWindow} 条，休眠 ${Math.round(sleepMs / 1000)}s`
        );
        await delay(sleepMs);
        checkedInWindow = 0;
        deletedInWindow = 0;
        windowStartedAt = Date.now();
        continue;
      }

      if (candidates.length === 0) {
        const scheduled = await fetchScheduledCandidates(
          sql,
          checkedLog,
          cooldownMs
        );
        checkedLog = scheduled.log;
        candidates = scheduled.candidates;

        const summary = summarizeCheckedLog(checkedLog, scheduled.activeIds);
        const cooldownSkipped = scheduled.totalActive - candidates.length;
        console.log(
          `[db] 候选总数=${scheduled.totalActive}，可查看=${candidates.length}，冷却中=${cooldownSkipped}，从未查看=${summary.neverChecked}，最早查看=${summary.oldestCheckedAt ?? "无"}`
        );
        await persistLog();

        if (candidates.length === 0) {
          await delay(30 * 60 * 1000);
          continue;
        }
      }

      const row = candidates.shift();
      if (!row) {
        continue;
      }

      let blockedSnippet: string | null = null;
      const page = await context.newPage();
      try {
        console.log(
          `[check] ${checkedInWindow + 1}/${dailyLimit} ${row.id} ${row.sourceUrl}`
        );
        const { signal } = await readListingPage(page, row.sourceUrl, aiConfig);
        checkedInWindow += 1;

        if (!signal) {
          console.log(`[keep] 未发现删除信号：${row.id}`);
          checkedLog = recordCheckedResult(checkedLog, row.id, "kept");
        } else if (dryRun) {
          console.log(
            `[dry-run] 将删除 ${row.id}，${formatDeleteSignal(signal)}`
          );
          checkedLog = recordCheckedResult(checkedLog, row.id, "kept");
        } else {
          const deleted = await deleteListing(sql, row);
          if (deleted) {
            deletedInWindow += 1;
            console.log(
              `[delete] 已删除 ${row.id}，${formatDeleteSignal(signal)}`
            );
          } else {
            console.log(
              `[skip] 删除时未找到行，可能已被其他任务处理：${row.id}`
            );
          }
          checkedLog = forgetChecked(checkedLog, row.id);
        }

        console.log(
          `[stats] 24小时窗口 checked=${checkedInWindow}, deleted=${deletedInWindow}`
        );
      } catch (error) {
        if (error instanceof XhsBlockedError) {
          blockedSnippet = error.snippet;
        } else {
          checkedInWindow += 1;
          const previousErrors = checkedLog[row.id]?.consecutiveErrors ?? 0;
          const keepStaleForRetry =
            previousErrors + 1 < ERROR_BACKOFF_THRESHOLD;
          checkedLog = recordCheckedResult(checkedLog, row.id, "error", {
            keepStaleForRetry,
          });
          console.error(`[error] 检查失败 ${row.id}:`, error);
        }
      } finally {
        await page.close().catch(ignoreOptionalError);
      }

      if (blockedSnippet) {
        candidates.unshift(row);
        const pauseMs =
          randomInt(blockPauseMinMinutes, blockPauseMaxMinutes) * 60 * 1000;
        console.warn(
          `[block] 疑似触发风控/登录墙：${blockedSnippet}，暂停 ${Math.round(pauseMs / 60_000)} 分钟后继续`
        );
        await persistLog();
        await delay(pauseMs);
        continue;
      }

      await persistLog();
      await sleepBetweenChecks(minDelaySeconds, maxDelaySeconds);
    }
  } finally {
    await persistLog();
    await context.close();
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
