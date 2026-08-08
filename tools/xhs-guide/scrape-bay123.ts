import { createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { put } from "@vercel/blob";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";
import { embedText } from "../../lib/ai/embeddings";
import { composeListingEmbeddingDoc } from "../../lib/rental/listing-embedding";

loadDotenv({ path: ".env.local" });
loadDotenv();

/**
 * bay123.com（Discuz 论坛）租房版抓取。
 *
 * 与 scrape-chineseinsfbay.ts 是两份独立脚本：站点结构差异大，刻意不共享代码，
 * 改一个站不会影响另一个。字段规范化 / 去重 / 入库策略保持一致。
 */

const BASE_URL = "http://www.bay123.com";

const BOARDS = [
  { fid: 40, label: "湾区租房主版" },
  { fid: 158, label: "房屋整租" },
  { fid: 165, label: "短租房" },
];

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_THREADS = 600;
const MAX_RAW_TEXT = 6000;
/** 对论坛友好一点，避免连续高频请求 */
const REQUEST_DELAY_MS = 400;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES_PER_THREAD = 12;

type StructuredListing = {
  title: string | null;
  rent: string | null;
  deposit: string | null;
  availableFrom: string | null;
  leaseEndDate: string | null;
  listingType: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  roomType: string | null;
  propertyName: string | null;
  locationText: string | null;
  furnished: string | null;
  contactMethod: string | null;
  shouldIngest: boolean;
};

type ThreadCandidate = {
  title: string;
  url: string;
  board: string;
};

type ExistingRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
  rawText: string;
  rent: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  propertyName: string | null;
  locationText: string | null;
};

type FieldName = Exclude<keyof StructuredListing, "shouldIngest">;

type CliOptions = {
  maxPages: number;
  maxThreads: number;
  dryRun: boolean;
};

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    maxPages: DEFAULT_MAX_PAGES,
    maxThreads: DEFAULT_MAX_THREADS,
    dryRun: false,
  };

  for (const arg of argv) {
    const pagesMatch = arg.match(/^--pages=(\d+)$/);
    if (pagesMatch) {
      options.maxPages = Number(pagesMatch[1]);
      continue;
    }
    const threadsMatch = arg.match(/^--max-threads=(\d+)$/);
    if (threadsMatch) {
      options.maxThreads = Number(threadsMatch[1]);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  return options;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeText(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s$./-]/gu, " ")
    .trim()
    .toLowerCase();
}

function truncate(text: string, max = MAX_RAW_TEXT): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

// ── 时间解析 ──────────────────────────────────────────────────────────────
// Discuz 页脚声明 GMT-8 且全年固定，不随夏令时切换，因此按固定 -08:00 解析。

const DISCUZ_TIME_REGEX =
  /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function pad2(value: string | number): string {
  return String(value).padStart(2, "0");
}

