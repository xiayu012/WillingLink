import { createHash } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { put } from "@vercel/blob";
import { chromium } from "@playwright/test";
import postgres from "postgres";
import { embedText } from "../../lib/ai/embeddings";
import { composeListingEmbeddingDoc } from "../../lib/rental/listing-embedding";

loadDotenv({ path: ".env.local" });
loadDotenv();

const FORUM_URL = "https://www.chineseinsfbay.com/f/page_viewforum/f_5.html";
const MAX_PAGES = 5;
const MAX_THREADS = 80;
const MAX_RAW_TEXT = 6000;

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
  imageUrls: string[] | null;
};

type ExistingFingerprint = {
  id: string;
  fingerprint: string;
};

type FieldName = Exclude<keyof StructuredListing, "shouldIngest">;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
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

/** 解析论坛 .post_time：优先「更新于」，无则回退「发布于」 */
function parseForumDateTimeLabel(raw: string): Date | null {
  const cleaned = raw
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const matched = cleaned.match(
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i
  );
  if (!matched) {
    return null;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  let hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const ampm = matched[6].toLowerCase();

  if (ampm === "pm" && hour < 12) {
    hour += 12;
  }
  if (ampm === "am" && hour === 12) {
    hour = 0;
  }

  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isoTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

  for (const offset of ["-08:00", "-07:00"]) {
    const candidate = new Date(`${isoDate}T${isoTime}${offset}`);
    if (Number.isNaN(candidate.getTime())) {
      continue;
    }
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(candidate);

    const read = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? "0");
    const readMeridiem = () =>
      parts.find((part) => part.type === "dayPeriod")?.value?.toLowerCase() ??
      "";

    const laYear = read("year");
    const laMonth = read("month");
    const laDay = read("day");
    let laHour = read("hour");
    const laMinute = read("minute");
    const laMeridiem = readMeridiem();

    if (laMeridiem === "pm" && laHour < 12) {
      laHour += 12;
    }
    if (laMeridiem === "am" && laHour === 12) {
      laHour = 0;
    }

    if (
      laYear === year &&
      laMonth === month &&
      laDay === day &&
      laHour === hour &&
      laMinute === minute
    ) {
      return candidate;
    }
  }

  return null;
}

function parsePostTimeBlock(postTimeText: string): Date | null {
  const normalized = postTimeText.replace(/\u00a0/g, " ");

  const updatedMatch = normalized.match(
    /更新于:\s*(\d{4}\/\d{1,2}\/\d{1,2}[,\s]+\d{1,2}:\d{2}\s*(?:am|pm))/i
  );
  if (updatedMatch?.[1]) {
    const parsed = parseForumDateTimeLabel(updatedMatch[1]);
    if (parsed) {
      return parsed;
    }
  }

  const publishedMatch = normalized.match(
    /发布于:\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*(?:am|pm))/i
  );
  if (publishedMatch?.[1]) {
    return parseForumDateTimeLabel(publishedMatch[1]);
  }

  return null;
}

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
  const number = cleaned.match(/(\d{3,5}(?:\.\d{1,2})?)/)?.[1];
  if (!number) {
    return cleaned;
  }
  return number;
}

function normalizeUnitNumber(value: string | null): string | null {
  const cleaned = toNullableCleanString(value);
  if (!cleaned) {
    return null;
  }
  const number = cleaned.match(/(\d+(?:\.\d+)?)/)?.[1];
  if (!number) {
    return cleaned;
  }
  return number;
}

