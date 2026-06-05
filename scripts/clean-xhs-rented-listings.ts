import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local" });
loadDotenv();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_LIMIT = 800;
const DEFAULT_MIN_DELAY_SECONDS = 45;
const DEFAULT_MAX_DELAY_SECONDS = 171;
const PAGE_TIMEOUT_MS = 45_000;
const CONTENT_TIMEOUT_MS = 20_000;
const PROFILE_DIR = join(
  process.cwd(),
  ".playwright",
  "xhs-rental-cleaner-profile"
);
const XHS_URL_PATTERN = "%xiaohongshu.com%";
const XHSLINK_URL_PATTERN = "%xhslink.com%";

const RENTED_PATTERNS = [
  /已\s*(?:出租|租出|租掉|出掉|租走|被租)/u,
  /(?:已经|已經|己经)\s*(?:出租|租出|租掉|出掉|租走|被租|没有了|沒了|没了)/u,
  /(?:房子|房间|房間|房源|卧室|臥室|这间|這間).{0,12}(?:已|已经|已經).{0,12}(?:租|出)/u,
  /(?:租|出).{0,4}(?:掉了|出去了|走了)/u,
  /(?:房子|房间|房間|房源|卧室|臥室).{0,12}(?:没有了|沒了|没了|暂无|暫無)/u,
] as const;

const QUESTION_OR_UNCERTAIN_PATTERN =
  /(?:吗|嗎|嘛|\?|？|请问|請問|还有|還有|还在|還在|还没|還沒|有没有|有沒有)/u;

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

type RentedSignal = {
  element: keyof ElementTexts;
  snippet: string;
  pattern: string;
};

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

function findRentedSignal(texts: ElementTexts): RentedSignal | null {
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
        element,
        snippet,
        pattern: pattern.source,
      };
    }
  }

  return null;
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
  sourceUrl: string
): Promise<ElementTexts> {
  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  await waitForXhsContent(page);
  await humanPause(1500, 5000);

  const title = await safeInnerText(page, "#detail-title");
  const noteContent = await safeInnerText(page, ".note-content");

  await page
    .locator(".comments-container")
    .first()
    .scrollIntoViewIfNeeded({ timeout: 5000 })
    .catch(ignoreOptionalError);
  await lightlyScroll(page);

  const comments = await safeInnerText(page, ".comments-container");

  return {
    title,
    noteContent,
    comments,
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
  const headless = envBoolean("XHS_CLEANER_HEADLESS", false);
  const dryRun = envBoolean("XHS_CLEANER_DRY_RUN", false);

  if (minDelaySeconds > maxDelaySeconds) {
    throw new Error(
      "XHS_CLEANER_MIN_DELAY_SECONDS must be <= XHS_CLEANER_MAX_DELAY_SECONDS"
    );
  }

  const sql = postgres(postgresUrl, { max: 1 });
  const context = await createBrowserContext(headless);

  let candidates: ListingRow[] = [];
  let checkedInWindow = 0;
  let deletedInWindow = 0;
  let windowStartedAt = Date.now();

  console.log(
    `[start] dailyLimit=${dailyLimit}, delay=${minDelaySeconds}-${maxDelaySeconds}s, headless=${headless}, dryRun=${dryRun}`
  );
  console.log(`[browser] 使用持久化 profile：${PROFILE_DIR}`);

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
        candidates = await loadCandidates(sql);
        console.log(`[db] 本轮随机候选 ${candidates.length} 条`);
        if (candidates.length === 0) {
          await delay(30 * 60 * 1000);
          continue;
        }
      }

      const row = candidates.shift();
      if (!row) {
        continue;
      }

      const page = await context.newPage();
      try {
        console.log(
          `[check] ${checkedInWindow + 1}/${dailyLimit} ${row.id} ${row.sourceUrl}`
        );
        const texts = await readListingPage(page, row.sourceUrl);
        const signal = findRentedSignal(texts);
        checkedInWindow += 1;

        if (!signal) {
          console.log(`[keep] 未发现已出租信号：${row.id}`);
        } else if (dryRun) {
          console.log(
            `[dry-run] 将删除 ${row.id}，命中 ${signal.element}：${signal.snippet}`
          );
        } else {
          const deleted = await deleteListing(sql, row);
          if (deleted) {
            deletedInWindow += 1;
            console.log(
              `[delete] 已删除 ${row.id}，命中 ${signal.element}：${signal.snippet}`
            );
          } else {
            console.log(
              `[skip] 删除时未找到行，可能已被其他任务处理：${row.id}`
            );
          }
        }

        console.log(
          `[stats] 24小时窗口 checked=${checkedInWindow}, deleted=${deletedInWindow}`
        );
      } catch (error) {
        checkedInWindow += 1;
        console.error(`[error] 检查失败 ${row.id}:`, error);
      } finally {
        await page.close().catch(ignoreOptionalError);
      }

      await sleepBetweenChecks(minDelaySeconds, maxDelaySeconds);
    }
  } finally {
    await context.close();
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