function parseDiscuzDateTime(raw: string): Date | null {
  const matched = raw.match(DISCUZ_TIME_REGEX);
  if (!matched) {
    return null;
  }
  const iso = `${matched[1]}-${pad2(matched[2])}-${pad2(matched[3])}T${pad2(
    matched[4]
  )}:${matched[5]}:${matched[6] ?? "00"}-08:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 优先「本帖最后由 … 编辑」的更新时间，无则回退发表时间 */
function pickPostedAt(editedText: string, postedText: string): Date | null {
  return parseDiscuzDateTime(editedText) ?? parseDiscuzDateTime(postedText);
}

// ── 字段规范化（与 chineseinsfbay 脚本保持一致）────────────────────────────

function fingerprintFromParts(parts: Array<string | null | undefined>): string {
  const base = parts
    .map((part) => (part ? normalizeText(part) : ""))
    .filter((part) => part.length > 0)
    .join("|");
  return createHash("sha256").update(base).digest("hex");
}

function toNullableCleanString(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }
  if (["null", "n/a", "na", "未知", "不详", "无"].includes(cleaned.toLowerCase())) {
    return null;
  }
  return cleaned;
}

function extractByRegex(rawText: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const matched = rawText.match(pattern);
    const value = toNullableCleanString(matched?.[1]);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeRentValue(value: string | null): string | null {
  const cleaned = toNullableCleanString(value);
  if (!cleaned) {
    return null;
  }
  const digits = cleaned.match(/(\d{3,5}(?:\.\d{1,2})?)/)?.[1];
  if (!digits) {
    return cleaned;
  }
  // 湾区邮编（94xxx/95xxx）极易被当成租金抓走，用合理月租区间挡掉
  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount < 100 || amount > 20_000) {
    return null;
  }
  return digits;
}

function normalizeUnitNumber(value: string | null): string | null {
  const cleaned = toNullableCleanString(value);
  if (!cleaned) {
    return null;
  }
  return cleaned.match(/(\d+(?:\.\d+)?)/)?.[1] ?? cleaned;
}

function normalizeListingTypeValue(
  value: string | null,
  rawText: string
): string | null {
  const basis = `${value ?? ""} ${rawText}`.toLowerCase();
  if (
    basis.includes("整租") ||
    basis.includes("whole") ||
    basis.includes("entire unit")
  ) {
    return "entire";
  }
  if (
    basis.includes("分租") ||
    basis.includes("合租") ||
    basis.includes("找室友") ||
    basis.includes("次卧") ||
    basis.includes("share") ||
    basis.includes("shared")
  ) {
    return "shared";
  }
  if (
    basis.includes("雅房") ||
    basis.includes("单间") ||
    basis.includes("private room")
  ) {
    return "private_room";
  }
  if (basis.includes("床位") || basis.includes("床铺")) {
    return "bedspace";
  }
  // 认不出就留空：这一列是枚举，写入中文原文会让后续筛选失效
  return null;
}

function normalizeFurnishedValue(
  value: string | null,
  rawText: string
): string | null {
  const basis = `${value ?? ""} ${rawText}`.toLowerCase();
  if (
    basis.includes("不包家具") ||
    basis.includes("无家具") ||
    basis.includes("unfurnished")
  ) {
    return "no";
  }
  if (
    basis.includes("带家具") ||
    basis.includes("全套家具") ||
    basis.includes("furnished")
  ) {
    return "yes";
  }
  if (
    basis.includes("部分家具") ||
    basis.includes("semi-furnished") ||
    basis.includes("partially furnished")
  ) {
    return "partial";
  }
  return toNullableCleanString(value);
}

function normalizeStructuredListing(
  structured: StructuredListing,
  fallbackTitle: string,
  rawText: string
): StructuredListing {
  // 兜底必须带 $ 或租金关键词，否则会把邮编、面积、电话号段当成租金
  const rentCandidate =
    toNullableCleanString(structured.rent) ??
    extractByRegex(rawText, [
      /(?:房租|租金|月租)\s*[:：]?\s*\$?\s*(\d{3,5})/i,
      /\$\s*(\d{3,5})/,
    ]);
  const bedroomsCandidate =
    toNullableCleanString(structured.bedrooms) ??
    extractByRegex(rawText, [/(?:([1-9]\d*(?:\.\d)?)\s*(?:房|bed(?:room)?s?))/i]);
  const bathroomsCandidate =
    toNullableCleanString(structured.bathrooms) ??
    extractByRegex(rawText, [/(?:([1-9]\d*(?:\.\d)?)\s*(?:卫|bath(?:room)?s?))/i]);

  return {
    title:
      toNullableCleanString(structured.title) ??
      toNullableCleanString(fallbackTitle),
    rent: normalizeRentValue(rentCandidate),
    deposit:
      toNullableCleanString(structured.deposit) ??
      extractByRegex(rawText, [/(?:押金|deposit)\s*[:：]?\s*([^\n，。,；;]{1,30})/i]),
    availableFrom:
      toNullableCleanString(structured.availableFrom) ??
      extractByRegex(rawText, [
        /(?:入住|可入住|available from)\s*[:：]?\s*([^\n，。,；;]{1,40})/i,
      ]),
    leaseEndDate:
      toNullableCleanString(structured.leaseEndDate) ??
      extractByRegex(rawText, [/(?:租期到|lease end)\s*[:：]?\s*([^\n，。,；;]{1,40})/i]),
    listingType: normalizeListingTypeValue(structured.listingType, rawText),
    bedrooms: normalizeUnitNumber(bedroomsCandidate),
    bathrooms: normalizeUnitNumber(bathroomsCandidate),
    roomType: toNullableCleanString(structured.roomType),
    propertyName: toNullableCleanString(structured.propertyName),
    locationText:
      toNullableCleanString(structured.locationText) ??
      extractByRegex(rawText, [
        /\(([^()]{2,80})\)/,
        /(?:位于|地址|near)\s*[:：]?\s*([^\n]{2,80})/i,
      ]),
    furnished: normalizeFurnishedValue(structured.furnished, rawText),
    contactMethod:
      toNullableCleanString(structured.contactMethod) ??
      extractByRegex(rawText, [
        /(?:联系|contact|微信|text(?:\s*message)?|电话)\s*[:：]?\s*([^\n]{2,80})/i,
      ]),
    shouldIngest: structured.shouldIngest,
  };
}

function structuredFieldCount(structured: StructuredListing): number {
  const fields: FieldName[] = [
    "title",
    "rent",
    "deposit",
    "availableFrom",
    "leaseEndDate",
    "listingType",
    "bedrooms",
    "bathrooms",
    "roomType",
    "propertyName",
    "locationText",
    "furnished",
    "contactMethod",
  ];
  return fields.filter((field) => (structured[field] ?? "").trim().length > 0)
    .length;
}

function listingFingerprint(
  pageTitle: string,
  rawText: string,
  structured: StructuredListing
): string {
  const primaryParts = [
    structured.propertyName,
    structured.locationText,
    structured.rent,
    structured.bedrooms,
    structured.bathrooms,
    structured.availableFrom,
    structured.leaseEndDate,
    structured.contactMethod,
  ];
  const hasEnoughStructured =
    primaryParts.filter((item) => (item ?? "").trim().length > 0).length >= 3;
  if (hasEnoughStructured) {
    return fingerprintFromParts(primaryParts);
  }
  return fingerprintFromParts([pageTitle, rawText]);
}

// ── AI 抽取 ───────────────────────────────────────────────────────────────

async function aiExtractListing(
  openAiApiKey: string,
  pageTitle: string,
  url: string,
  rawText: string
): Promise<StructuredListing> {
  const schema = {
    name: "rental_listing",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: ["string", "null"] },
        rent: { type: ["string", "null"] },
        deposit: { type: ["string", "null"] },
        availableFrom: { type: ["string", "null"] },
        leaseEndDate: { type: ["string", "null"] },
        listingType: { type: ["string", "null"] },
        bedrooms: { type: ["string", "null"] },
        bathrooms: { type: ["string", "null"] },
        roomType: { type: ["string", "null"] },
        propertyName: { type: ["string", "null"] },
        locationText: { type: ["string", "null"] },
        furnished: { type: ["string", "null"] },
        contactMethod: { type: ["string", "null"] },
        shouldIngest: { type: "boolean" },
      },
      required: [
        "title",
        "rent",
        "deposit",
        "availableFrom",
        "leaseEndDate",
        "listingType",
        "bedrooms",
        "bathrooms",
        "roomType",
        "propertyName",
        "locationText",
        "furnished",
        "contactMethod",
        "shouldIngest",
      ],
    },
  } as const;

  const prompt = [
    "你是湾区租房信息抽取器。",
    "请从帖子中提取结构化字段，抽不出来填 null。",
    "如果内容明显不是租房信息，shouldIngest=false。",
    "注意：出租/招租/分租/找室友/次卧出租 都属于房源，shouldIngest=true。",
    "只有当发帖人是在找房子（求租、我想租、预算多少求一间）时，shouldIngest=false。",
    "不要编造。",
    `帖子标题: ${pageTitle}`,
    `帖子链接: ${url}`,
    "帖子正文如下:",
    truncate(rawText),
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [
        {
          role: "system",
          content:
            "你专门处理美国湾区租房论坛帖子，输出必须匹配给定 JSON schema。",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content");
  }
  return JSON.parse(content) as StructuredListing;
}

// ── 图片 ──────────────────────────────────────────────────────────────────

/**
 * bay123 附件接口返回的 content-type 是裸 "image"，无法据此判断格式，
 * 因此用文件头魔数嗅探。非图片一律丢弃。
 */
function sniffImageType(buffer: Buffer): { mime: string; ext: string } | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (buffer.length >= 8 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return { mime: "image/png", ext: "png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * 附件 URL 形如 forum.php?mod=attachment&aid=<base64>，base64 解出
 * "<attachmentId>|<hash>|<timestamp>|…"。timestamp 每次加载都变，直接拿整条 URL
 * 当 Blob key 会导致重复上传，因此只取稳定的 attachmentId。
 */
function stableAttachmentKey(attachmentUrl: string): string {
  const aid = new URL(attachmentUrl).searchParams.get("aid") ?? "";
  try {
    const decoded = Buffer.from(aid, "base64").toString("utf8");
    const parts = decoded.split("|");
    const attachmentId = parts[0];
    const threadId = parts[4];
    if (attachmentId) {
      return threadId ? `${threadId}-${attachmentId}` : attachmentId;
    }
  } catch {
    // 解不出就退回哈希，仍然可用只是跨次运行不稳定
  }
  return createHash("sha1").update(attachmentUrl).digest("hex");
}

/**
 * imageUrls 列是 json（不是 jsonb），postgres.js 只自动解析 jsonb，
 * json 会原样返回字符串。不解析就会把已有图片当成空数组覆盖掉。
 */
function parseImageUrls(value: unknown): string[] {
  const asArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string")
      : [];

  if (typeof value !== "string") {
    return asArray(value);
  }
  try {
    return asArray(JSON.parse(value));
  } catch {
    return [];
  }
}

async function uploadImageUrls(
  blobToken: string,
  imageUrls: string[]
): Promise<string[]> {
  const uploaded: string[] = [];

  for (const remoteUrl of imageUrls) {
    try {
      const response = await fetch(remoteUrl, {
        headers: { Referer: `${BASE_URL}/` },
      });
      if (!response.ok) {
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
        continue;
      }
      const sniffed = sniffImageType(buffer);
      if (!sniffed) {
        continue;
      }

      const path = `xhs-listing-images/bay123-${stableAttachmentKey(remoteUrl)}.${sniffed.ext}`;
      const blob = await put(path, buffer, {
        access: "public",
        token: blobToken,
        contentType: sniffed.mime,
        addRandomSuffix: false,
      });
      uploaded.push(blob.url);
    } catch {
      // 单张图失败不影响整帖
    }
  }

  return uploaded;
}

// ── 抓取 ──────────────────────────────────────────────────────────────────

/**
 * 列表页给出的链接形如 thread-<tid>-<楼层页>-<列表页号>.html，最后一段随帖子
 * 在列表中的位置漂移。归一到 -1-1，sourceUrl 才能在多次抓取之间保持稳定。
 */
function canonicalThreadUrl(url: string): string {
  return url.replace(/\/thread-(\d+)-\d+-\d+\.html/, "/thread-$1-1-1.html");
}

async function scrapeThreadLinks(
  page: Page,
  maxPages: number
): Promise<ThreadCandidate[]> {
  const links = new Map<string, ThreadCandidate>();

  for (const board of BOARDS) {
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const listUrl = `${BASE_URL}/forum-${board.fid}-${pageNo}.html`;
      try {
        await page.goto(listUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[bay123] 列表页失败: ${listUrl} error=${message}`);
        continue;
      }

      // 只取 normalthread_*：stickthread_* 是常年置顶的公告和微信群广告
      const found = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            '#threadlist tbody[id^="normalthread_"] a.xst'
          )
        )
          .map((anchor) => ({
            title: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
            url: anchor.href,
          }))
          .filter((item) => item.title && item.url)
      );

      for (const item of found) {
        const url = canonicalThreadUrl(item.url);
        links.set(url, { title: item.title, url, board: board.label });
      }

      console.log(
        `[bay123] ${board.label} 第 ${pageNo} 页: +${found.length}（累计 ${links.size}）`
      );
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return Array.from(links.values());
}