function normalizeListingTypeValue(value: string | null, rawText: string): string | null {
  const basis = `${value ?? ""} ${rawText}`.toLowerCase();
  if (
    basis.includes("整租") ||
    basis.includes("whole") ||
    basis.includes("entire unit")
  ) {
    return "entire";
  }
  if (basis.includes("分租") || basis.includes("share") || basis.includes("shared")) {
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
  return toNullableCleanString(value);
}

function normalizeFurnishedValue(value: string | null, rawText: string): string | null {
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
  const rentCandidate =
    toNullableCleanString(structured.rent) ??
    extractByRegex(rawText, [
      /\$?\s?(\d{3,5}(?:\s*\/\s*月)?)/i,
      /(?:房租|租金)\s*[:：]?\s*([$\d][^\n，。,；; ]{0,20})/i,
    ]);
  const bedroomsCandidate =
    toNullableCleanString(structured.bedrooms) ??
    extractByRegex(rawText, [/(?:([1-9]\d*(?:\.\d)?)\s*(?:房|bed(?:room)?s?))/i]);
  const bathroomsCandidate =
    toNullableCleanString(structured.bathrooms) ??
    extractByRegex(rawText, [/(?:([1-9]\d*(?:\.\d)?)\s*(?:卫|bath(?:room)?s?))/i]);

  const normalized: StructuredListing = {
    title: toNullableCleanString(structured.title) ?? toNullableCleanString(fallbackTitle),
    rent: normalizeRentValue(rentCandidate),
    deposit:
      toNullableCleanString(structured.deposit) ??
      extractByRegex(rawText, [/(?:押金|deposit)\s*[:：]?\s*([^\n，。,；;]{1,30})/i]),
    availableFrom:
      toNullableCleanString(structured.availableFrom) ??
      extractByRegex(rawText, [/(?:入住|可入住|available from)\s*[:：]?\s*([^\n，。,；;]{1,40})/i]),
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
      extractByRegex(rawText, [/\(([^()]{2,80})\)/, /(?:位于|地址|near)\s*[:：]?\s*([^\n]{2,80})/i]),
    furnished: normalizeFurnishedValue(structured.furnished, rawText),
    contactMethod:
      toNullableCleanString(structured.contactMethod) ??
      extractByRegex(rawText, [/(?:联系|contact|微信|text(?:\s*message)?|电话)\s*[:：]?\s*([^\n]{2,80})/i]),
    shouldIngest: structured.shouldIngest,
  };

  return normalized;
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
  return fields.filter((field) => (structured[field] ?? "").trim().length > 0).length;
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
      response_format: {
        type: "json_schema",
        json_schema: schema,
      },
      messages: [
        {
          role: "system",
          content:
            "你专门处理美国湾区租房论坛帖子，输出必须匹配给定 JSON schema。",
        },
        {
          role: "user",
          content: prompt,
        },
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

  const parsed = JSON.parse(content) as StructuredListing;
  return parsed;
}

async function uploadImageUrls(
  blobToken: string,
  sourceUrl: string,
  imageUrls: string[]
): Promise<string[]> {
  const uploaded: string[] = [];
  for (let index = 0; index < imageUrls.length; index += 1) {
    const remoteUrl = imageUrls[index];
    if (!remoteUrl) {
      continue;
    }
    try {
      const response = await fetch(remoteUrl);
      if (!response.ok) {
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !contentType.includes("jpeg") &&
        !contentType.includes("jpg") &&
        !contentType.includes("png") &&
        !contentType.includes("webp")
      ) {
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = contentType.includes("png")
        ? "png"
        : contentType.includes("webp")
          ? "webp"
          : "jpg";
      const path = `xhs-listing-images/${createHash("sha1")
        .update(`${sourceUrl}-${remoteUrl}-${index}`)
        .digest("hex")}.${ext}`;

      const uploadedBlob = await put(path, buffer, {
        access: "public",
        token: blobToken,
        contentType,
        addRandomSuffix: false,
      });
      uploaded.push(uploadedBlob.url);
    } catch {
      // ignore single image failure and continue
    }
  }
  return uploaded;
}

async function scrapeThreadLinks(maxPages: number): Promise<ThreadCandidate[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const links = new Map<string, ThreadCandidate>();

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    const targetUrl =
      currentPage === 1 ? FORUM_URL : `${FORUM_URL}/page_${currentPage}.html`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1000);

    const candidates = await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]")
      );
      const out: Array<{ title: string; url: string }> = [];
      for (const anchor of anchors) {
        const href = anchor.href ?? "";
        if (!href.includes("page_viewtopic")) {
          continue;
        }
        const title = (anchor.textContent ?? "").trim();
        if (!title) {
          continue;
        }
        out.push({ title, url: href });
      }
      return out;
    });

    for (const candidate of candidates) {
      links.set(candidate.url, candidate);
    }
  }

  await context.close();
  await browser.close();
  return Array.from(links.values()).slice(0, MAX_THREADS);
}

