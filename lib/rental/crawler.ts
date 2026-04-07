import { createHash } from "node:crypto";
import { load } from "cheerio";
import {
  completeRentalCrawlRun,
  createRentalCrawlRun,
  createRentalPost,
  failRentalCrawlRun,
  getRentalPostBySourcePostId,
  updateRentalPostById,
} from "@/lib/db/rental-queries";
import { parsePublishedAtRaw, parseStructuredRentalData } from "./parser";

const SOURCE_SITE = "chineseinsfbay";
const SOURCE_FORUM = "f_5";
const START_URL = "https://www.chineseinsfbay.com/f/page_viewforum/f_5.html";
const STOP_EXISTING_NORMAL_THRESHOLD = Number(
  process.env.RENTAL_CRAWL_EXISTING_THRESHOLD ?? "1"
);
const SCRAPER_PROVIDER = (process.env.SCRAPER_PROVIDER ?? "none").toLowerCase();
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY ?? "";
const LIST_PAGE_MAX_RETRY = 3;
const DETAIL_PAGE_MAX_RETRY = 2;
const REQUEST_TIMEOUT_MS = Number(
  process.env.RENTAL_CRAWL_REQUEST_TIMEOUT_MS ?? "45000"
);

type CrawlStats = {
  pagesCrawled: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  stopReason: string | null;
};

type ForumListItem = {
  title: string;
  detailUrl: string;
  postId: string;
  author: string | null;
  publishedAtRaw: string | null;
  replyCount: number | null;
  viewCount: number | null;
  isPinned: boolean;
  rawRowText: string;
};

type DetailData = {
  contentText: string;
  author: string | null;
};

type HtmlFetchSource = "direct" | "provider";

type HtmlFetchResult = {
  source: HtmlFetchSource;
  html: string;
};

type ListEvalResult = {
  items: ForumListItem[];
  nextPageUrl: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createContentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sanitizeContentText(input: string): string {
  return input.replaceAll(/\s+/g, " ").trim();
}

function buildRequestHeaders(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildRequestHeaders(),
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function buildProviderUrl(targetUrl: string): string | null {
  if (SCRAPER_PROVIDER === "zenrows") {
    const url = new URL("https://api.zenrows.com/v1/");
    url.searchParams.set("url", targetUrl);
    url.searchParams.set("apikey", SCRAPER_API_KEY);
    url.searchParams.set("js_render", "true");
    url.searchParams.set("premium_proxy", "true");
    return url.toString();
  }

  if (SCRAPER_PROVIDER === "scrapingbee") {
    const url = new URL("https://app.scrapingbee.com/api/v1/");
    url.searchParams.set("api_key", SCRAPER_API_KEY);
    url.searchParams.set("url", targetUrl);
    url.searchParams.set("render_js", "true");
    url.searchParams.set("premium_proxy", "true");
    url.searchParams.set("country_code", "us");
    return url.toString();
  }

  return null;
}

async function fetchHtmlByProvider(targetUrl: string): Promise<string | null> {
  if (SCRAPER_PROVIDER === "none") {
    return null;
  }

  if (SCRAPER_API_KEY.length === 0) {
    throw new Error(`SCRAPER_API_KEY is required for provider ${SCRAPER_PROVIDER}`);
  }

  const providerUrl = buildProviderUrl(targetUrl);
  if (!providerUrl) {
    throw new Error(`Unsupported SCRAPER_PROVIDER: ${SCRAPER_PROVIDER}`);
  }

  return await fetchHtml(providerUrl);
}

function hasValidForumListHtml(html: string): boolean {
  return /page_viewtopic\/t_\d+\.html/i.test(html);
}

async function openListPageWithRetries(
  url: string
): Promise<HtmlFetchResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= LIST_PAGE_MAX_RETRY; attempt += 1) {
    try {
      const directHtml = await fetchHtml(url);
      if (hasValidForumListHtml(directHtml)) {
        return { source: "direct", html: directHtml };
      }

      const providerHtml = await fetchHtmlByProvider(url);
      if (providerHtml && hasValidForumListHtml(providerHtml)) {
        return { source: "provider", html: providerHtml };
      }

      throw new Error("Forum list HTML does not include topic links");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown list error";
      lastError = new Error(`List page attempt ${attempt} failed: ${message}`);

      if (attempt < LIST_PAGE_MAX_RETRY) {
        await sleep(800 * attempt);
      }
    }
  }

  throw lastError ?? new Error("Failed to load forum list page");
}

