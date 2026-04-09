import { createHash } from "node:crypto";
import {
  completeRentalCrawlRun,
  createRentalCrawlRun,
  createRentalCrawlRunPost,
  createRentalPost,
  failRentalCrawlRun,
  getRentalPostBySourcePostId,
  hasRentalCrawlRunSeenPost,
  updateRentalPostById,
} from "@/lib/db/rental-queries";
import { parsePublishedAtRaw, parseStructuredRentalData } from "./parser";

const SOURCE_SITE = "chineseinsfbay";
const SOURCE_FORUM = "f_5";
const START_URL = "https://www.chineseinsfbay.com/f/page_viewforum/f_5.html";
const STOP_SEEN_POST_THRESHOLD = Number(
  process.env.RENTAL_CRAWL_SEEN_POST_THRESHOLD ?? "1"
);
const DEFAULT_CHROME_EXECUTABLE = "/usr/local/bin/google-chrome";
const LIST_PAGE_MAX_RETRY = 3;
const DETAIL_PAGE_MAX_RETRY = 2;

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

type BrowserPage = {
  goto: (
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number }
  ) => Promise<unknown>;
  evaluate: <T>(callback: () => T) => Promise<T>;
  close: () => Promise<void>;
};

type BrowserContext = {
  newPage: () => Promise<BrowserPage>;
  close: () => Promise<void>;
};

type Browser = {
  newContext: (options: {
    userAgent: string;
    locale: string;
  }) => Promise<BrowserContext>;
  close: () => Promise<void>;
};

type ChromiumModule = {
  chromium: {
    launch: (options: {
      headless: boolean;
      executablePath?: string;
      channel?: "chrome";
      args: string[];
    }) => Promise<Browser>;
  };
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

function hasValidForumListHtml(html: string): boolean {
  return /page_viewtopic\/t_\d+\.html/i.test(html);
}

async function openListPageWithRetries(
  page: BrowserPage,
  url: string
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= LIST_PAGE_MAX_RETRY; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });

      const html = await page.evaluate(() => document.documentElement.outerHTML);
      if (!hasValidForumListHtml(html)) {
        throw new Error("Forum list HTML does not include topic links");
      }

      return;
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

async function extractListPageData(page: BrowserPage): Promise<ListEvalResult> {
  const result = await page.evaluate<ListEvalResult>(() => {
    const parseNumber = (value: string): number | null => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const extractPostId = (url: string): string | null => {
      const match = url.match(/\/f\/page_viewtopic\/t_(\d+)\.html/i);
      return match?.[1] ?? null;
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

    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/f/page_viewtopic/t_"]')
    );
    const seenPostIds = new Set<string>();
    const items: ForumListItem[] = [];

    for (const anchor of anchors) {
      const row = anchor.closest("tr");
      if (!row) {
        continue;
      }

      const title = anchor.textContent?.trim() ?? "";
      if (title.length === 0) {
        continue;
      }

      const absoluteUrl = new URL(anchor.href, window.location.origin).toString();
      const postId = extractPostId(absoluteUrl);
      if (!postId || seenPostIds.has(postId)) {
        continue;
      }
      seenPostIds.add(postId);

      const rowText = row.textContent?.replaceAll(/\s+/g, " ").trim() ?? "";
      const publishedAtRaw = findPublishedAt(rowText);
      const { replyCount, viewCount } = findReplyView(rowText);
      const authorMatch =
        rowText.match(/作者[:：]?\s*([^\s]+)/i) ?? rowText.match(/\bby\s+([^\s]+)/i);

      items.push({
        title,
        detailUrl: absoluteUrl,
        postId,
        author: authorMatch?.[1] ?? null,
        publishedAtRaw,
        replyCount,
        viewCount,
        isPinned: /置顶|top|sticky/i.test(rowText),
        rawRowText: rowText,
      });
    }

    const nextAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))
      .map((anchor) => {
        const text = anchor.textContent?.trim() ?? "";
        return { text, href: anchor.getAttribute("href") };
      })
      .find((item) => item.text.includes("下一页"));

    const nextPageUrl =
      nextAnchor?.href && nextAnchor.href.length > 0
        ? new URL(nextAnchor.href, window.location.origin).toString()
        : null;

    return { items, nextPageUrl };
  });

  if (result.items.length === 0) {
    throw new Error("No forum items found on list page. Site may be blocking this runtime.");
  }

  return {
    items: result.items,
    nextPageUrl: result.nextPageUrl,
  };
}