async function scrapeThreadContent(url: string): Promise<{
  title: string;
  rawText: string;
  imageUrls: string[];
  postedAt: Date | null;
}> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);

  const payload = await page.evaluate(() => {
    const title = (document.querySelector("h1")?.textContent ?? document.title).trim();

    const textCandidates = Array.from(
      document.querySelectorAll<HTMLElement>("p.real-content")
    )
      .map((node) => (node.innerText || "").trim())
      .filter((node) => node.length > 0);

    const rawText = textCandidates.join("\n\n");

    const thumbImageUrls = Array.from(
      document.querySelectorAll<HTMLImageElement>(
        "#smallImg-box img.topicImg.f_5img"
      )
    )
      .map((img) => img.src?.trim())
      .filter((src): src is string => Boolean(src))
      .filter((src) => /^https?:\/\//.test(src));

    const detailImageUrls = Array.from(
      document.querySelectorAll<HTMLImageElement>("#detailImg-box img.topicImg")
    )
      .map((img) => img.src?.trim())
      .filter((src): src is string => Boolean(src))
      .filter((src) => /^https?:\/\//.test(src));

    const imageUrls = Array.from(
      new Set([...thumbImageUrls, ...detailImageUrls])
    ).slice(0, 16);

    const postTimeText =
      document.querySelector(".post_time")?.textContent?.trim() ?? "";

    return {
      title,
      rawText,
      imageUrls,
      postTimeText,
    };
  });

  await context.close();
  await browser.close();

  return {
    title: payload.title,
    rawText: payload.rawText.trim(),
    imageUrls: payload.imageUrls,
    postedAt: parsePostTimeBlock(payload.postTimeText ?? ""),
  };
}

async function main() {
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const postgresUrl = requireEnv("POSTGRES_URL");
  const blobToken = requireEnv("BLOB_READ_WRITE_TOKEN");

  const sql = postgres(postgresUrl, {
    max: 1,
    ssl: "require",
  });

  try {
    await sql`
      alter table "XhsRentalListing"
      add column if not exists "postedAt" timestamptz
    `;

    console.log("[scrape] 正在抓取列表页链接...");
    const threads = await scrapeThreadLinks(MAX_PAGES);
    console.log(`[scrape] 找到候选帖子 ${threads.length} 条`);

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
        "locationText",
        "imageUrls"
      from "XhsRentalListing"
    `) as ExistingRow[];

    const existingByFingerprint = new Map<string, ExistingFingerprint>();
    const existingBySourceUrl = new Map<string, string>();
    for (const row of existingRows) {
      const fp = listingFingerprint(
        row.title ?? "",
        row.rawText,
        {
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
        }
      );
      existingByFingerprint.set(fp, { id: row.id, fingerprint: fp });
      existingBySourceUrl.set(row.sourceUrl, row.id);
    }

    const mergeImagesAndMaybePostedAt = async (
      listingId: string,
      uploaded: string[],
      nextPostedAt: Date | null
    ) => {
      const rows = (await sql`
        select "imageUrls"
        from "XhsRentalListing"
        where "id" = ${listingId}
        limit 1
      `) as Array<{ imageUrls: string[] | null }>;
      const current = Array.isArray(rows[0]?.imageUrls) ? rows[0].imageUrls : [];
      const merged = Array.from(new Set([...current, ...uploaded]));
      await sql`
        update "XhsRentalListing"
        set
          "imageUrls" = ${JSON.stringify(merged)}::jsonb,
          "postedAt" = coalesce(${nextPostedAt ? nextPostedAt.toISOString() : null}::timestamptz, "postedAt")
        where "id" = ${listingId}
      `;
    };

    let inserted = 0;
    let deduped = 0;
    let skipped = 0;

    for (let index = 0; index < threads.length; index += 1) {
      const candidate = threads[index];
      console.log(`[scrape] (${index + 1}/${threads.length}) ${candidate.url}`);

      let title = candidate.title;
      let rawText = "";
      let imageUrls: string[] = [];
      let postedAt: Date | null = null;
      try {
        const content = await scrapeThreadContent(candidate.url);
        title = content.title || candidate.title;
        rawText = content.rawText;
        imageUrls = content.imageUrls;
        postedAt = content.postedAt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[scrape] skip(抓取失败): url=${candidate.url} error=${message}`);
        skipped += 1;
        continue;
      }
      if (!rawText || normalizeText(rawText).length < 20) {
        skipped += 1;
        continue;
      }

      let structured: StructuredListing;
      try {
        structured = await aiExtractListing(
          openAiApiKey,
          title || candidate.title,
          candidate.url,
          rawText
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[scrape] skip(AI抽取失败): url=${candidate.url} error=${message}`);
        skipped += 1;
        continue;
      }

      const normalizedStructured = normalizeStructuredListing(
        structured,
        title || candidate.title,
        rawText
      );
      const fieldCount = structuredFieldCount(normalizedStructured);
      if (!normalizedStructured.shouldIngest || fieldCount < 3) {
        console.log(
          `[scrape] skip(结构化不足): shouldIngest=${normalizedStructured.shouldIngest}, fields=${fieldCount}, url=${candidate.url}`
        );
        skipped += 1;
        continue;
      }

      const fp = listingFingerprint(
        title || candidate.title,
        rawText,
        normalizedStructured
      );
      const uploadedImageUrls = await uploadImageUrls(blobToken, candidate.url, imageUrls);
      const uniqueUploaded = Array.from(new Set(uploadedImageUrls));

      const existingId =
        existingBySourceUrl.get(candidate.url) ??
        existingByFingerprint.get(fp)?.id ??
        null;
      if (existingId) {
        await mergeImagesAndMaybePostedAt(existingId, uniqueUploaded, postedAt);
        existingByFingerprint.set(fp, { id: existingId, fingerprint: fp });
        existingBySourceUrl.set(candidate.url, existingId);
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
            ${normalizedStructured.title ?? title ?? candidate.title},
            ${rawText},
            ${normalizedStructured.rent},
            ${normalizedStructured.deposit},
            ${normalizedStructured.availableFrom},
            ${normalizedStructured.leaseEndDate},
            ${normalizedStructured.listingType},
            ${normalizedStructured.bedrooms},
            ${normalizedStructured.bathrooms},
            ${normalizedStructured.roomType},
            ${normalizedStructured.propertyName},
            ${normalizedStructured.locationText},
            ${normalizedStructured.furnished},
            ${normalizedStructured.contactMethod},
            ${JSON.stringify(uniqueUploaded)}::jsonb,
            ${postedAt ? postedAt.toISOString() : null},
            ${new Date().toISOString()}
          )
          returning "id"
        `) as Array<{ id: string }>;

        const insertedId = insertedRows[0]?.id;
        if (insertedId) {
          existingByFingerprint.set(fp, { id: insertedId, fingerprint: fp });
          existingBySourceUrl.set(candidate.url, insertedId);

          // 入库即嵌入：否则向量搜索（WHERE embedding IS NOT NULL）看不到新房源。
          // 失败不阻塞抓取，留给 scripts/embed-listings.ts 兜底。
          if (process.env.VOYAGE_API_KEY) {
            try {
              const doc = composeListingEmbeddingDoc({
                rawText,
                title: normalizedStructured.title ?? title ?? candidate.title,
                locationText: normalizedStructured.locationText,
                propertyName: normalizedStructured.propertyName,
                rent: normalizedStructured.rent,
                roomType: normalizedStructured.roomType,
                bedrooms: normalizedStructured.bedrooms,
                bathrooms: normalizedStructured.bathrooms,
                listingType: normalizedStructured.listingType,
                availableFrom: normalizedStructured.availableFrom,
                furnished: normalizedStructured.furnished,
              });
              const vector = await embedText(doc, "document");
              const vectorLiteral = `[${vector.join(",")}]`;
              await sql`
                update "XhsRentalListing"
                set embedding = ${vectorLiteral}::vector
                where "id" = ${insertedId}
              `;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              console.log(
                `[scrape] warn(嵌入失败，稍后可运行 embed-listings.ts 兜底): ${message}`
              );
            }
          }
        }
        inserted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("uq_listing_sourceurl") || message.includes("duplicate key")) {
          console.log(`[scrape] skip(URL已存在): url=${candidate.url}`);
          const rows = (await sql`
            select "id"
            from "XhsRentalListing"
            where "sourceUrl" = ${candidate.url}
            limit 1
          `) as Array<{ id: string }>;
          const foundId = rows[0]?.id;
          if (foundId) {
            await mergeImagesAndMaybePostedAt(foundId, uniqueUploaded, postedAt);
            existingByFingerprint.set(fp, { id: foundId, fingerprint: fp });
            existingBySourceUrl.set(candidate.url, foundId);
          }
          deduped += 1;
          continue;
        }
        throw error;
      }
    }

    console.log(
      `[scrape] 完成: inserted=${inserted}, deduped=${deduped}, skipped=${skipped}`
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("[scrape] 失败:", error);
  process.exitCode = 1;
});