async function scrapeThreadContent(
  page: Page,
  url: string
): Promise<{
  title: string;
  rawText: string;
  imageUrls: string[];
  postedAt: Date | null;
}> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const payload = await page.evaluate(
    (maxImages: number) => {
      // 首楼即房源，后面的 post_* 是回帖
      const firstPost = document.querySelector<HTMLElement>(
        '#postlist > div[id^="post_"]'
      );

      const title =
        document.querySelector("#thread_subject")?.textContent?.trim() ??
        document.title.trim();

      const bodyNode = firstPost?.querySelector<HTMLElement>("td.t_f, div.t_f");
      const editedText =
        bodyNode?.querySelector(".pstatus")?.textContent?.trim() ?? "";

      let rawText = "";
      if (bodyNode) {
        // 去掉「本帖最后由 … 编辑」和引用块后再取正文
        const clone = bodyNode.cloneNode(true) as HTMLElement;
        for (const junk of Array.from(
          clone.querySelectorAll(".pstatus, .quote, .attnm, script, style")
        )) {
          junk.remove();
        }
        rawText = (clone.innerText || "").trim();
      }

      const postonNode = firstPost?.querySelector('em[id^="authorposton"]');
      const postedText =
        postonNode?.querySelector("span")?.getAttribute("title") ??
        postonNode?.textContent?.trim() ??
        "";

      // 图片是附件，挂在首楼正文块之外；zoomfile 是原图，file/src 是缩略图
      const imageUrls = Array.from(firstPost?.querySelectorAll("img") ?? [])
        .map(
          (img) =>
            img.getAttribute("zoomfile") ||
            img.getAttribute("file") ||
            img.getAttribute("src") ||
            ""
        )
        .filter((src) => src.includes("mod=attachment"))
        .map((src) => new URL(src, document.baseURI).href);

      return {
        title,
        rawText,
        editedText,
        postedText,
        imageUrls: Array.from(new Set(imageUrls)).slice(0, maxImages),
      };
    },
    MAX_IMAGES_PER_THREAD
  );

  return {
    title: payload.title,
    rawText: payload.rawText,
    imageUrls: payload.imageUrls,
    postedAt: pickPostedAt(payload.editedText, payload.postedText),
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const postgresUrl = requireEnv("POSTGRES_URL");
  const blobToken = options.dryRun ? "" : requireEnv("BLOB_READ_WRITE_TOKEN");

  console.log(
    `[bay123] 配置: 版块=${BOARDS.map((b) => b.label).join("/")} 每版${options.maxPages}页 上限${options.maxThreads}帖 dryRun=${options.dryRun}`
  );

  const sql = postgres(postgresUrl, { max: 1, ssl: "require" });

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("[bay123] 正在抓取列表页链接...");
    const allThreads = await scrapeThreadLinks(page, options.maxPages);
    const threads = allThreads.slice(0, options.maxThreads);
    if (allThreads.length > threads.length) {
      console.log(
        `[bay123] 候选 ${allThreads.length} 条，按上限截断到 ${threads.length} 条（--max-threads 可调）`
      );
    } else {
      console.log(`[bay123] 找到候选帖子 ${threads.length} 条`);
    }

    const existingRows = (await sql`
      select
        "id",
        "sourceUrl",
        "title",
        "rawText",
        "rent",
        "bedrooms",
        "bathrooms",
        "propertyName",
        "locationText"
      from "XhsRentalListing"
    `) as ExistingRow[];

    // 内容指纹跨站点共用：同一房源在两个论坛重复发帖会被认出来
    const existingByFingerprint = new Map<string, string>();
    const existingBySourceUrl = new Map<string, string>();
    for (const row of existingRows) {
      const fingerprint = listingFingerprint(row.title ?? "", row.rawText, {
        title: row.title,
        rent: row.rent,
        deposit: null,
        availableFrom: null,
        leaseEndDate: null,
        listingType: null,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        roomType: null,
        propertyName: row.propertyName,
        locationText: row.locationText,
        furnished: null,
        contactMethod: null,
        shouldIngest: true,
      });
      existingByFingerprint.set(fingerprint, row.id);
      existingBySourceUrl.set(row.sourceUrl, row.id);
    }
    console.log(`[bay123] 已有库存 ${existingRows.length} 条，用于去重`);

    const mergeImagesAndPostedAt = async (
      listingId: string,
      uploaded: string[],
      nextPostedAt: Date | null
    ) => {
      const rows = (await sql`
        select "imageUrls"
        from "XhsRentalListing"
        where "id" = ${listingId}
        limit 1
      `) as Array<{ imageUrls: unknown }>;
      const current = parseImageUrls(rows[0]?.imageUrls);
      const merged = Array.from(new Set([...current, ...uploaded]));
      await sql`
        update "XhsRentalListing"
        set
          "imageUrls" = ${JSON.stringify(merged)}::jsonb,
          "postedAt" = coalesce(
            ${nextPostedAt ? nextPostedAt.toISOString() : null}::timestamptz,
            "postedAt"
          )
        where "id" = ${listingId}
      `;
    };

    let inserted = 0;
    let deduped = 0;
    let skipped = 0;

    for (let index = 0; index < threads.length; index += 1) {
      const candidate = threads[index];
      const progress = `(${index + 1}/${threads.length})`;

      if (existingBySourceUrl.has(candidate.url)) {
        console.log(`[bay123] ${progress} skip(URL已入库): ${candidate.url}`);
        deduped += 1;
        continue;
      }

      console.log(`[bay123] ${progress} [${candidate.board}] ${candidate.url}`);

      let title = candidate.title;
      let rawText = "";
      let imageUrls: string[] = [];
      let postedAt: Date | null = null;
      try {
        const content = await scrapeThreadContent(page, candidate.url);
        title = content.title || candidate.title;
        rawText = content.rawText;
        imageUrls = content.imageUrls;
        postedAt = content.postedAt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[bay123] skip(抓取失败): ${candidate.url} error=${message}`);
        skipped += 1;
        continue;
      }
      await sleep(REQUEST_DELAY_MS);

      if (!rawText || normalizeText(rawText).length < 20) {
        console.log(`[bay123] skip(正文过短): ${candidate.url}`);
        skipped += 1;
        continue;
      }

      let structured: StructuredListing;
      try {
        structured = await aiExtractListing(
          openAiApiKey,
          title,
          candidate.url,
          rawText
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[bay123] skip(AI抽取失败): ${candidate.url} error=${message}`);
        skipped += 1;
        continue;
      }

      const normalized = normalizeStructuredListing(structured, title, rawText);
      const fieldCount = structuredFieldCount(normalized);
      if (!normalized.shouldIngest || fieldCount < 3) {
        console.log(
          `[bay123] skip(非房源/结构化不足): shouldIngest=${normalized.shouldIngest}, fields=${fieldCount}`
        );
        skipped += 1;
        continue;
      }

      const fingerprint = listingFingerprint(title, rawText, normalized);

      if (options.dryRun) {
        console.log(
          `[bay123] dry-run 将入库: title=${normalized.title} rent=${normalized.rent} ` +
            `bed=${normalized.bedrooms} bath=${normalized.bathrooms} type=${normalized.listingType} ` +
            `loc=${normalized.locationText} postedAt=${postedAt?.toISOString() ?? "null"} ` +
            `imgs=${imageUrls.length} dupFp=${existingByFingerprint.has(fingerprint)}`
        );
        inserted += 1;
        continue;
      }

      const uploadedImageUrls = await uploadImageUrls(blobToken, imageUrls);
      const uniqueUploaded = Array.from(new Set(uploadedImageUrls));

      const existingId = existingByFingerprint.get(fingerprint);
      if (existingId) {
        await mergeImagesAndPostedAt(existingId, uniqueUploaded, postedAt);
        existingBySourceUrl.set(candidate.url, existingId);
        console.log("[bay123] dedup(内容重复)，已合并图片/时间");
        deduped += 1;
        continue;
      }

      try {
        const insertedRows = (await sql`
          insert into "XhsRentalListing" (
            "sourceUrl",
            "title",
            "rawText",
            "rent",
            "deposit",
            "availableFrom",
            "leaseEndDate",
            "listingType",
            "bedrooms",
            "bathrooms",
            "roomType",
            "propertyName",
            "locationText",
            "furnished",
            "contactMethod",
            "imageUrls",
            "postedAt",
            "createdAt"
          ) values (
            ${candidate.url},
            ${normalized.title ?? title},
            ${rawText},
            ${normalized.rent},
            ${normalized.deposit},
            ${normalized.availableFrom},
            ${normalized.leaseEndDate},
            ${normalized.listingType},
            ${normalized.bedrooms},
            ${normalized.bathrooms},
            ${normalized.roomType},
            ${normalized.propertyName},
            ${normalized.locationText},
            ${normalized.furnished},
            ${normalized.contactMethod},
            ${JSON.stringify(uniqueUploaded)}::jsonb,
            ${postedAt ? postedAt.toISOString() : null},
            ${new Date().toISOString()}
          )
          returning "id"
        `) as Array<{ id: string }>;

        const insertedId = insertedRows[0]?.id;
        if (insertedId) {
          existingByFingerprint.set(fingerprint, insertedId);
          existingBySourceUrl.set(candidate.url, insertedId);

          // 入库即嵌入：否则向量搜索（WHERE embedding IS NOT NULL）看不到新房源。
          // 失败不阻塞抓取，留给 scripts/embed-listings.ts 兜底。
          if (process.env.VOYAGE_API_KEY) {
            try {
              const doc = composeListingEmbeddingDoc({
                rawText,
                title: normalized.title ?? title,
                locationText: normalized.locationText,
                propertyName: normalized.propertyName,
                rent: normalized.rent,
                roomType: normalized.roomType,
                bedrooms: normalized.bedrooms,
                bathrooms: normalized.bathrooms,
                listingType: normalized.listingType,
                availableFrom: normalized.availableFrom,
                furnished: normalized.furnished,
              });
              const vector = await embedText(doc, "document");
              await sql`
                update "XhsRentalListing"
                set embedding = ${`[${vector.join(",")}]`}::vector
                where "id" = ${insertedId}
              `;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              console.log(
                `[bay123] warn(嵌入失败，可运行 embed-listings.ts 兜底): ${message}`
              );
            }
          }
        }
        inserted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("uq_listing_sourceurl") ||
          message.includes("duplicate key")
        ) {
          const rows = (await sql`
            select "id"
            from "XhsRentalListing"
            where "sourceUrl" = ${candidate.url}
            limit 1
          `) as Array<{ id: string }>;
          const foundId = rows[0]?.id;
          if (foundId) {
            await mergeImagesAndPostedAt(foundId, uniqueUploaded, postedAt);
            existingByFingerprint.set(fingerprint, foundId);
            existingBySourceUrl.set(candidate.url, foundId);
          }
          console.log(`[bay123] dedup(唯一约束): ${candidate.url}`);
          deduped += 1;
          continue;
        }
        throw error;
      }
    }

    console.log(
      `[bay123] 完成: inserted=${inserted}, deduped=${deduped}, skipped=${skipped}`
    );
  } finally {
    await browser?.close();
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[bay123] 失败:", error);
  process.exitCode = 1;
});
