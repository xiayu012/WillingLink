// ==UserScript==
// @name         xhs-guide-title-judge
// @namespace    https://willinglink.local/
// @version      0.7.9
// @description  小红书多标题识别高亮 + 详情页复制正文指引
// @author       local
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        clipboardRead
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/* global GM, GM_setClipboard, GM_xmlhttpRequest */

(() => {
  "use strict";

  const LOG_PREFIX = "[xhs-guide]";
  const SCRIPT_VERSION = "0.7.9";
  const MAX_HIGHLIGHT_COUNT = 10;
  const VIEWPORT_MARGIN = 8;
  /** 信息流高亮仅框标题行，超过此高度视为误匹配到整卡容器 */
  const TITLE_HIGHLIGHT_MAX_HEIGHT = 80;

  const DEFAULT_CONFIG = {
    app: {
      id: "title-judge-v1",
      urlPattern: "xiaohongshu.com",
      loopIntervalMs: 1800,
    },
    titleScan: {
      selectorCandidates: [
        'a[href*="/explore/"] .title span',
        'a[href*="/explore/"] footer .title span',
        "section footer .title span",
        "section .title span",
        'a[href*="/explore/"] h3 span',
        'a[href*="/explore/"] h3',
      ],
      minTitleLength: 4,
      maxTitlesPerRound: 20,
    },
    judgement: {
      enableLlmReview: true,
      llmTimeoutMs: 12000,
      maxLlmReviewsPerRound: 12,
      llmMinIntervalMs: 300,
      minConfidenceToHighlight: 0.6,
      rule: {
        /**
         * 强命中列表：同时命中城市词 + 租房词即可跳过 LLM（节省开销）。
         * 这里追求完整覆盖，漏掉的交给 LLM 判断。
         */
        bayAreaWords: [
          "湾区", "Bay Area", "bay area",
          "San Francisco", "SF", "旧金山",
          "San Jose", "SJ", "South Bay", "南湾",
          "Oakland", "East Bay", "东湾",
          "Fremont", "Milpitas", "Cupertino",
          "Santa Clara", "Mountain View", "Sunnyvale",
          "Palo Alto", "Los Altos", "Menlo Park",
          "Redwood City", "Foster City", "San Mateo",
          "Daly City", "San Bruno",
          "Berkeley", "伯克利",
          "Hayward", "Alameda", "Campbell",
          "Saratoga", "Los Gatos",
          "Stanford", "斯坦福", "硅谷", "North Bay", "北湾",
          "SJSU", "UCSF", "SCU",
        ],
        rentalWords: [
          "室友", "招租", "出租", "转租", "求租",
          "短租", "合租", "租房", "一房", "两房", "主卧", "次卧",
          "1b", "2b", "1bd", "2bd", "studio",
          "lease", "sublease", "roommate", "rent",
          "apartment", "condo", "公寓",
          "找房", "寻房", "搬家", "入住", "押金", "月租",
          "独卫", "独立", "furnished",
        ],
        strongRentalWords: [
          "招租", "出租", "转租", "求租", "短租", "找房",
          "找室友", "合租", "sublease", "roommate", "for rent",
        ],
        /**
         * 经验/科普/非交易信号词：出现时降级强命中为"先高亮后 LLM 复核"
         * 防止"湾区租房避雷"之类的经验帖被直接跳过 LLM
         */
        experienceWords: [
          "避雷", "避坑", "攻略", "经验", "干货", "科普",
          "总结", "注意事项", "新手", "小白", "tips", "guide",
          "踩坑", "防骗", "测评", "对比", "盘点", "必看",
          "吐槽", "心得", "分享", "指南", "教程", "推荐",
        ],
        /**
         * 强排除词：含以下词且无湾区信号，直接拒绝（减少 LLM 浪费）
         * 只放绝对不可能是湾区租房的强信号词。
         */
        mainlandOnlyWords: [
          "北京", "上海", "广州", "深圳", "成都", "杭州",
          "武汉", "西安", "南京", "苏州", "重庆", "天津",
          "长沙", "郑州", "厦门", "青岛", "大连",
        ],
      },
      llm: {
        endpoint: "https://api.openai.com/v1/chat/completions",
        apiKey: "",
        model: "gpt-4o-mini",
      },
    },
    highlight: {
      borderColor: "#ff2442",
      overlayShadow: "none",
      /** 仅信息流标题高亮：单层半透明灰 mask，不随标题数量叠加 */
      titleMaskColor: "rgba(0, 0, 0, 0.35)",
      hintPrefix: "湾区租房相关",
    },
    detailCopy: {
      pathKeywords: ["/explore/", "/discovery/item/"],
      contentSelectorCandidates: [
        'span[data-v-2de80b2e]',
        "span.note-text",
        'article span[data-v-2de80b2e]',
        'article [class*="content"] span',
        'article span',
      ],
      buttonText: "复制正文",
      copiedText: "已复制",
      pendingShareText: "先完成分享同步",
      copyFailText: "复制失败",
      missingText: "未找到正文",
      hintText: "点击右下角按钮复制正文",
      carouselArrowHint: "手动点右侧箭头翻页，每张主图会上传到后端",
      carouselDoneCloseHint: "轮播图已到最后一张，点击左上角关闭",
      shareHint: "点击分享按钮复制真实链接",
      pollIntervalMs: 1500,
    },
    /** 复制成功后 POST 到 Next /api/xhs/rental-ingest。请用 https 根地址，避免 http→https 重定向触发 CORS 预检失败 */
    ingest: {
      enable: true,
      baseUrl: "https://willinglink.vercel.app",
    },
  };

  const state = {
    overlayRoot: null,
    judgeCache: new Map(),
    inFlightText: new Set(),
    matchedById: new Map(),
    dismissedTitleKeys: new Set(),
    titleClickHandler: null,
    llmReviewedInRound: 0,
    lastLlmCallAt: 0,
    analyzeInFlight: false,
    analyzeScheduled: false,
    loopTimer: 0,
    detailTimer: 0,
    rafId: 0,
    observer: null,
    detailContentElement: null,
    detailCopyButton: null,
    scrollHandler: null,
    resizeHandler: null,
    mode: "idle",
    currentUrl: window.location.href,
    routeTimer: 0,
    carouselObserver: null,
    carouselObserveRoot: null,
    carouselCheckTimers: new Set(),
    uploadedCarouselSrcs: new Set(),
    carouselInFlight: new Set(),
    carouselUploadQueue: [],
    carouselQueuedSrcs: new Set(),
    carouselUploading: false,
    carouselArrowElement: null,
    carouselClickHandler: null,
    videoSeekRunning: false,
    videoSeekDoneKey: "",
    videoSeekAbort: false,
    detailIngestReady: false,
    listingId: null,
    listingKind: null,
    shareUrlDone: false,
    /** API 返回前用户已点分享时缓存的链接，API 完成后立即提交 */
    pendingShareUrl: null,
    shareDocClickHandler: null,
    shareCopyHandler: null,
    bodyCopied: false,
    shareUpdateInFlight: false,
    pageClipboardBridgeInjected: false,
    pageClipboardMessageHandler: null,
  };

  const VIDEO_SEEK_STEP_SEC = 5;
  const VIDEO_SEEK_MAX_FRAMES = 120;
  const VIDEO_SEEK_TIMEOUT_MS = 3500;
  /** 在用户点击手势内短间隔连读剪贴板（ms） */
  const SHARE_CLIPBOARD_BURST_MS = [0, 80, 200, 400, 800, 1500, 2500];

  const logInfo = (message, extra) => {
    if (extra === undefined) {
      console.info(`${LOG_PREFIX} ${message}`);
      return;
    }
    console.info(`${LOG_PREFIX} ${message}`, extra);
  };

  const logWarn = (message, extra) => {
    if (extra === undefined) {
      console.warn(`${LOG_PREFIX} ${message}`);
      return;
    }
    console.warn(`${LOG_PREFIX} ${message}`, extra);
  };

  /**
   * Tampermonkey 5+ 使用 GM.xmlHttpRequest（Promise）；旧版为 GM_xmlhttpRequest（回调）。
   * 二者均在扩展上下文发请求，不触发页面 CORS 预检；若都不可用会退回 fetch（易 CORS）。
   */
  const gmHttpPost = (url, headers, bodyString) => {
    const detail = {
      method: "POST",
      url,
      headers,
      data: bodyString,
    };

    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM.xmlHttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              responseText: response.responseText ?? response.response ?? "",
            });
          },
          onerror: () => reject(new Error("GM.xmlHttpRequest onerror")),
          ontimeout: () => reject(new Error("GM.xmlHttpRequest timeout")),
        });
      });
    }

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              responseText: response.responseText ?? "",
            });
          },
          onerror: () => reject(new Error("GM_xmlhttpRequest onerror")),
          ontimeout: () => reject(new Error("GM_xmlhttpRequest timeout")),
        });
      });
    }

    return Promise.reject(new Error("NO_GM_HTTP"));
  };

  const gmHttpGetArrayBuffer = (url) => {
    const detail = {
      method: "GET",
      url,
      responseType: "arraybuffer",
      headers: { Referer: "https://www.xiaohongshu.com/" },
    };

    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM.xmlHttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              response: response.response,
              responseHeaders: response.responseHeaders ?? "",
            });
          },
          onerror: () => reject(new Error("GM.xmlHttpRequest GET onerror")),
          ontimeout: () => reject(new Error("GM.xmlHttpRequest GET timeout")),
        });
      });
    }

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              response: response.response,
              responseHeaders: response.responseHeaders ?? "",
            });
          },
          onerror: () => reject(new Error("GM_xmlhttpRequest GET onerror")),
          ontimeout: () => reject(new Error("GM_xmlhttpRequest GET timeout")),
        });
      });
    }

    return Promise.reject(new Error("NO_GM_HTTP"));
  };

  const gmHttpPostFormData = (url, formData) => {
    const detail = {
      method: "POST",
      url,
      data: formData,
    };

    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM.xmlHttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              responseText: response.responseText ?? response.response ?? "",
            });
          },
          onerror: () => reject(new Error("GM.xmlHttpRequest Form onerror")),
          ontimeout: () => reject(new Error("GM.xmlHttpRequest Form timeout")),
        });
      });
    }

    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          ...detail,
          onload: (response) => {
            resolve({
              status: response.status,
              responseText: response.responseText ?? "",
            });
          },
          onerror: () => reject(new Error("GM_xmlhttpRequest Form onerror")),
          ontimeout: () => reject(new Error("GM_xmlhttpRequest Form timeout")),
        });
      });
    }

    return Promise.reject(new Error("NO_GM_HTTP"));
  };

  const parseContentTypeFromGmHeaders = (headerText) => {
    if (!headerText) {
      return "image/jpeg";
    }
    const lines = String(headerText).split("\n");
    for (const line of lines) {
      const m = line.match(/^content-type:\s*([^;\s]+)/i);
      if (m?.[1]) {
        return m[1].trim();
      }
    }
    return "image/jpeg";
  };

  const extFromMime = (mime) => {
    if (mime === "image/png") {
      return "png";
    }
    if (mime === "image/webp") {
      return "webp";
    }
    return "jpg";
  };

  const isMediaCaptureReady = () =>
    Boolean(state.listingId && state.shareUrlDone);

  const isUrlMatched = (appConfig) => window.location.href.includes(appConfig.urlPattern);
  const isDetailPage = (config) => {
    const pathKeywords = config.detailCopy.pathKeywords || [];
    for (const keyword of pathKeywords) {
      if (window.location.href.includes(keyword)) {
        return true;
      }
    }
    return false;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const now = () => Date.now();

  const sleep = (ms) =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  const normalizeTitle = (text) => text.replace(/\s+/g, " ").trim();

  const makeCandidateId = (text, element) => {
    const rect = element.getBoundingClientRect();
    const compact = normalizeTitle(text).slice(0, 80);
    return `${compact}|${Math.round(rect.top)}|${Math.round(rect.left)}`;
  };

  const ensureOverlayRoot = () => {
    if (state.overlayRoot?.parentNode) {
      return state.overlayRoot;
    }

    const root = document.createElement("div");
    root.id = "xhs-guide-overlay-root";
    root.style.position = "fixed";
    root.style.top = "0";
    root.style.left = "0";
    root.style.width = "100vw";
    root.style.height = "100vh";
    root.style.pointerEvents = "none";
    root.style.zIndex = "2147483646";
    document.body.append(root);
    state.overlayRoot = root;
    return root;
  };

  const clearOverlay = () => {
    if (state.overlayRoot?.parentNode) {
      state.overlayRoot.parentNode.removeChild(state.overlayRoot);
    }
    state.overlayRoot = null;
  };

  const removeDetailCopyButton = () => {
    if (state.detailCopyButton?.parentNode) {
      state.detailCopyButton.parentNode.removeChild(state.detailCopyButton);
    }
    state.detailCopyButton = null;
  };

  const removeSyncShareButton = () => {
    document.getElementById("xhs-guide-sync-share-button")?.remove();
  };

  const isElementVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const inViewport =
      rect.bottom >= VIEWPORT_MARGIN &&
      rect.right >= VIEWPORT_MARGIN &&
      rect.top <= window.innerHeight - VIEWPORT_MARGIN &&
      rect.left <= window.innerWidth - VIEWPORT_MARGIN;
    return inViewport && rect.width > 0 && rect.height > 0;
  };

  const getCandidatePostRoot = (element) => {
    if (!(element instanceof Element)) {
      return null;
    }
    const link = element.closest(
      'a[href*="/explore/"], a[href*="/discovery/item/"]',
    );
    if (link instanceof Element) {
      const card =
        link.closest("section") ??
        link.closest('[class*="note"]') ??
        link.closest('[class*="feed"]') ??
        link.closest('[class*="card"]');
      if (card instanceof Element) {
        return card;
      }
      return link;
    }
    let node = element;
    for (let i = 0; i < 12 && node.parentElement; i += 1) {
      node = node.parentElement;
      const rect = node.getBoundingClientRect();
      if (rect.height >= 120 && rect.width >= 140) {
        return node;
      }
    }
    return element;
  };

  const getTitleDismissKey = (candidate) => {
    const postRoot =
      candidate.postRoot ?? getCandidatePostRoot(candidate.element);
    if (postRoot instanceof Element) {
      const link =
        postRoot.querySelector(
          'a[href*="/explore/"], a[href*="/discovery/item/"]',
        ) ??
        postRoot.closest('a[href*="/explore/"], a[href*="/discovery/item/"]');
      if (link instanceof HTMLAnchorElement && link.href) {
        try {
          const u = new URL(link.href);
          return `post:${u.origin}${u.pathname}`;
        } catch {
          /* ignore invalid url */
        }
      }
    }
    return `title:${normalizeTitle(candidate.text).toLowerCase()}`;
  };

  const textMatchesTitleCandidate = (elementText, expectedText) => {
    const normalizedElement = normalizeTitle(elementText);
    const normalizedExpected = normalizeTitle(expectedText);
    if (!normalizedElement || !normalizedExpected) {
      return false;
    }
    if (normalizedElement === normalizedExpected) {
      return true;
    }
    const prefixLen = Math.min(16, normalizedElement.length, normalizedExpected.length);
    if (prefixLen < 4) {
      return false;
    }
    const prefix = normalizedExpected.slice(0, prefixLen);
    return (
      normalizedElement.startsWith(prefix) ||
      normalizedExpected.startsWith(normalizedElement.slice(0, prefixLen))
    );
  };

  const refineTitleHighlightElement = (element, expectedText) => {
    if (!(element instanceof HTMLElement)) {
      return element;
    }

    const selfRect = element.getBoundingClientRect();
    if (
      selfRect.height > 0 &&
      selfRect.height <= TITLE_HIGHLIGHT_MAX_HEIGHT &&
      selfRect.width > 0
    ) {
      return element;
    }

    const scopedRoot =
      element.closest(
        'a[href*="/explore/"], section, [class*="note"], [class*="feed"]',
      ) ?? element;

    let best = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const node of scopedRoot.querySelectorAll(
      "span, p, h3, h4, em, strong, [class*='title']",
    )) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (!isElementVisible(node)) {
        continue;
      }
      const nodeText = node.innerText || node.textContent || "";
      if (!textMatchesTitleCandidate(nodeText, expectedText)) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) {
        continue;
      }
      if (rect.height > TITLE_HIGHLIGHT_MAX_HEIGHT) {
        continue;
      }
      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        best = node;
      }
    }

    return best instanceof HTMLElement ? best : element;
  };

  const getCandidateHighlightRect = (candidate) => {
    const highlightElement = refineTitleHighlightElement(
      candidate.element,
      candidate.text,
    );
    const base = highlightElement.getBoundingClientRect();
    if (base.width <= 0 || base.height <= 0) {
      return null;
    }
    const padding = 5;
    return {
      top: Math.max(VIEWPORT_MARGIN, base.top - padding),
      left: Math.max(VIEWPORT_MARGIN, base.left - padding),
      width: Math.max(0, base.width + padding * 2),
      height: Math.max(0, base.height + padding * 2),
    };
  };

  const collectVisibleTitleCandidates = (config) => {
    const candidates = [];
    const dedup = new Set();

    for (const selector of config.titleScan.selectorCandidates) {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        logWarn("标题选择器无效", selector);
      }

      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        if (!isElementVisible(element)) {
          continue;
        }

        const text = normalizeTitle(element.innerText || element.textContent || "");
        if (text.length < config.titleScan.minTitleLength) {
          continue;
        }

        const highlightElement = refineTitleHighlightElement(element, text);
        const id = makeCandidateId(text, highlightElement);
        if (dedup.has(id)) {
          continue;
        }
        dedup.add(id);
        candidates.push({
          id,
          text,
          element: highlightElement,
          postRoot: getCandidatePostRoot(element),
          sourceSelector: selector,
          rect: highlightElement.getBoundingClientRect(),
        });
      }
    }

    return candidates.slice(0, config.titleScan.maxTitlesPerRound);
  };

  const getPlainText = (element) => {
    const text = element?.innerText || element?.textContent || "";
    return text.trim();
  };

  const findDetailContentElement = (config) => {
    for (const selector of config.detailCopy.contentSelectorCandidates) {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        logWarn("正文选择器无效", selector);
      }

      if (elements.length === 0) {
        continue;
      }

      let fallback = null;
      for (const rawElement of elements) {
        if (!(rawElement instanceof HTMLElement)) {
          continue;
        }
        if (!fallback) {
          fallback = rawElement;
        }
        if (getPlainText(rawElement)) {
          return rawElement;
        }
      }
      if (fallback) {
        return fallback;
      }
    }
    return null;
  };

  const ruleScreenStage = (input, config) => {
    const lower = input.titleText.toLowerCase();
    const rule = config.judgement.rule;

    const bayHits = rule.bayAreaWords.filter((w) => lower.includes(w.toLowerCase()));
    const rentHits = rule.rentalWords.filter((w) => lower.includes(w.toLowerCase()));
    const strongRentalHit = rule.strongRentalWords.find((w) =>
      lower.includes(w.toLowerCase()),
    );
    const experienceHit = rule.experienceWords.find((w) =>
      lower.includes(w.toLowerCase()),
    );
    const mainlandHit = rule.mainlandOnlyWords.find((w) =>
      lower.includes(w.toLowerCase()),
    );
    const bayHit = bayHits.at(0) ?? "";
    const rentHit = rentHits.at(0) ?? "";

    if (mainlandHit && bayHits.length === 0) {
      return {
        stageName: "ruleScreenStage",
        passed: false,
        skipLlm: true,
        confidence: 0.05,
        reason: `大陆城市词(${mainlandHit})且无湾区信号，排除`,
      };
    }

    // 强命中：城市词 + 租房词同时出现
    if (bayHits.length > 0 && rentHits.length > 0) {
      // 含经验/科普信号时降级：先高亮，但交给 LLM 复核
      if (experienceHit) {
        return {
          stageName: "ruleScreenStage",
          passed: true,
          skipLlm: false,
          confidence: 0.55,
          reason: `湾区(${bayHit})+租房(${rentHit})但含经验词(${experienceHit})，送 LLM 复核`,
        };
      }
      return {
        stageName: "ruleScreenStage",
        passed: true,
        skipLlm: true,
        confidence: 0.85,
        reason: `强命中: 湾区(${bayHit}) + 租房(${rentHit})`,
      };
    }

    // 湾区城市出现多个，通常就是本地租房/生活帖，先展示，后台交给 LLM 纠错
    if (bayHits.length >= 2) {
      return {
        stageName: "ruleScreenStage",
        passed: true,
        skipLlm: false,
        confidence: 0.72,
        reason: `多个湾区信号(${bayHits.slice(0, 2).join(", ")})，先高亮后复核`,
      };
    }

    if (strongRentalHit) {
      return {
        stageName: "ruleScreenStage",
        passed: true,
        skipLlm: false,
        confidence: 0.7,
        reason: `强租房信号(${strongRentalHit})，先高亮后复核`,
      };
    }

    if (bayHit || rentHit) {
      return {
        stageName: "ruleScreenStage",
        passed: true,
        skipLlm: false,
        confidence: 0.65,
        reason: `弱信号(${bayHit || rentHit})，先高亮后复核`,
      };
    }

    return {
      stageName: "ruleScreenStage",
      passed: false,
      skipLlm: true,
      confidence: 0.1,
      reason: "无湾区/租房信号，跳过 LLM",
    };
  };

  const requestByGmXmlHttp = (url, payload, apiKey, timeoutMs) => {
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM.xmlHttpRequest({
          method: "POST",
          url,
          timeout: timeoutMs,
          headers,
          data: body,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`LLM 请求失败: ${response.status}`));
              return;
            }
            try {
              resolve(
                JSON.parse(response.responseText ?? response.response ?? ""),
              );
            } catch {
              reject(new Error("LLM 响应 JSON 解析失败"));
            }
          },
          onerror: () => reject(new Error("LLM 网络请求错误")),
          ontimeout: () => reject(new Error("LLM 请求超时")),
        });
      });
    }

    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM网络 API 不可用"));
        return;
      }

      GM_xmlhttpRequest({
        method: "POST",
        url,
        timeout: timeoutMs,
        headers,
        data: body,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`LLM 请求失败: ${response.status}`));
            return;
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch {
            reject(new Error("LLM 响应 JSON 解析失败"));
          }
        },
        onerror: () => reject(new Error("LLM 网络请求错误")),
        ontimeout: () => reject(new Error("LLM 请求超时")),
      });
    });
  };

  const parseBatchLlmJudgements = (rawText) => {
    const content = rawText.trim();
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    const objectMatch = content.match(/\{[\s\S]*\}/);
    const jsonText = arrayMatch ? arrayMatch[0] : objectMatch ? objectMatch[0] : content;
    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.results)
        ? parsed.results
        : [];
    const results = new Map();
    for (const item of items) {
      const index = Number(item?.index);
      if (!Number.isInteger(index)) {
        continue;
      }
      results.set(index, {
        related: Boolean(item.related),
        confidence: clamp(Number(item.confidence) || 0.5, 0, 1),
        reason:
          typeof item.reason === "string"
            ? item.reason
            : "LLM 未提供原因",
      });
    }
    return results;
  };

  const llmBatchReviewStage = async (inputs, config) => {
    const llmConfig = config.judgement.llm;
    if (!config.judgement.enableLlmReview || !llmConfig.apiKey || inputs.length === 0) {
      return new Map();
    }

    const elapsed = now() - state.lastLlmCallAt;
    if (elapsed < config.judgement.llmMinIntervalMs) {
      await sleep(config.judgement.llmMinIntervalMs - elapsed);
    }

    const batch = inputs.slice(0, config.judgement.maxLlmReviewsPerRound);
    const systemPrompt =
      "你是小红书帖子分类器，专门识别美国湾区租房相关标题。" +
      "包括出租、转租、短租、招租、求租、找房、找室友、roommate、sublease。" +
      "请逐条判断标题是否相关，只输出 JSON: {\"results\":[{\"index\":0,\"related\":true,\"confidence\":0.9,\"reason\":\"...\"}]}";
    const userPrompt = batch
      .map((input, index) => `${index}. ${input.titleText}`)
      .join("\n");

    const payload = {
      model: llmConfig.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const response = await requestByGmXmlHttp(
      llmConfig.endpoint,
      payload,
      llmConfig.apiKey,
      config.judgement.llmTimeoutMs,
    );
    state.lastLlmCallAt = now();
    state.llmReviewedInRound += batch.length;

    const text = response?.choices?.[0]?.message?.content || "";
    return parseBatchLlmJudgements(text);
  };

  const postProcessStage = (ruleResult, llmResult, config) => {
    const finalPass = llmResult.skipped ? ruleResult.passed : llmResult.passed;
    const confidence = llmResult.skipped ? ruleResult.confidence : llmResult.confidence;
    return {
      stageName: "postProcessStage",
      isBayAreaRentingRelated: finalPass && confidence >= config.judgement.minConfidenceToHighlight,
      confidence: clamp(confidence, 0, 1),
      reason: llmResult.reason || ruleResult.reason,
    };
  };

  const renderHighlightItems = (candidates, config) => {
    const root = ensureOverlayRoot();
    root.replaceChildren();

    const list = candidates.slice(0, MAX_HIGHLIGHT_COUNT);
    if (list.length === 0) {
      return;
    }

    const holes = [];
    for (const candidate of list) {
      const rect = getCandidateHighlightRect(candidate);
      if (rect) {
        holes.push(rect);
      }
    }
    if (holes.length === 0) {
      return;
    }

    const svgNS = "http://www.w3.org/2000/svg";
    const maskId = `xhs-guide-title-mask-${Date.now()}`;
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.position = "fixed";
    svg.style.top = "0";
    svg.style.left = "0";
    svg.style.width = "100vw";
    svg.style.height = "100vh";
    svg.style.pointerEvents = "none";

    const defs = document.createElementNS(svgNS, "defs");
    const maskEl = document.createElementNS(svgNS, "mask");
    maskEl.setAttribute("id", maskId);

    const maskBg = document.createElementNS(svgNS, "rect");
    maskBg.setAttribute("width", "100%");
    maskBg.setAttribute("height", "100%");
    maskBg.setAttribute("fill", "white");
    maskEl.append(maskBg);

    for (const rect of holes) {
      const hole = document.createElementNS(svgNS, "rect");
      hole.setAttribute("x", String(rect.left));
      hole.setAttribute("y", String(rect.top));
      hole.setAttribute("width", String(rect.width));
      hole.setAttribute("height", String(rect.height));
      hole.setAttribute("rx", "10");
      hole.setAttribute("fill", "black");
      maskEl.append(hole);
    }

    defs.append(maskEl);
    const overlay = document.createElementNS(svgNS, "rect");
    overlay.setAttribute("width", "100%");
    overlay.setAttribute("height", "100%");
    overlay.setAttribute("fill", config.highlight.titleMaskColor);
    overlay.setAttribute("mask", `url(#${maskId})`);
    svg.append(defs, overlay);
    root.append(svg);

    for (const candidate of list) {
      const rect = getCandidateHighlightRect(candidate);
      if (!rect) {
        continue;
      }

      const box = document.createElement("div");
      box.style.position = "fixed";
      box.style.top = `${rect.top}px`;
      box.style.left = `${rect.left}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.border = `3px solid ${config.highlight.borderColor}`;
      box.style.borderRadius = "10px";
      box.style.pointerEvents = "none";
      box.style.boxShadow = "none";
      box.style.background = "transparent";

      const bubble = document.createElement("div");
      bubble.style.position = "fixed";
      bubble.style.top = `${Math.max(VIEWPORT_MARGIN, rect.top - 34)}px`;
      bubble.style.left = `${rect.left}px`;
      bubble.style.background = config.highlight.borderColor;
      bubble.style.color = "#ffffff";
      bubble.style.fontSize = "12px";
      bubble.style.fontWeight = "600";
      bubble.style.padding = "4px 8px";
      bubble.style.borderRadius = "6px";
      bubble.style.pointerEvents = "none";
      bubble.textContent = `${config.highlight.hintPrefix} (${Math.round(candidate.judgement.confidence * 100)}%)`;

      root.append(box, bubble);
    }
  };

  const resolveHighlightRect = (element) => {
    if (!(element instanceof Element)) {
      return null;
    }
    const candidates = [element];
    if (element.matches(".share-wrapper")) {
      const icon = element.querySelector(".share-icon-container");
      if (icon instanceof Element) {
        candidates.unshift(icon);
      }
    }
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { element: candidate, rect };
      }
    }
    return null;
  };

  const isShareIconUse = (useEl) => {
    if (!(useEl instanceof Element)) {
      return false;
    }
    const href =
      useEl.getAttribute("href") ??
      useEl.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
      "";
    return href.includes("share_new") || href.includes("link_c");
  };

  /** 页面上可能有多个隐藏的 .share-wrapper，需选可见且尺寸有效的 */
  const findDetailShareElement = () => {
    const tryElements = (elements) => {
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const resolved = resolveHighlightRect(element);
        if (resolved && isElementVisible(resolved.element)) {
          return resolved.element;
        }
      }
      return null;
    };

    const wrappers = [...document.querySelectorAll(".share-wrapper")];
    wrappers.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const fromWrapper = tryElements(wrappers);
    if (fromWrapper) {
      return fromWrapper;
    }

    const icons = [...document.querySelectorAll(".share-icon-container")];
    const fromIcon = tryElements(icons);
    if (fromIcon) {
      return fromIcon;
    }

    for (const use of document.querySelectorAll("use")) {
      if (!isShareIconUse(use)) {
        continue;
      }
      const container =
        use.closest(".share-icon-container") ??
        use.closest(".share-wrapper") ??
        use.closest("svg")?.parentElement;
      if (container instanceof HTMLElement) {
        const resolved = resolveHighlightRect(container);
        if (resolved && isElementVisible(resolved.element)) {
          return resolved.element;
        }
      }
    }
    return null;
  };

  const findDetailShareClickTarget = (highlightElement) => {
    if (!(highlightElement instanceof HTMLElement)) {
      return null;
    }
    const wrapper = highlightElement.closest(".share-wrapper");
    return wrapper instanceof HTMLElement ? wrapper : highlightElement;
  };

  const appendRectHighlight = (root, config, element, bubbleText) => {
    const resolved = resolveHighlightRect(element);
    if (!resolved) {
      return;
    }
    const { rect } = resolved;

    const padding = 6;
    const top = Math.max(VIEWPORT_MARGIN, rect.top - padding);
    const left = Math.max(VIEWPORT_MARGIN, rect.left - padding);
    const width = Math.max(0, rect.width + padding * 2);
    const height = Math.max(0, rect.height + padding * 2);

    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.border = `3px solid ${config.highlight.borderColor}`;
    box.style.borderRadius = "10px";
    box.style.pointerEvents = "none";
    box.style.boxShadow = config.highlight.overlayShadow;

    const bubble = document.createElement("div");
    bubble.style.position = "fixed";
    bubble.style.top = `${Math.max(VIEWPORT_MARGIN, top - 34)}px`;
    bubble.style.left = `${left}px`;
    bubble.style.background = config.highlight.borderColor;
    bubble.style.color = "#ffffff";
    bubble.style.fontSize = "12px";
    bubble.style.fontWeight = "600";
    bubble.style.padding = "4px 8px";
    bubble.style.borderRadius = "6px";
    bubble.style.pointerEvents = "none";
    bubble.textContent = bubbleText;

    root.append(box, bubble);
  };

  const renderDetailHighlight = (config) => {
    const root = ensureOverlayRoot();
    root.replaceChildren();

    if (state.detailCopyButton) {
      appendRectHighlight(
        root,
        config,
        state.detailCopyButton,
        config.detailCopy.hintText,
      );
    }

    const arrow = document.querySelector(".arrow-controller.right");
    if (arrow instanceof HTMLElement && arrow.classList.contains("forbidden")) {
      const closeButton = document.querySelector(".close.close-mask-dark");
      if (closeButton instanceof HTMLElement) {
        appendRectHighlight(
          root,
          config,
          closeButton,
          config.detailCopy.carouselDoneCloseHint,
        );
      }
    } else if (arrow instanceof HTMLElement) {
      appendRectHighlight(
        root,
        config,
        arrow,
        config.detailCopy.carouselArrowHint,
      );
    }

    if (!state.shareUrlDone && (state.listingId || state.bodyCopied)) {
      const share = findDetailShareElement();
      if (share instanceof HTMLElement) {
        appendRectHighlight(
          root,
          config,
          share,
          config.detailCopy.shareHint,
        );
      }
    }
  };

  const extractXhsUrlFromText = (text) => {
    if (!text) {
      return null;
    }
    const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
    for (const raw of urls) {
      const cleaned = raw.replace(/[)\]}>.,;！。，]+$/, "");
      try {
        const host = new URL(cleaned).hostname.toLowerCase();
        if (
          host.includes("xiaohongshu.com") ||
          host.includes("xhslink.com") ||
          host.includes("xhs.cn")
        ) {
          return cleaned;
        }
      } catch {
        /* ignore invalid url */
      }
    }
    return null;
  };

  const isPersistedShareUrlResponse = (data, listingId) => {
    if (!data || data.ok !== true) {
      return false;
    }
    if (typeof data.id !== "string" || data.id !== listingId) {
      return false;
    }
    if (typeof data.sourceUrl !== "string" || data.sourceUrl.startsWith("pending:")) {
      return false;
    }
    if (state.listingKind === "other" || listingId.startsWith("phantom:")) {
      return true;
    }
    return extractXhsUrlFromText(data.sourceUrl) !== null;
  };

  const shortListingId = (listingId) =>
    typeof listingId === "string" ? listingId.slice(0, 8) : "";

  const readClipboardText = async () => {
    if (navigator.clipboard?.readText) {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    }
    return "";
  };

  const getClipboardTextFromCopyEvent = (event) => {
    if (!(event instanceof ClipboardEvent)) {
      return "";
    }
    const direct = event.clipboardData?.getData("text/plain") ?? "";
    return typeof direct === "string" ? direct.trim() : "";
  };

  const injectPageClipboardBridge = () => {
    if (state.pageClipboardBridgeInjected) {
      return;
    }
    const script = document.createElement("script");
    script.textContent = `(function(){if(window.__xhsGuideClipboardBridge)return;window.__xhsGuideClipboardBridge=true;const notify=function(t,r){window.postMessage({source:"xhs-guide-clipboard-bridge",text:String(t),reason:r},"*");};if(navigator.clipboard&&navigator.clipboard.writeText){const orig=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=function(text){notify(text,"writeText");return orig(text);};}document.addEventListener("copy",function(e){if(e.clipboardData){const t=e.clipboardData.getData("text/plain");if(t){notify(t,"clipboardData");return;}}const sel=window.getSelection&&window.getSelection();const text=sel&&sel.toString?sel.toString():"";if(text){notify(text,"selection");}},true);})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    state.pageClipboardBridgeInjected = true;
    logInfo("页面剪贴板桥接已注入", { version: SCRIPT_VERSION });
  };

  const handleCapturedClipboardText = async (config, text, reason) => {
    if (state.shareUrlDone || state.shareUpdateInFlight) {
      return;
    }
    const sourceUrl = extractXhsUrlFromText(text);
    if (!sourceUrl) {
      logInfo("剪贴板桥接：暂未解析到小红书链接", {
        reason,
        listingId: state.listingId,
        preview: text.slice(0, 80),
      });
      return;
    }
    // listingId 还未从 API 返回时，先缓存，等入库完成后立即提交
    if (!state.listingId) {
      state.pendingShareUrl = sourceUrl;
      logInfo("分享链接已缓冲（入库进行中）", { reason, sourceUrl: sourceUrl.slice(0, 100) });
      return;
    }
    logInfo("剪贴板桥接：捕获分享链接", {
      reason,
      listingId: state.listingId,
      sourceUrl: sourceUrl.slice(0, 100),
    });
    state.shareUpdateInFlight = true;
    try {
      const ok = await submitUpdateSourceUrl(
        config,
        state.listingId,
        sourceUrl,
      );
      if (!ok) {
        return;
      }
      markShareUrlDone(config, sourceUrl);
    } finally {
      state.shareUpdateInFlight = false;
    }
  };

  const ensurePageClipboardBridgeListener = (config) => {
    injectPageClipboardBridge();
    if (state.pageClipboardMessageHandler) {
      return;
    }
    state.pageClipboardMessageHandler = (event) => {
      if (event.source !== window) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== "xhs-guide-clipboard-bridge") {
        return;
      }
      if (typeof data.text !== "string") {
        return;
      }
      void handleCapturedClipboardText(
        config,
        data.text,
        data.reason || "bridge",
      );
    };
    window.addEventListener("message", state.pageClipboardMessageHandler);
    logInfo("页面剪贴板桥接监听已挂载", { version: SCRIPT_VERSION });
  };

  const teardownPageClipboardBridge = () => {
    if (state.pageClipboardMessageHandler) {
      window.removeEventListener("message", state.pageClipboardMessageHandler);
    }
    state.pageClipboardMessageHandler = null;
  };

  const markShareUrlDone = (config, sourceUrl) => {
    state.shareUrlDone = true;
    showShareUrlSuccessToast(state.listingId, sourceUrl);
    teardownShareCapture();
    removeSyncShareButton();
    renderDetailHighlight(config);
    ensureCarouselObserver(config);
  };

  const submitUpdateSourceUrl = async (config, listingId, sourceUrl) => {
    const baseUrl = config.ingest.baseUrl?.trim();
    if (!baseUrl) {
      return false;
    }
    const url = `${baseUrl.replace(/\/$/, "")}/api/xhs/update-source-url`;
    const body = JSON.stringify({
      listingId,
      sourceUrl,
      listingKind: state.listingKind,
    });
    try {
      const { status, responseText } = await gmHttpPost(url, {
        "Content-Type": "application/json",
      }, body);
      const data = JSON.parse(responseText || "{}");
      if (
        status >= 200 &&
        status < 300 &&
        isPersistedShareUrlResponse(data, listingId)
      ) {
        logInfo("真实链接已写入", {
          listingId: data.id,
          listingIdShort: shortListingId(data.id),
          listingKind: state.listingKind,
          sourceUrl: data.sourceUrl,
          hint: "请在数据库按 id 查此行，不要用 sourceUrl 里的 pending:... 当作行 id",
        });
        return true;
      }
      logWarn("写入真实链接失败：响应未通过校验", {
        status,
        data,
        listingId,
        requestedSourceUrl: sourceUrl,
      });
    } catch (e) {
      logWarn("写入真实链接异常", e instanceof Error ? e.message : String(e));
    }
    return false;
  };

  const tryAutoUpdateSourceUrl = async (config, reason) => {
    if (state.shareUrlDone) {
      return false;
    }

    let sourceUrl = null;
    let clipPreview = "";
    try {
      const clip = await readClipboardText();
      clipPreview = clip?.slice(0, 80) ?? "";
      sourceUrl = extractXhsUrlFromText(clip);
      if (sourceUrl) {
        logInfo("从剪贴板解析到分享链接", {
          reason,
          listingId: state.listingId,
          sourceUrl: sourceUrl.slice(0, 100),
        });
      }
    } catch (e) {
      logWarn("剪贴板读取失败", {
        reason,
        listingId: state.listingId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (!sourceUrl) {
      logInfo("剪贴板中暂未找到小红书分享链接", {
        reason,
        listingId: state.listingId,
        clipPreview,
      });
      return false;
    }

    // listingId 还未就绪时缓存，等入库后再提交
    if (!state.listingId) {
      state.pendingShareUrl = sourceUrl;
      logInfo("分享链接已缓冲（入库进行中）", { reason, sourceUrl: sourceUrl.slice(0, 100) });
      return false;
    }

    if (state.shareUpdateInFlight) {
      return false;
    }
    state.shareUpdateInFlight = true;
    try {
      const ok = await submitUpdateSourceUrl(
        config,
        state.listingId,
        sourceUrl,
      );
      if (!ok) {
        return false;
      }
      markShareUrlDone(config, sourceUrl);
      return true;
    } finally {
      state.shareUpdateInFlight = false;
    }
  };

  const burstTryAutoUpdateSourceUrl = async (config, reason) => {
    if (state.shareUrlDone || !state.listingId) {
      return;
    }
    logInfo("开始捕获分享链接", {
      reason,
      listingId: state.listingId,
      burstMs: SHARE_CLIPBOARD_BURST_MS,
    });
    let elapsed = 0;
    for (let i = 0; i < SHARE_CLIPBOARD_BURST_MS.length; i += 1) {
      if (state.shareUrlDone) {
        return;
      }
      const targetMs = SHARE_CLIPBOARD_BURST_MS[i];
      if (targetMs > elapsed) {
        await sleep(targetMs - elapsed);
        elapsed = targetMs;
      }
      const ok = await tryAutoUpdateSourceUrl(
        config,
        `${reason}@${targetMs}ms`,
      );
      if (ok) {
        return;
      }
    }
  };

  const teardownShareCapture = () => {
    if (state.shareDocClickHandler) {
      document.removeEventListener("click", state.shareDocClickHandler, true);
    }
    if (state.shareCopyHandler) {
      document.removeEventListener("copy", state.shareCopyHandler, true);
    }
    state.shareDocClickHandler = null;
    state.shareCopyHandler = null;
    teardownPageClipboardBridge();
  };

  const ensureShareClickListener = (config) => {
    if (state.shareUrlDone || !state.listingId) {
      teardownShareCapture();
      return;
    }
    ensurePageClipboardBridgeListener(config);
    if (state.shareDocClickHandler) {
      return;
    }

    state.shareDocClickHandler = () => {
      if (state.shareUrlDone || !state.listingId) {
        return;
      }
      void burstTryAutoUpdateSourceUrl(config, "user-click");
    };
    document.addEventListener("click", state.shareDocClickHandler, true);

    state.shareCopyHandler = (event) => {
      if (state.shareUrlDone || !state.listingId) {
        return;
      }
      const directText = getClipboardTextFromCopyEvent(event);
      if (directText) {
        void handleCapturedClipboardText(
          config,
          directText,
          "copy-event-clipboardData",
        );
      }
      void burstTryAutoUpdateSourceUrl(config, "copy-event");
    };
    document.addEventListener("copy", state.shareCopyHandler, true);

    logInfo("分享链接监听已挂载", {
      version: SCRIPT_VERSION,
      listingId: state.listingId,
    });
  };

  const ensureSyncShareButton = (config) => {
    if (state.shareUrlDone || !state.listingId) {
      removeSyncShareButton();
      return;
    }
    if (document.getElementById("xhs-guide-sync-share-button")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "xhs-guide-sync-share-button";
    button.textContent = "同步分享链接";
    button.style.position = "fixed";
    button.style.right = "20px";
    button.style.bottom = "200px";
    button.style.zIndex = "2147483647";
    button.style.pointerEvents = "auto";
    button.style.border = "none";
    button.style.borderRadius = "10px";
    button.style.padding = "8px 12px";
    button.style.fontSize = "13px";
    button.style.fontWeight = "600";
    button.style.background = "#2563eb";
    button.style.color = "#ffffff";
    button.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.25)";
    button.style.cursor = "pointer";
    button.addEventListener("click", () => {
      void burstTryAutoUpdateSourceUrl(config, "manual-sync-button");
    });
    document.body.append(button);
    logInfo("同步分享链接按钮已显示", { listingId: state.listingId });
  };

  const findCarouselRootFromArrow = (arrow) => {
    let n = arrow;
    for (let i = 0; i < 10 && n; i += 1) {
      n = n.parentElement;
      if (!n) {
        break;
      }
      if (n.querySelectorAll("img, video").length >= 1) {
        return n;
      }
    }
    return arrow.parentElement ?? arrow;
  };

  const findMediaRoot = () => {
    const player = document.querySelector(".player-el.xgplayer");
    if (player instanceof HTMLElement && player.querySelector('video[mediatype="video"]')) {
      return player;
    }

    const arrow = document.querySelector(".arrow-controller.right");
    if (arrow instanceof HTMLElement) {
      return findCarouselRootFromArrow(arrow);
    }

    const slider = document.querySelector(".xhs-slider-container.slider-zoom-in");
    if (slider instanceof HTMLElement && slider.querySelector("img, video")) {
      return slider;
    }

    const video = document.querySelector(
      'video[mediatype="video"][src^="blob:https://www.xiaohongshu.com/"], video[mediatype="video"], video',
    );
    return video instanceof HTMLVideoElement
      ? video.closest(".player-el.xgplayer, .xhs-slider-container, .swiper, .note-slider, .media-container") ??
          video.parentElement
      : null;
  };

  const collectCarouselImgUrls = (carouselRoot) => {
    if (!carouselRoot) {
      return [];
    }

    const urls = [];
    const seen = new Set();
    const addUrl = (url) => {
      if (!url || !/^https?:\/\//.test(url)) {
        return;
      }
      if (!url.includes("xhscdn.com")) {
        return;
      }
      if (seen.has(url)) {
        return;
      }
      seen.add(url);
      urls.push(url);
    };

    // 小红书轮播容器会同时挂载多张图，这里一次性收集全部候选图。
    const preferredImgs = carouselRoot.querySelectorAll(
      'img[crossorigin="anonymous"][style*="object-fit: contain"][style*="position: absolute"]',
    );
    for (const img of preferredImgs) {
      if (img instanceof HTMLImageElement) {
        addUrl(img.currentSrc || img.src);
      }
    }
    if (urls.length > 0) {
      return urls;
    }

    // 兜底：仍只在轮播根节点内收集 xhscdn 图片，不扫全页面。
    for (const img of carouselRoot.querySelectorAll("img")) {
      if (img instanceof HTMLImageElement) {
        addUrl(img.currentSrc || img.src);
      }
    }
    return urls;
  };

  const teardownCarouselCapture = () => {
    for (const timer of state.carouselCheckTimers) {
      window.clearTimeout(timer);
    }
    state.carouselCheckTimers.clear();
    state.videoSeekAbort = true;
    if (state.carouselArrowElement && state.carouselClickHandler) {
      state.carouselArrowElement.removeEventListener(
        "click",
        state.carouselClickHandler,
      );
    }
    state.carouselArrowElement = null;
    state.carouselClickHandler = null;
    state.carouselObserver?.disconnect();
    state.carouselObserver = null;
    state.carouselObserveRoot = null;
    state.carouselInFlight.clear();
    state.carouselUploadQueue = [];
    state.carouselQueuedSrcs.clear();
    state.carouselUploading = false;
    state.videoSeekDoneKey = "";
  };

  const scheduleCarouselCheck = (config, delayMs = 0) => {
    const timer = window.setTimeout(() => {
      state.carouselCheckTimers.delete(timer);
      void onCarouselMaybeChanged(config);
    }, delayMs);
    state.carouselCheckTimers.add(timer);
  };

  const scheduleCarouselBurst = (config) => {
    scheduleCarouselCheck(config, 0);
    scheduleCarouselCheck(config, 80);
    scheduleCarouselCheck(config, 220);
    scheduleCarouselCheck(config, 500);
  };

  const submitAppendListingImage = async (config, imageBlob, filename) => {
    if (!config.ingest?.enable) {
      return;
    }
    if (!state.listingId) {
      return false;
    }
    const baseUrl = config.ingest.baseUrl?.trim();
    if (!baseUrl) {
      return;
    }
    const url = `${baseUrl.replace(/\/$/, "")}/api/xhs/append-listing-image`;
    const fd = new FormData();
    if (state.listingId) {
      fd.append("listingId", state.listingId);
    }
    if (state.listingKind) {
      fd.append("listingKind", state.listingKind);
    }
    fd.append("file", imageBlob, filename);

    try {
      const { status, responseText } = await gmHttpPostFormData(url, fd);
      let data = {};
      try {
        data = JSON.parse(responseText || "{}");
      } catch {
        data = {};
      }
      if (status >= 200 && status < 300 && data?.ok) {
        logInfo("轮播图已上传", {
          blobUrl: data.url,
          imageUrlsLength: data.imageUrlsLength,
        });
        return true;
      }
      if (status === 409 && data?.code === "LISTING_NOT_FOUND") {
        logWarn("先复制正文并点击分享获取链接，再上传图片");
        return false;
      }
      logWarn("轮播图上传失败", {
        status,
        data,
        responseText,
        listingId: state.listingId,
        blobType: imageBlob.type,
        blobSize: imageBlob.size,
      });
      return false;
    } catch (firstError) {
      const msg =
        firstError instanceof Error ? firstError.message : String(firstError);
      if (msg !== "NO_GM_HTTP") {
        logWarn("轮播图上传（GM）异常", msg);
        return false;
      }
      logWarn(
        "轮播图上传需要 GM.xmlHttpRequest；请确认 @grant 已配置并刷新页面。",
      );
      return false;
    }
  };

  const pickVideoForFrame = (root) => {
    if (!root) {
      return null;
    }
    const preferredVideo = root.querySelector(
      'video[mediatype="video"][src^="blob:https://www.xiaohongshu.com/"], video[mediatype="video"]',
    );
    if (
      preferredVideo instanceof HTMLVideoElement &&
      preferredVideo.readyState >= 2 &&
      preferredVideo.videoWidth &&
      preferredVideo.videoHeight
    ) {
      return preferredVideo;
    }

    const videos = root.querySelectorAll("video");
    let best = null;
    let bestArea = 0;
    for (const video of videos) {
      if (!(video instanceof HTMLVideoElement)) {
        continue;
      }
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        continue;
      }
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < 400) {
        continue;
      }
      const cs = window.getComputedStyle(video);
      if (cs.visibility === "hidden" || cs.display === "none") {
        continue;
      }
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  };

  const captureVideoFrameBlob = (video) =>
    new Promise((resolve) => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) {
        resolve(null);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob(resolve, "image/jpeg", 0.82);
      } catch (e) {
        logWarn("视频帧截图失败", e instanceof Error ? e.message : String(e));
        resolve(null);
      }
    });

  const seekVideoTo = (video, timeSec) =>
    new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("seek timeout"));
      }, VIDEO_SEEK_TIMEOUT_MS);
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = Math.max(0, timeSec);
    });

  const waitForVideoDuration = (video, maxWaitMs = 8000) =>
    new Promise((resolve) => {
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        resolve(true);
        return;
      }
      const timer = window.setTimeout(() => resolve(false), maxWaitMs);
      const onMeta = () => {
        window.clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onMeta);
        resolve(true);
      };
      video.addEventListener("loadedmetadata", onMeta, { once: true });
    });

  const buildVideoSeekTimes = (durationSec) => {
    const times = [];
    const safeEnd = Math.max(0, durationSec - 0.08);
    for (
      let t = 0;
      t <= safeEnd && times.length < VIDEO_SEEK_MAX_FRAMES;
      t += VIDEO_SEEK_STEP_SEC
    ) {
      times.push(Math.min(t, safeEnd));
    }
    if (
      times.length > 0 &&
      durationSec > 0 &&
      Math.abs(times[times.length - 1] - safeEnd) > 0.5 &&
      times.length < VIDEO_SEEK_MAX_FRAMES
    ) {
      times.push(safeEnd);
    }
    return times;
  };

  const runVideoSeekCapture = async (config, video, jobKey) => {
    const root = state.carouselObserveRoot ?? findMediaRoot();
    if (!video || !root?.contains?.(video)) {
      return;
    }
    const hasMeta = await waitForVideoDuration(video);
    if (!hasMeta || !Number.isFinite(video.duration) || video.duration <= 0) {
      logWarn("视频时长不可用，跳过 seek 截帧");
      return;
    }

    const times = buildVideoSeekTimes(video.duration);
    if (times.length === 0) {
      return;
    }

    const savedTime = video.currentTime;
    const savedPaused = video.paused;
    const savedMuted = video.muted;
    const savedRate = video.playbackRate;

    video.muted = true;
    video.pause();

    let uploadedCount = 0;
    try {
      logInfo("视频 seek 截帧开始", {
        duration: video.duration,
        frames: times.length,
      });
      for (let i = 0; i < times.length; i += 1) {
        if (state.videoSeekAbort) {
          break;
        }
        const t = times[i];
        try {
          await seekVideoTo(video, t);
        } catch {
          logWarn("视频 seek 跳过", { t });
          continue;
        }
        await new Promise((r) => {
          requestAnimationFrame(() => r());
        });
        const blob = await captureVideoFrameBlob(video);
        if (!(blob instanceof Blob)) {
          continue;
        }
        const ok = await submitAppendListingImage(
          config,
          blob,
          `video-t${Math.round(t)}s.jpg`,
        );
        if (ok) {
          uploadedCount += 1;
        }
      }
      if (!state.videoSeekAbort) {
        state.videoSeekDoneKey = jobKey;
      }
      logInfo("视频 seek 截帧结束", { uploadedCount, aborted: state.videoSeekAbort });
    } finally {
      video.currentTime = savedTime;
      video.playbackRate = savedRate;
      video.muted = savedMuted;
      if (savedPaused) {
        video.pause();
      } else {
        video.play().catch(() => {});
      }
    }
  };

  const maybeStartVideoSeekCapture = (config) => {
    if (!isMediaCaptureReady() || state.videoSeekRunning) {
      return;
    }
    const root = state.carouselObserveRoot ?? findMediaRoot();
    if (!root?.querySelector?.('video[mediatype="video"], video')) {
      return;
    }
    const video = pickVideoForFrame(root);
    if (!video) {
      return;
    }
    const vSrc = video.currentSrc || video.src || "";
    const jobKey = `${state.listingId}|${vSrc}`;
    if (state.videoSeekDoneKey === jobKey) {
      return;
    }

    state.videoSeekRunning = true;
    state.videoSeekAbort = false;
    void (async () => {
      try {
        await runVideoSeekCapture(config, video, jobKey);
      } finally {
        state.videoSeekRunning = false;
        state.videoSeekAbort = false;
      }
    })();
  };

  const processCarouselUploadQueue = async (config) => {
    if (state.carouselUploading) {
      return;
    }
    state.carouselUploading = true;

    try {
      while (state.carouselUploadQueue.length > 0) {
        const imgUrl = state.carouselUploadQueue.shift();
        state.carouselQueuedSrcs.delete(imgUrl);
        if (state.uploadedCarouselSrcs.has(imgUrl)) {
          continue;
        }
        if (state.carouselInFlight.has(imgUrl)) {
          continue;
        }
        state.carouselInFlight.add(imgUrl);

        try {
          const { status, response, responseHeaders } =
            await gmHttpGetArrayBuffer(imgUrl);
          if (status < 200 || status >= 300 || !response) {
            logWarn("拉取主图失败", { status, imgUrl });
            continue;
          }
          const mime = parseContentTypeFromGmHeaders(responseHeaders);
          if (
            mime !== "image/jpeg" &&
            mime !== "image/png" &&
            mime !== "image/webp"
          ) {
            logWarn("主图类型不支持上传", { mime, imgUrl });
            continue;
          }
          const blob = new Blob([response], { type: mime });
          const name = `slide.${extFromMime(mime)}`;
          const uploaded = await submitAppendListingImage(config, blob, name);
          if (uploaded) {
            state.uploadedCarouselSrcs.add(imgUrl);
          }
        } catch (e) {
          logWarn(
            "轮播图处理异常",
            e instanceof Error ? e.message : String(e),
          );
        } finally {
          state.carouselInFlight.delete(imgUrl);
        }
      }
    } finally {
      state.carouselUploading = false;
    }
  };

  const enqueueCarouselImage = (config, imgUrl) => {
    if (state.uploadedCarouselSrcs.has(imgUrl)) {
      return;
    }
    if (state.carouselQueuedSrcs.has(imgUrl)) {
      return;
    }
    if (state.carouselInFlight.has(imgUrl)) {
      return;
    }
    state.carouselQueuedSrcs.add(imgUrl);
    state.carouselUploadQueue.push(imgUrl);
    void processCarouselUploadQueue(config);
  };

  const onCarouselMaybeChanged = async (config) => {
    const arrow = document.querySelector(".arrow-controller.right");
    if (!state.carouselObserveRoot) {
      ensureCarouselObserver(config);
      return;
    }
    if (arrow instanceof HTMLElement && !state.carouselObserveRoot.contains(arrow)) {
      ensureCarouselObserver(config);
      return;
    }
    if (!isMediaCaptureReady()) {
      return;
    }

    const imgUrls = collectCarouselImgUrls(state.carouselObserveRoot);
    for (const imgUrl of imgUrls) {
      enqueueCarouselImage(config, imgUrl);
    }
    maybeStartVideoSeekCapture(config);
  };

  const ensureCarouselObserver = (config) => {
    const arrow = document.querySelector(".arrow-controller.right");
    const root = findMediaRoot();
    if (!root) {
      teardownCarouselCapture();
      return;
    }
    const rootChanged = !state.carouselObserver || state.carouselObserveRoot !== root;
    if (rootChanged) {
      teardownCarouselCapture();
    }
    if (arrow instanceof HTMLElement && state.carouselArrowElement !== arrow) {
      if (state.carouselArrowElement && state.carouselClickHandler) {
        state.carouselArrowElement.removeEventListener(
          "click",
          state.carouselClickHandler,
        );
      }
      state.carouselClickHandler = () => {
        scheduleCarouselBurst(config);
      };
      arrow.addEventListener("click", state.carouselClickHandler);
      state.carouselArrowElement = arrow;
    } else if (!(arrow instanceof HTMLElement)) {
      state.carouselArrowElement = null;
      state.carouselClickHandler = null;
    }
    if (state.carouselObserver && state.carouselObserveRoot === root) {
      scheduleCarouselBurst(config);
      maybeStartVideoSeekCapture(config);
      return;
    }
    state.carouselObserveRoot = root;
    state.carouselObserver = new MutationObserver(() => {
      scheduleCarouselBurst(config);
    });
    state.carouselObserver.observe(root, {
      subtree: true,
      attributes: true,
      childList: true,
    });
    scheduleCarouselBurst(config);
    maybeStartVideoSeekCapture(config);
  };

  const setCopyButtonStatus = (text, disabled) => {
    if (!state.detailCopyButton) {
      return;
    }
    state.detailCopyButton.textContent = text;
    state.detailCopyButton.disabled = disabled;
    state.detailCopyButton.style.opacity = disabled ? "0.6" : "1";
  };

  /** 尽力抓取可选字段；抓不到就不放进 payload（不强求） */
  const gatherOptionalListingFieldsForIngest = () => {
    const out = {};
    const titleSelectors = [
      "#detail-title",
      ".note-content .title",
      ".title",
      "header h1",
      "h1",
    ];
    for (const selector of titleSelectors) {
      try {
        const el = document.querySelector(selector);
        const t = el?.textContent?.replace(/\s+/g, " ")?.trim();
        if (t && t.length > 0 && t.length < 400) {
          out.title = t;
          break;
        }
      } catch {
        /* ignore invalid selector */
      }
    }
    return out;
  };

  const parseIngestResult = (data) => {
    if (!data?.ok || !data?.id) {
      return null;
    }
    const listingKind =
      data.listingKind === "wanted" ||
      data.listingKind === "listing" ||
      data.listingKind === "other"
        ? data.listingKind
        : "listing";
    return {
      id: data.id,
      listingKind,
      classification: data.classification ?? null,
      sourceUrl: data.sourceUrl ?? null,
    };
  };

  const submitIngestAfterCopy = async (config, plainText) => {
    if (!config.ingest?.enable) {
      return null;
    }
    const baseUrl = config.ingest.baseUrl?.trim();
    if (!baseUrl) {
      return null;
    }
    const url = `${baseUrl.replace(/\/$/, "")}/api/xhs/rental-ingest`;
    const payload = {
      rawText: plainText,
      ...gatherOptionalListingFieldsForIngest(),
    };
    const body = JSON.stringify(payload);

    try {
      const { status, responseText } = await gmHttpPost(url, {
        "Content-Type": "application/json",
      }, body);
      let data = {};
      try {
        data = JSON.parse(responseText || "{}");
      } catch {
        data = {};
      }
      const ingestResult = parseIngestResult(data);
      if (status >= 200 && status < 300 && ingestResult) {
        logInfo("已写入远程数据库", {
          id: ingestResult.id,
          idShort: shortListingId(ingestResult.id),
          listingKind: ingestResult.listingKind,
          table:
            ingestResult.listingKind === "wanted"
              ? "XhsRentalWanted"
              : ingestResult.listingKind === "other"
                ? "(未入库)"
                : "XhsRentalListing",
          classification: ingestResult.classification,
          sourceUrlPending: ingestResult.sourceUrl,
          channel: "GM",
          hint:
            ingestResult.listingKind === "other"
              ? "经验/科普帖，未写入数据库（伪装成功）"
              : "分享成功后 sourceUrl 才会变成 https 链接",
        });
        return ingestResult;
      }
      logWarn("写入数据库失败", { status, data });
    } catch (firstError) {
      const msg =
        firstError instanceof Error ? firstError.message : String(firstError);
      if (msg !== "NO_GM_HTTP") {
        logWarn("写入数据库（GM）异常", msg);
        return null;
      }
      logWarn(
        "未检测到 GM.xmlHttpRequest / GM_xmlhttpRequest，改用 fetch（会走页面 CORS，易 PreflightDisallowedRedirect）。请确认脚本元数据含 @grant GM.xmlHttpRequest 并已保存、刷新页面。",
 );
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body,
        });
        const data = await response.json().catch(() => ({}));
        const ingestResult = parseIngestResult(data);
        if (response.ok && ingestResult) {
          logInfo("已写入远程数据库", {
            id: ingestResult.id,
            idShort: shortListingId(ingestResult.id),
            listingKind: ingestResult.listingKind,
            table:
              ingestResult.listingKind === "wanted"
                ? "XhsRentalWanted"
                : ingestResult.listingKind === "other"
                  ? "(未入库)"
                  : "XhsRentalListing",
            classification: ingestResult.classification,
            sourceUrlPending: ingestResult.sourceUrl,
            channel: "fetch",
            hint:
              ingestResult.listingKind === "other"
                ? "经验/科普帖，未写入数据库（伪装成功）"
                : "分享成功后 sourceUrl 才会变成 https 链接",
          });
          return ingestResult;
        }
        logWarn("写入数据库失败", { status: response.status, data });
      } catch (error) {
        logWarn(
          "写入数据库请求异常",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return null;
  };

  const copyPlainText = async (plainText) => {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(plainText);
      return true;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plainText);
      return true;
    }

    const helper = document.createElement("textarea");
    helper.value = plainText;
    helper.setAttribute("readonly", "readonly");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const succeeded = document.execCommand("copy");
    helper.remove();
    return succeeded;
  };

  const showCopySuccessToast = () => {
    document.getElementById("xhs-guide-copy-success-toast")?.remove();

    const toast = document.createElement("div");
    toast.id = "xhs-guide-copy-success-toast";
    toast.textContent = "✓ 复制成功";
    toast.style.position = "fixed";
    toast.style.right = "20px";
    toast.style.bottom = "150px";
    toast.style.zIndex = "2147483647";
    toast.style.background = "#16a34a";
    toast.style.color = "#ffffff";
    toast.style.fontSize = "14px";
    toast.style.fontWeight = "700";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "10px";
    toast.style.pointerEvents = "none";
    toast.style.boxShadow = "none";
    document.body.append(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 1600);
  };

  const showShareUrlSuccessToast = (listingId, sourceUrl) => {
    document.getElementById("xhs-guide-share-success-toast")?.remove();

    const toast = document.createElement("div");
    toast.id = "xhs-guide-share-success-toast";
    toast.textContent = `✓ 分享链接已写入 id=${shortListingId(listingId)}`;
    toast.title =
      typeof sourceUrl === "string"
        ? sourceUrl
        : "分享链接已写入数据库";
    toast.style.position = "fixed";
    toast.style.right = "20px";
    toast.style.bottom = "220px";
    toast.style.zIndex = "2147483647";
    toast.style.background = "#2563eb";
    toast.style.color = "#ffffff";
    toast.style.fontSize = "13px";
    toast.style.fontWeight = "700";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "10px";
    toast.style.pointerEvents = "none";
    toast.style.boxShadow = "none";
    toast.style.maxWidth = "320px";
    document.body.append(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 2600);
  };

  const showPendingShareToast = (listingId) => {
    document.getElementById("xhs-guide-pending-share-toast")?.remove();

    const toast = document.createElement("div");
    toast.id = "xhs-guide-pending-share-toast";
    toast.textContent = `⚠ 先完成分享同步 id=${shortListingId(listingId)}`;
    toast.style.position = "fixed";
    toast.style.right = "20px";
    toast.style.bottom = "220px";
    toast.style.zIndex = "2147483647";
    toast.style.background = "#f59e0b";
    toast.style.color = "#111827";
    toast.style.fontSize = "13px";
    toast.style.fontWeight = "700";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "10px";
    toast.style.pointerEvents = "none";
    toast.style.boxShadow = "none";
    document.body.append(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 2400);
  };

  const handleCopyButtonClick = async (config) => {
    if (!state.detailContentElement) {
      setCopyButtonStatus(config.detailCopy.missingText, true);
      window.setTimeout(() => {
        setCopyButtonStatus(config.detailCopy.buttonText, false);
      }, 1200);
      return;
    }

    const plainText = getPlainText(state.detailContentElement);
    if (!plainText) {
      setCopyButtonStatus(config.detailCopy.missingText, true);
      window.setTimeout(() => {
        setCopyButtonStatus(config.detailCopy.buttonText, false);
      }, 1200);
      return;
    }

    try {
      await copyPlainText(plainText);
      setCopyButtonStatus(config.detailCopy.copiedText, false);
      showCopySuccessToast();
      logInfo("正文复制成功", {
        version: SCRIPT_VERSION,
        chars: plainText.length,
      });
      state.bodyCopied = true;
      removeDetailCopyButton();
      if (state.listingId && !state.shareUrlDone) {
        setCopyButtonStatus(config.detailCopy.pendingShareText, true);
        showPendingShareToast(state.listingId);
        logWarn("上次复制的记录尚未写入分享链接，已阻止新建记录", {
          previousListingId: state.listingId,
          previousListingIdShort: shortListingId(state.listingId),
        });
        renderDetailHighlight(config);
        ensureShareClickListener(config);
        ensureSyncShareButton(config);
      } else {
        // 立即挂载监听，用户无需等待 API 返回再点分享
        state.pendingShareUrl = null;
        renderDetailHighlight(config);
        ensureShareClickListener(config);
        ensureSyncShareButton(config);

        const ingestResult = await submitIngestAfterCopy(config, plainText);
        if (ingestResult) {
          state.listingId = ingestResult.id;
          state.listingKind = ingestResult.listingKind;
          state.shareUrlDone = false;
          state.detailIngestReady = true;
          logInfo("listingId 已就绪", {
            version: SCRIPT_VERSION,
            listingId: ingestResult.id,
            listingIdShort: shortListingId(ingestResult.id),
            listingKind: ingestResult.listingKind,
            table:
              ingestResult.listingKind === "wanted"
                ? "XhsRentalWanted"
                : ingestResult.listingKind === "other"
                  ? "(未入库)"
                  : "XhsRentalListing",
            hint:
              ingestResult.listingKind === "other"
                ? "经验/科普帖，未写入数据库（伪装成功）"
                : "数据库请按 id 查此行；sourceUrl 列里的 pending:uuid 只是占位，不是行 id",
          });
          // 如果 API 返回前用户已完成分享复制，立即提交缓存的链接
          const buffered = state.pendingShareUrl;
          if (buffered && !state.shareUrlDone) {
            state.pendingShareUrl = null;
            logInfo("提交缓冲的分享链接", { sourceUrl: buffered.slice(0, 100) });
            void handleCapturedClipboardText(config, buffered, "buffered");
          }
        }
      }
    } catch (error) {
      setCopyButtonStatus(config.detailCopy.copyFailText, false);
      logWarn("正文复制失败", error instanceof Error ? error.message : String(error));
    }

    window.setTimeout(() => {
      setCopyButtonStatus(config.detailCopy.buttonText, false);
    }, 1200);
  };

  const ensureDetailCopyButton = (config) => {
    if (state.bodyCopied || state.detailCopyButton?.parentNode) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "xhs-guide-copy-button";
    button.textContent = config.detailCopy.buttonText;
    button.style.position = "fixed";
    button.style.right = "20px";
    button.style.bottom = "20px";
    button.style.zIndex = "2147483647";
    button.style.pointerEvents = "auto";
    button.style.border = "none";
    button.style.borderRadius = "30px";
    button.style.padding = "30px 42px";
    button.style.fontSize = "42px";
    button.style.fontWeight = "600";
    button.style.background = "#ff2442";
    button.style.color = "#ffffff";
    button.style.boxShadow = "0 18px 54px rgba(0, 0, 0, 0.25)";
    button.style.cursor = "pointer";
    button.addEventListener("click", () => {
      void handleCopyButtonClick(config);
    });
    document.body.append(button);
    state.detailCopyButton = button;
  };

  const isClickOnCandidate = (candidate, event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return false;
    }
    const postRoot =
      candidate.postRoot ?? getCandidatePostRoot(candidate.element);
    if (!(postRoot instanceof Element)) {
      return false;
    }
    return postRoot.contains(target) || postRoot === target;
  };

  const dismissTitleCandidate = (config, candidate) => {
    const dismissKey = getTitleDismissKey(candidate);
    state.dismissedTitleKeys.add(dismissKey);
    state.matchedById.delete(candidate.id);
    const liveMatches = Array.from(state.matchedById.values()).filter(
      (item) =>
        document.body.contains(item.element) &&
        !state.dismissedTitleKeys.has(getTitleDismissKey(item)),
    );
    renderHighlightItems(liveMatches, config);
  };

  const handleTitleClickDismiss = (config, event) => {
    if (state.mode !== "title") {
      return;
    }
    for (const candidate of state.matchedById.values()) {
      const dismissKey = getTitleDismissKey(candidate);
      if (state.dismissedTitleKeys.has(dismissKey)) {
        continue;
      }
      if (!isClickOnCandidate(candidate, event)) {
        continue;
      }
      dismissTitleCandidate(config, candidate);
      return;
    }
  };

  const setupTitleClickDismiss = (config) => {
    if (state.titleClickHandler) {
      return;
    }
    state.titleClickHandler = (event) => {
      handleTitleClickDismiss(config, event);
    };
    document.addEventListener("pointerdown", state.titleClickHandler, true);
  };

  const teardownTitleClickDismiss = () => {
    if (state.titleClickHandler) {
      document.removeEventListener("pointerdown", state.titleClickHandler, true);
      state.titleClickHandler = null;
    }
  };

  const scheduleRender = (config) => {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
    }
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      const liveMatches = Array.from(state.matchedById.values()).filter(
        (item) =>
          document.body.contains(item.element) &&
          !state.dismissedTitleKeys.has(getTitleDismissKey(item)),
      );
      renderHighlightItems(liveMatches, config);
    });
  };

  const analyzeRound = async (config) => {
    // 串行化：若上一轮尚未结束，标记"需要再跑一次"，直接返回
    if (state.analyzeInFlight) {
      state.analyzeScheduled = true;
      return;
    }
    state.analyzeInFlight = true;
    state.analyzeScheduled = false;

    try {
      state.llmReviewedInRound = 0;

      const candidates = collectVisibleTitleCandidates(config);
      const relatedInRound = [];
      const needLlm = [];

      // 第一遍：缓存命中或规则命中的先立刻渲染，不等 LLM
      for (const candidate of candidates) {
        const cacheKey = normalizeTitle(candidate.text).toLowerCase();
        if (state.dismissedTitleKeys.has(getTitleDismissKey(candidate))) {
          continue;
        }
        const cached = state.judgeCache.get(cacheKey);
        if (cached) {
          if (cached.isBayAreaRentingRelated) {
            candidate.judgement = cached;
            relatedInRound.push(candidate);
          }
          continue;
        }

        const input = {
          titleText: candidate.text,
          pageUrl: window.location.href,
          collectedAt: new Date().toISOString(),
        };
        const ruleResult = ruleScreenStage(input, config);
        const immediateResult = {
          isBayAreaRentingRelated:
            ruleResult.passed &&
            ruleResult.confidence >= config.judgement.minConfidenceToHighlight,
          confidence: ruleResult.confidence,
          reason: ruleResult.reason,
          stageTrace: [ruleResult],
        };

        if (immediateResult.isBayAreaRentingRelated) {
          candidate.judgement = immediateResult;
          relatedInRound.push(candidate);
        }

        if (ruleResult.skipLlm) {
          state.judgeCache.set(cacheKey, immediateResult);
          continue;
        }

        if (!state.inFlightText.has(cacheKey)) {
          needLlm.push({ candidate, cacheKey, input, ruleResult });
        }
      }

      // 立即渲染缓存命中 + 规则乐观命中项
      state.matchedById.clear();
      for (const candidate of relatedInRound) {
        if (!state.dismissedTitleKeys.has(getTitleDismissKey(candidate))) {
          state.matchedById.set(candidate.id, candidate);
        }
      }
      if (relatedInRound.length > 0) {
        scheduleRender(config);
      }

      // 第二遍：LLM 批量后台复核，回来后只做纠错
      const llmJobs = needLlm.slice(0, config.judgement.maxLlmReviewsPerRound);
      for (const job of llmJobs) {
        state.inFlightText.add(job.cacheKey);
      }
      try {
        const batchResults = await llmBatchReviewStage(
          llmJobs.map((job) => job.input),
          config,
        );
        for (let index = 0; index < llmJobs.length; index += 1) {
          const job = llmJobs[index];
          const parsed = batchResults.get(index);
          const llmResult = parsed
            ? {
                stageName: "llmBatchReviewStage",
                skipped: false,
                passed: parsed.related,
                confidence: parsed.confidence,
                reason: parsed.reason,
              }
            : {
                stageName: "llmBatchReviewStage",
                skipped: true,
                passed: job.ruleResult.passed,
                confidence: job.ruleResult.confidence,
                reason: "LLM 批量复核未返回该项，保留规则结果",
              };
          const postResult = postProcessStage(job.ruleResult, llmResult, config);
          const finalResult = {
            isBayAreaRentingRelated: postResult.isBayAreaRentingRelated,
            confidence: postResult.confidence,
            reason: postResult.reason,
            stageTrace: [job.ruleResult, llmResult, postResult],
          };
          state.judgeCache.set(job.cacheKey, finalResult);

          if (finalResult.isBayAreaRentingRelated) {
            job.candidate.judgement = finalResult;
            if (!state.dismissedTitleKeys.has(getTitleDismissKey(job.candidate))) {
              state.matchedById.set(job.candidate.id, job.candidate);
            }
          } else {
            state.matchedById.delete(job.candidate.id);
          }
        }
      } catch (error) {
        logWarn(
          "LLM 批量复核失败，保留本地规则结果",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        for (const job of llmJobs) {
          state.inFlightText.delete(job.cacheKey);
        }
        scheduleRender(config);
      }

      scheduleRender(config);
      logInfo("本轮完成", {
        scanned: candidates.length,
        highlighted: relatedInRound.length,
        llmReviewed: state.llmReviewedInRound,
      });
    } finally {
      state.analyzeInFlight = false;
      // 如果期间有新的触发请求，立即再跑一轮
      if (state.analyzeScheduled) {
        state.analyzeScheduled = false;
        void analyzeRound(config);
      }
    }
  };

  const refreshDetailMode = (config) => {
    ensureDetailCopyButton(config);
    state.detailContentElement = findDetailContentElement(config);
    renderDetailHighlight(config);
    ensureShareClickListener(config);
    ensureSyncShareButton(config);
    if (isMediaCaptureReady()) {
      ensureCarouselObserver(config);
    }

    if (state.detailContentElement && getPlainText(state.detailContentElement)) {
      setCopyButtonStatus(config.detailCopy.buttonText, false);
      return;
    }
    setCopyButtonStatus(config.detailCopy.missingText, true);
  };

  const setupObservers = (config) => {
    const triggerAnalyze = () => {
      void analyzeRound(config);
    };

    state.scrollHandler = () => {
      scheduleRender(config);
    };
    state.resizeHandler = () => {
      triggerAnalyze();
    };
    window.addEventListener("scroll", state.scrollHandler, { passive: true });
    window.addEventListener("resize", state.resizeHandler);

    state.observer = new MutationObserver(() => {
      triggerAnalyze();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  };

  const setupDetailModeObservers = (config) => {
    const scheduleRefresh = () => {
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
      }
      state.rafId = requestAnimationFrame(() => {
        state.rafId = 0;
        refreshDetailMode(config);
      });
    };

    state.scrollHandler = () => {
      scheduleRefresh();
    };
    state.resizeHandler = () => {
      scheduleRefresh();
    };

    window.addEventListener("scroll", state.scrollHandler, { passive: true });
    window.addEventListener("resize", state.resizeHandler);

    state.observer = new MutationObserver(() => {
      scheduleRefresh();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  };

  const teardown = () => {
    if (state.loopTimer) {
      clearInterval(state.loopTimer);
      state.loopTimer = 0;
    }
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    if (state.detailTimer) {
      clearInterval(state.detailTimer);
      state.detailTimer = 0;
    }
    if (state.scrollHandler) {
      window.removeEventListener("scroll", state.scrollHandler);
      state.scrollHandler = null;
    }
    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
      state.resizeHandler = null;
    }
    state.observer?.disconnect();
    state.observer = null;
    state.matchedById.clear();
    teardownTitleClickDismiss();
    state.detailContentElement = null;
    state.mode = "idle";
    state.detailIngestReady = false;
    state.bodyCopied = false;
    state.listingId = null;
    state.shareUrlDone = false;
    teardownShareCapture();
    state.pageClipboardBridgeInjected = false;
    teardownCarouselCapture();
    state.uploadedCarouselSrcs.clear();
    removeDetailCopyButton();
    removeSyncShareButton();
    clearOverlay();
  };

  const bootTitleMode = (config) => {
    ensureOverlayRoot();
    setupTitleClickDismiss(config);
    setupObservers(config);
    void analyzeRound(config);
    state.loopTimer = window.setInterval(() => {
      void analyzeRound(config);
    }, config.app.loopIntervalMs);
    logInfo("多标题判断高亮已启动", {
      appId: config.app.id,
      llmEnabled: config.judgement.enableLlmReview,
    });
    state.mode = "title";
  };

  const bootDetailCopyMode = (config) => {
    ensureOverlayRoot();
    injectPageClipboardBridge();
    setupDetailModeObservers(config);
    refreshDetailMode(config);
    state.detailTimer = window.setInterval(() => {
      refreshDetailMode(config);
    }, config.detailCopy.pollIntervalMs);
    logInfo("详情页复制引导已启动", { version: SCRIPT_VERSION });
    state.mode = "detail";
  };

  const switchModeByUrl = (config) => {
    const nextMode = isDetailPage(config) ? "detail" : "title";
    if (nextMode === state.mode) {
      return;
    }
    teardown();
    if (nextMode === "detail") {
      bootDetailCopyMode(config);
      return;
    }
    bootTitleMode(config);
  };

  const boot = () => {
    const config = DEFAULT_CONFIG;
    if (!isUrlMatched(config.app)) {
      logInfo("当前 URL 不在匹配范围，跳过");
      return;
    }

    switchModeByUrl(config);
    state.currentUrl = window.location.href;
    state.routeTimer = window.setInterval(() => {
      if (window.location.href === state.currentUrl) {
        return;
      }
      state.currentUrl = window.location.href;
      switchModeByUrl(config);
    }, 500);

    window.addEventListener("beforeunload", () => {
      if (state.routeTimer) {
        clearInterval(state.routeTimer);
        state.routeTimer = 0;
      }
      teardown();
    });
  };

  boot();
})();