async function extractDetailData(
  page: BrowserPage,
  detailUrl: string
): Promise<DetailData> {
  let detail: { contentText: string; author: string | null } | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= DETAIL_PAGE_MAX_RETRY; attempt += 1) {
    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      detail = await page.evaluate(() => {
        const normalize = (value: string): string =>
          value.replaceAll(/\s+/g, " ").trim();

        const selectorCandidates = [
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

        const candidateTexts = selectorCandidates
          .map((selector) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) {
              return "";
            }
            return normalize(element.innerText || "");
          })
          .filter((value) => value.length > 0);

        let contentText = "";
        for (const candidate of candidateTexts) {
          if (candidate.length > contentText.length) {
            contentText = candidate;
          }
        }

        if (contentText.length === 0) {
          contentText = normalize(document.body.innerText || "");
        }

        const textForAuthor = normalize(document.body.innerText || "");
        const authorMatch =
          textForAuthor.match(/作者[:：]\s*([^\s]+)/i) ??
          textForAuthor.match(/\bby\s+([^\s]+)/i);

        return {
          contentText,
          author: authorMatch?.[1] ?? null,
        };
      });

      if (detail.contentText.length === 0) {
        throw new Error("Empty detail page content");
      }

      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown detail error";
      lastError = new Error(`Detail page attempt ${attempt} failed: ${message}`);
      if (attempt < DETAIL_PAGE_MAX_RETRY) {
        await sleep(600 * attempt);
      }
    }
  }

  if (!detail) {
    throw lastError ?? new Error("Failed to parse detail page");
  }

  return {
    contentText: sanitizeContentText(detail.contentText),
    author: detail.author,
  };
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

  let browser: Browser | null = null;

  try {
    const { chromium } = (await import("@playwright/test")) as ChromiumModule;
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? DEFAULT_CHROME_EXECUTABLE;

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "zh-CN",
    });
    const listPage = await context.newPage();
    const detailPage = await context.newPage();

    let currentListUrl: string | null = START_URL;
    let encounteredSeenPostCount = 0;

    while (currentListUrl) {
      await openListPageWithRetries(listPage, currentListUrl);
      const { items, nextPageUrl } = await extractListPageData(listPage);
      stats.pagesCrawled += 1;

      for (const item of items) {
        const seenInPastRun = await hasRentalCrawlRunSeenPost({
          postId: item.postId,
          sourceSite: SOURCE_SITE,
          sourceForum: SOURCE_FORUM,
        });

        await createRentalCrawlRunPost({
          runId,
          postId: item.postId,
          isPinned: item.isPinned,
          createdAt: new Date(),
        });

        if (seenInPastRun) {
          encounteredSeenPostCount += 1;
          stats.skippedCount += 1;

          if (encounteredSeenPostCount >= Math.max(1, STOP_SEEN_POST_THRESHOLD)) {
            stats.stopReason = "encountered_seen_post_from_previous_runs";
            currentListUrl = null;
            break;
          }

          continue;
        }

        encounteredSeenPostCount = 0;

        const existingPost = await getRentalPostBySourcePostId({
          sourceSite: SOURCE_SITE,
          sourceForum: SOURCE_FORUM,
          postId: item.postId,
        });

        try {
          const detail = await extractDetailData(detailPage, item.detailUrl);
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

    await detailPage.close();
    await listPage.close();
    await context.close();

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
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
