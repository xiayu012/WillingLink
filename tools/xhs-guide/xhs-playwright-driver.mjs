import { chromium } from "@playwright/test";

const profileDir =
  process.env.XHS_CHROME_PROFILE ??
  (process.platform === "win32" ? "D:\\xhs-chrome-profile" : "./xhs-chrome-profile");

const startUrl = process.env.XHS_START_URL ?? "https://www.xiaohongshu.com";
const actionDelayMinMs = Number(process.env.XHS_ACTION_DELAY_MIN_MS ?? 500);
const actionDelayMaxMs = Number(process.env.XHS_ACTION_DELAY_MAX_MS ?? 1500);
const idleScrollEveryMs = Number(process.env.XHS_IDLE_SCROLL_EVERY_MS ?? 16_000);
const idlePollMinMs = Number(process.env.XHS_IDLE_POLL_MIN_MS ?? 280);
const idlePollMaxMs = Number(process.env.XHS_IDLE_POLL_MAX_MS ?? 520);
const idleScrollMinPx = Number(process.env.XHS_IDLE_SCROLL_MIN_PX ?? 300);
const idleScrollMaxPx = Number(process.env.XHS_IDLE_SCROLL_MAX_PX ?? 600);
const microPauseChance = Number(process.env.XHS_MICRO_PAUSE_CHANCE ?? 0.18);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min, max) =>
  Math.floor(Math.random() * (Math.max(min, max) - min + 1)) + min;

const randomFloat = (min, max) => Math.random() * (Math.max(min, max) - min) + min;

const actionDelay = () => sleep(randomInt(actionDelayMinMs, actionDelayMaxMs));

const maybeMicroPause = async () => {
  if (Math.random() > microPauseChance) {
    return;
  }
  await sleep(randomInt(900, 2400));
};

const log = (message, extra) => {
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  process.stdout.write(`[xhs-driver] ${message}${suffix}\n`);
};

const getHighlights = async (page) =>
  page.evaluate(() => {
    const boxes = Array.from(
      document.querySelectorAll("#xhs-guide-overlay-root .xhs-guide-highlight-box")
    );

    const scoreHighlight = (text, kind) => {
      if (text.includes("关闭")) {
        return 100;
      }
      if (text.includes("复制正文")) {
        return 90;
      }
      if (text.includes("分享")) {
        return 80;
      }
      if (text.includes("右侧箭头") || text.includes("翻页")) {
        return 70;
      }
      if (kind === "feed-title" || text.includes("湾区租房相关")) {
        return 60;
      }
      return 10;
    };

    return boxes
      .map((box, index) => {
        const rect = box.getBoundingClientRect();
        const text = box.getAttribute("data-xhs-guide-text") ?? "";
        const kind = box.getAttribute("data-xhs-guide-kind") ?? "";
        return {
          index,
          kind,
          text,
          score: scoreHighlight(text, kind),
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom >= 0 &&
            rect.right >= 0 &&
            rect.top <= window.innerHeight &&
            rect.left <= window.innerWidth,
        };
      })
      .filter((item) => item.visible)
      .sort((a, b) => b.score - a.score || a.index - b.index);
  });

const humanMoveTo = async (page, x, y) => {
  const approachX = x + randomInt(-90, 90);
  const approachY = y + randomInt(-55, 55);
  await page.mouse.move(approachX, approachY, { steps: randomInt(12, 26) });
  await sleep(randomInt(120, 360));

  const midX = x + randomInt(-24, 24);
  const midY = y + randomInt(-18, 18);
  await page.mouse.move(midX, midY, { steps: randomInt(7, 15) });
  await sleep(randomInt(80, 260));

  await page.mouse.move(x, y, { steps: randomInt(5, 12) });
};