export function extractListPageData(
  html: string,
  baseUrl: string
): Promise<ListEvalResult> {
  const $ = load(html);
  const seenPostIds = new Set<string>();
  const items: ForumListItem[] = [];

  const parseNumber = (value: string): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const findPublishedAt = (rowText: string): string | null => {
    const normalized = rowText.replaceAll(/\s+/g, " ").trim();
    const dateMatch = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (dateMatch?.[0]) {
      return dateMatch[0];
    }
    const timeMatch = normalized.match(/\b\d{1,2}:\d{2}\s*[ap]m\b/i);
    return timeMatch?.[0] ?? null;
  };

  const findReplyView = (
    rowText: string
  ): { replyCount: number | null; viewCount: number | null } => {
    const slashMatch = rowText.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      return {
        replyCount: parseNumber(slashMatch[1]),
        viewCount: parseNumber(slashMatch[2]),
      };
    }

    const numbers = [...rowText.matchAll(/\b\d+\b/g)].map((match) =>
      Number(match[0])
    );
    if (numbers.length < 2) {
      return { replyCount: null, viewCount: null };
    }

    return {
      replyCount: numbers.at(-2) ?? null,
      viewCount: numbers.at(-1) ?? null,
    };
  };

  const topicAnchors = $('a[href*="/f/page_viewtopic/t_"]');

  for (const anchorElement of topicAnchors.toArray()) {
    const anchor = $(anchorElement);
    const title = anchor.text().trim();
    if (title.length === 0) {
      continue;
    }

    const href = anchor.attr("href");
    if (!href) {
      continue;
    }

    const detailUrl = new URL(href, baseUrl).toString();
    const postIdMatch = detailUrl.match(/\/f\/page_viewtopic\/t_(\d+)\.html/i);
    const postId = postIdMatch?.[1];
    if (!postId || seenPostIds.has(postId)) {
      continue;
    }

    seenPostIds.add(postId);
    const rowText = sanitizeContentText(
      anchor.closest("tr").text() || anchor.parent().text() || title
    );
    const { replyCount, viewCount } = findReplyView(rowText);
    const publishedAtRaw = findPublishedAt(rowText);
    const authorMatch =
      rowText.match(/作者[:：]?\s*([^\s]+)/i) ??
      rowText.match(/\bby\s+([^\s]+)/i);

    items.push({
      title,
      detailUrl,
      postId,
      author: authorMatch?.[1] ?? null,
      publishedAtRaw,
      replyCount,
      viewCount,
      isPinned: /置顶|top|sticky/i.test(rowText),
      rawRowText: rowText,
    });
  }

  let nextPageUrl: string | null = null;
  for (const anchorElement of $("a").toArray()) {
    const anchor = $(anchorElement);
    const text = anchor.text().trim();
    if (!text.includes("下一页")) {
      continue;
    }
    const href = anchor.attr("href");
    if (href) {
      nextPageUrl = new URL(href, baseUrl).toString();
    }
    break;
  }

  if (items.length === 0) {
    throw new Error("No forum items found on list page. Site may be blocking this runtime.");
  }

  return { items, nextPageUrl };
}

export function extractDetailData(html: string): DetailData {
  const $ = load(html);
  const selectors = [
    "#post_content",
    ".post_content",
    ".post-content",
    ".topic-content",
    ".message",
    ".viewtopic",
    ".entry-content",
    "td.postbody",
    "article",
    "main",
  ];

  let contentText = "";
  for (const selector of selectors) {
    const text = sanitizeContentText($(selector).text());
    if (text.length > contentText.length) {
      contentText = text;
    }
  }

  if (contentText.length === 0) {
    contentText = sanitizeContentText($("body").text());
  }

  const bodyText = sanitizeContentText($("body").text());
  const authorMatch =
    bodyText.match(/作者[:：]\s*([^\s]+)/i) ?? bodyText.match(/\bby\s+([^\s]+)/i);

  return {
    contentText,
    author: authorMatch?.[1] ?? null,
  };
}

async function openDetailPageWithRetries(url: string): Promise<HtmlFetchResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= DETAIL_PAGE_MAX_RETRY; attempt += 1) {
    try {
      const directHtml = await fetchHtml(url);
      if (extractDetailData(directHtml).contentText.length > 0) {
        return { source: "direct", html: directHtml };
      }

      const providerHtml = await fetchHtmlByProvider(url);
      if (providerHtml && extractDetailData(providerHtml).contentText.length > 0) {
        return { source: "provider", html: providerHtml };
      }

      throw new Error("Empty detail page content");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown detail error";
      lastError = new Error(`Detail page attempt ${attempt} failed: ${message}`);
      if (attempt < DETAIL_PAGE_MAX_RETRY) {
        await sleep(600 * attempt);
      }
    }
  }

  throw lastError ?? new Error("Failed to parse detail page");
}