const touchLikeTremble = async (page, x, y) => {
  const trembleCount = randomInt(2, 5);
  for (let i = 0; i < trembleCount; i += 1) {
    await page.mouse.move(x + randomFloat(-2.2, 2.2), y + randomFloat(-1.8, 1.8), {
      steps: randomInt(1, 3),
    });
    await sleep(randomInt(18, 55));
  }
};

const humanClick = async (page, target) => {
  const safeHalfWidth = Math.max(3, Math.min(12, target.width / 3));
  const safeHalfHeight = Math.max(3, Math.min(10, target.height / 3));
  const x = target.x + randomFloat(-safeHalfWidth, safeHalfWidth);
  const y = target.y + randomFloat(-safeHalfHeight, safeHalfHeight);

  await humanMoveTo(page, x, y);
  await touchLikeTremble(page, x, y);
  await sleep(randomInt(70, 260));
  await page.mouse.down();
  await touchLikeTremble(page, x, y);
  await sleep(randomInt(55, 170));
  await page.mouse.up();
  await page.mouse.move(x + randomInt(-18, 18), y + randomInt(-14, 14), {
    steps: randomInt(3, 8),
  });
};

const humanScroll = async (page, totalDeltaY) => {
  const segments = randomInt(4, 8);
  let remaining = totalDeltaY;
  for (let i = 0; i < segments; i += 1) {
    const isLast = i === segments - 1;
    const slice = isLast
      ? remaining
      : Math.round((totalDeltaY / segments) * randomFloat(0.65, 1.35));
    remaining -= slice;
    await page.mouse.wheel(randomInt(-12, 12), slice);
    await sleep(randomInt(90, 260));
  }

  if (Math.random() < 0.28) {
    await sleep(randomInt(160, 420));
    await page.mouse.wheel(randomInt(-8, 8), -randomInt(20, 70));
  }
};

const maybeIdleScroll = async (page, lastActionAt) => {
  if (Date.now() - lastActionAt < idleScrollEveryMs) {
    return false;
  }
  const isDetailPage = page.url().includes("/explore/") || page.url().includes("/discovery/item/");
  if (isDetailPage) {
    return false;
  }
  await humanScroll(page, randomInt(idleScrollMinPx, idleScrollMaxPx));
  log("未发现高亮，信息流轻微下滑");
  return true;
};

const main = async () => {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    ignoreDefaultArgs: [
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
    ],
    args: ["--start-maximized"],
  });

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://www.xiaohongshu.com",
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(10_000);

  log("Chrome 已启动", { profileDir });
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  log("已打开小红书", { url: page.url() });

  let lastActionAt = Date.now();
  let lastClickKey = "";
  let lastClickAt = 0;

  while (true) {
    const highlights = await getHighlights(page);
    const target = highlights[0];

    if (target) {
      const clickKey = `${target.text}:${Math.round(target.x)}:${Math.round(target.y)}`;
      if (clickKey !== lastClickKey || Date.now() - lastClickAt > 3000) {
        log("点击高亮提示", {
          text: target.text,
          kind: target.kind,
          x: Math.round(target.x),
          y: Math.round(target.y),
        });
        await actionDelay();
        await humanClick(page, target);
        lastActionAt = Date.now();
        lastClickKey = clickKey;
        lastClickAt = Date.now();
        await sleep(randomInt(1200, 3200));
        await maybeMicroPause();
        continue;
      }
    }

    const scrolled = await maybeIdleScroll(page, lastActionAt);
    if (scrolled) {
      lastActionAt = Date.now();
      lastClickKey = "";
      await maybeMicroPause();
      continue;
    }

    // 分段滚动内部已有停顿；此处仅保留轻量轮询，避免空转
    await sleep(randomInt(idlePollMinMs, idlePollMaxMs));
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (message.includes("Target page, context or browser has been closed")) {
    log("浏览器已关闭，驱动正常退出");
    return;
  }
  process.stderr.write(`[xhs-driver] fatal ${message}\n`);
  process.exitCode = 1;
});