export async function crawlChineseInSfBayRentals() {
  const stats: CrawlStats = {
    pagesCrawled: 0,
    newCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    stopReason: null,
  };

  const runId = await createRentalCrawlRun({
    sourceSite: SOURCE_SITE,
    sourceForum: SOURCE_FORUM,
  });

  try {
    let currentListUrl: string | null = START_URL;
    let encounteredExistingNormalCount = 0;

    while (currentListUrl) {
      const listPage = await openListPageWithRetries(currentListUrl);
      const { items, nextPageUrl } = await extractListPageData(
        listPage.html,
        currentListUrl
      );
      stats.pagesCrawled += 1;

      for (const item of items) {
        const existingPost = await getRentalPostBySourcePostId({
          sourceSite: SOURCE_SITE,
          sourceForum: SOURCE_FORUM,
          postId: item.postId,
        });

        if (existingPost && !item.isPinned) {
          encounteredExistingNormalCount += 1;
          stats.skippedCount += 1;

          if (
            encounteredExistingNormalCount >=
            Math.max(1, STOP_EXISTING_NORMAL_THRESHOLD)
          ) {
            stats.stopReason = "encountered_existing_normal_post";
            currentListUrl = null;
            break;
          }
        } else {
          encounteredExistingNormalCount = 0;
        }

        try {
          const detailPage = await openDetailPageWithRetries(item.detailUrl);
          const detail = extractDetailData(detailPage.html);
          const mergedContent = `${item.title}\n${detail.contentText}`;
          const contentHash = createContentHash(mergedContent);
          const seenAt = new Date();
          const structured = parseStructuredRentalData({
            title: item.title,
            contentText: detail.contentText,
          });
          const publishedAt = item.publishedAtRaw
            ? parsePublishedAtRaw(item.publishedAtRaw)
            : null;
          const finalAuthor = item.author ?? detail.author;
          const rawJson = {
            list: {
              rawRowText: item.rawRowText,
              publishedAtRaw: item.publishedAtRaw,
              replyCount: item.replyCount,
              viewCount: item.viewCount,
              isPinned: item.isPinned,
            },
            detail: {
              author: detail.author,
              contentTextLength: detail.contentText.length,
              source: detailPage.source,
            },
          };

          if (!existingPost) {
            await createRentalPost({
              sourceSite: SOURCE_SITE,
              sourceForum: SOURCE_FORUM,
              postId: item.postId,
              detailUrl: item.detailUrl,
              title: item.title,
              author: finalAuthor,
              publishedAt,
              publishedAtRaw: item.publishedAtRaw,
              replyCount: item.replyCount,
              viewCount: item.viewCount,
              isPinned: item.isPinned,
              contentText: detail.contentText,
              contactRaw: structured.contactRaw,
              priceRaw: structured.priceRaw,
              locationRaw: structured.locationRaw,
              structured: structured.structured,
              contentHash,
              rawJson,
              seenAt,
            });
            stats.newCount += 1;
          } else if (existingPost.contentHash !== contentHash) {
            await updateRentalPostById({
              id: existingPost.id,
              detailUrl: item.detailUrl,
              title: item.title,
              author: finalAuthor,
              publishedAt,
              publishedAtRaw: item.publishedAtRaw,
              replyCount: item.replyCount,
              viewCount: item.viewCount,
              isPinned: item.isPinned,
              contentText: detail.contentText,
              contactRaw: structured.contactRaw,
              priceRaw: structured.priceRaw,
              locationRaw: structured.locationRaw,
              structured: structured.structured,
              contentHash,
              rawJson,
              seenAt,
            });
            stats.updatedCount += 1;
          } else {
            stats.skippedCount += 1;
          }
        } catch (_error) {
          stats.errorCount += 1;
        }

        await sleep(1_000 + Math.floor(Math.random() * 600));
      }

      if (!currentListUrl) {
        break;
      }

      if (!nextPageUrl) {
        stats.stopReason = stats.stopReason ?? "no_next_page";
        break;
      }

      currentListUrl = nextPageUrl;
      await sleep(1_200 + Math.floor(Math.random() * 500));
    }

    await completeRentalCrawlRun({
      runId,
      pagesCrawled: stats.pagesCrawled,
      newCount: stats.newCount,
      updatedCount: stats.updatedCount,
      skippedCount: stats.skippedCount,
      errorCount: stats.errorCount,
      stopReason: stats.stopReason,
    });

    return {
      runId,
      ...stats,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown crawl error";
    await failRentalCrawlRun({
      runId,
      pagesCrawled: stats.pagesCrawled,
      newCount: stats.newCount,
      updatedCount: stats.updatedCount,
      skippedCount: stats.skippedCount,
      errorCount: stats.errorCount,
      stopReason: stats.stopReason,
      errorMessage,
    });
    throw error;
  }
}
