// ==UserScript==
// @name         xhs-guide-title-judge
// @namespace    https://willinglink.local/
// @version      0.5.4
// @description  小红书多标题识别高亮 + 详情页复制正文指引
// @author       local
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/* global GM, GM_setClipboard, GM_xmlhttpRequest */

(() => {
  "use strict";

  const LOG_PREFIX = "[xhs-guide]";
  const MAX_HIGHLIGHT_COUNT = 10;
  const VIEWPORT_MARGIN = 8;

  const DEFAULT_CONFIG = {
    app: {
      id: "title-judge-v1",
      urlPattern: "xiaohongshu.com",
      loopIntervalMs: 1800,
    },
    titleScan: {
      selectorCandidates: [
        'a[href*="/explore/"] [class*="title"]',
        "section .title span",
        'a[href*="/explore/"] h3',
      ],
      minTitleLength: 4,
      maxTitlesPerRound: 20,
    },
    judgement: {
      enableLlmReview: false,
      llmTimeoutMs: 12000,
      maxLlmReviewsPerRound: 4,
      llmMinIntervalMs: 700,
      minConfidenceToHighlight: 0.6,
      rule: {
        cityKeywords: [
          "湾区",
          "Bay Area",
          "San Francisco",
          "San Jose",
          "Oakland",
          "Palo Alto",
          "Fremont",
          "Santa Clara",
          "Mountain View",
          "Sunnyvale",
          "伯克利",
          "旧金山",
          "硅谷",
        ],
        rentKeywords: [
          "租房",
          "转租",
          "求租",
          "出租",
          "找室友",
          "合租",
          "lease",
          "sublease",
          "roommate",
          "rent",
          "studio",
          "1b1b",
          "2b2b",
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
      overlayShadow: "0 0 0 9999px rgba(0, 0, 0, 0.2)",
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
      copyFailText: "复制失败",
      missingText: "未找到正文",
      hintText: "点击右下角按钮复制正文",
      pollIntervalMs: 1500,
    },
    detailImage: {
      nextArrowSelectorCandidates: [
        'button[aria-label*="右"]',
        'button[aria-label*="下一"]',
        'button:has(svg)',
      ],
      imageSelectorCandidates: [
        'img[src*="xhscdn.com"]',
        'img[src*="sns-webpic"]',
      ],
      arrowHintText: "请点击官方右箭头切换图片（我会自动收集）",
    },
    /** 复制成功后 POST 到 Next /api/xhs/rental-ingest。请用 https 根地址，避免 http→https 重定向触发 CORS 预检失败 */
    ingest: {
      enable: true,
      baseUrl: "https://你的项目.vercel.app",
    },
  };

  const state = {
    overlayRoot: null,
    judgeCache: new Map(),
    inFlightText: new Set(),
    matchedById: new Map(),
    llmReviewedInRound: 0,
    lastLlmCallAt: 0,
    loopTimer: 0,
    detailTimer: 0,
    rafId: 0,
    observer: null,
    detailContentElement: null,
    detailCopyButton: null,
    detailNextArrowElement: null,
    detailCollectedImageUrls: new Set(),
    scrollHandler: null,
    resizeHandler: null,
    mode: "idle",
    currentUrl: window.location.href,
    routeTimer: 0,
  };

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

  const isElementVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const inViewport =
      rect.bottom >= VIEWPORT_MARGIN &&
      rect.right >= VIEWPORT_MARGIN &&
      rect.top <= window.innerHeight - VIEWPORT_MARGIN &&
      rect.left <= window.innerWidth - VIEWPORT_MARGIN;
    return inViewport && rect.width > 0 && rect.height > 0;
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

        const id = makeCandidateId(text, element);
        if (dedup.has(id)) {
          continue;
        }
        dedup.add(id);
        candidates.push({
          id,
          text,
          element,
          sourceSelector: selector,
          rect: element.getBoundingClientRect(),
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

  const findDetailNextArrowElement = (config) => {
    for (const selector of config.detailImage.nextArrowSelectorCandidates) {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        logWarn("右箭头选择器无效", selector);
      }

      for (const rawElement of elements) {
        if (!(rawElement instanceof HTMLElement)) {
          continue;
        }
        const rect = rawElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        if (rect.left < window.innerWidth * 0.55) {
          continue;
        }
        return rawElement;
      }
    }
    return null;
  };

  const collectCurrentCarouselImageUrls = (config) => {
    const urls = [];
    const dedup = new Set();
    for (const selector of config.detailImage.imageSelectorCandidates) {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        logWarn("图片选择器无效", selector);
      }

      for (const rawElement of elements) {
        if (!(rawElement instanceof HTMLImageElement)) {
          continue;
        }
        const src = (rawElement.currentSrc || rawElement.src || "").trim();
        if (!src || dedup.has(src)) {
          continue;
        }
        const rect = rawElement.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 150) {
          continue;
        }
        if (rect.top > window.innerHeight * 0.8) {
          continue;
        }
        dedup.add(src);
        urls.push(src);
      }
    }
    return urls;
  };

  const collectDetailImages = (config) => {
    const currentUrls = collectCurrentCarouselImageUrls(config);
    let added = 0;
    for (const url of currentUrls) {
      if (!state.detailCollectedImageUrls.has(url)) {
        state.detailCollectedImageUrls.add(url);
        added += 1;
      }
    }
    if (added > 0) {
      logInfo("已收集图片", {
        added,
        total: state.detailCollectedImageUrls.size,
      });
    }
  };

  const ruleScreenStage = (input, config) => {
    const normalizedLower = input.titleText.toLowerCase();
    const cityHit = config.judgement.rule.cityKeywords.find((word) =>
      normalizedLower.includes(word.toLowerCase()),
    );
    const rentHit = config.judgement.rule.rentKeywords.find((word) =>
      normalizedLower.includes(word.toLowerCase()),
    );

    const passed = Boolean(cityHit && rentHit);
    const confidence = passed ? 0.62 : 0.1;

    return {
      stageName: "ruleScreenStage",
      passed,
      confidence,
      reason: passed
        ? `规则命中: 城市词(${cityHit}) + 租房词(${rentHit})`
        : "规则未同时命中城市词和租房词",
      cityHit: cityHit || "",
      rentHit: rentHit || "",
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

  const parseLlmJudgement = (rawText) => {
    const content = rawText.trim();
    const matched = content.match(/\{[\s\S]*\}/);
    const jsonText = matched ? matched[0] : content;
    const parsed = JSON.parse(jsonText);

    return {
      related: Boolean(parsed.related),
      confidence: clamp(Number(parsed.confidence) || 0.5, 0, 1),
      reason: typeof parsed.reason === "string" ? parsed.reason : "LLM 未提供原因",
    };
  };

  const llmReviewStage = async (input, config) => {
    const llmConfig = config.judgement.llm;
    if (!config.judgement.enableLlmReview) {
      return {
        stageName: "llmReviewStage",
        skipped: true,
        passed: true,
        confidence: 0.5,
        reason: "LLM 复核开关关闭，跳过",
      };
    }

    if (!llmConfig.apiKey) {
      return {
        stageName: "llmReviewStage",
        skipped: true,
        passed: true,
        confidence: 0.5,
        reason: "未配置 API Key，降级为规则结果",
      };
    }

    const elapsed = now() - state.lastLlmCallAt;
    if (elapsed < config.judgement.llmMinIntervalMs) {
      await sleep(config.judgement.llmMinIntervalMs - elapsed);
    }

    if (state.llmReviewedInRound >= config.judgement.maxLlmReviewsPerRound) {
      return {
        stageName: "llmReviewStage",
        skipped: true,
        passed: true,
        confidence: 0.5,
        reason: "达到单轮 LLM 复核上限，降级为规则结果",
      };
    }

    const systemPrompt =
      "你是帖子分类器。仅判断标题是否与美国湾区租房相关。输出 JSON: {\"related\": boolean, \"confidence\": 0-1, \"reason\": string}";
    const userPrompt = `标题: ${input.titleText}`;

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
    state.llmReviewedInRound += 1;

    const text = response?.choices?.[0]?.message?.content || "";
    const parsed = parseLlmJudgement(text);
    return {
      stageName: "llmReviewStage",
      skipped: false,
      passed: parsed.related,
      confidence: parsed.confidence,
      reason: parsed.reason,
    };
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

  const runTitleJudgementPipeline = async (candidate, config) => {
    const input = {
      titleText: candidate.text,
      pageUrl: window.location.href,
      collectedAt: new Date().toISOString(),
    };
    const stageTrace = [];

    const ruleResult = ruleScreenStage(input, config);
    stageTrace.push(ruleResult);
    if (!ruleResult.passed) {
      return {
        isBayAreaRentingRelated: false,
        confidence: ruleResult.confidence,
        reason: ruleResult.reason,
        stageTrace,
      };
    }

    let llmResult;
    try {
      llmResult = await llmReviewStage(input, config);
    } catch (error) {
      llmResult = {
        stageName: "llmReviewStage",
        skipped: true,
        passed: true,
        confidence: ruleResult.confidence,
        reason: `LLM 失败，降级规则结果: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    stageTrace.push(llmResult);

    const postResult = postProcessStage(ruleResult, llmResult, config);
    stageTrace.push(postResult);
    return {
      isBayAreaRentingRelated: postResult.isBayAreaRentingRelated,
      confidence: postResult.confidence,
      reason: postResult.reason,
      stageTrace,
    };
  };

  const renderHighlightItems = (candidates, config) => {
    const root = ensureOverlayRoot();
    root.replaceChildren();

    const list = candidates.slice(0, MAX_HIGHLIGHT_COUNT);
    for (const candidate of list) {
      const rect = candidate.element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const padding = 5;
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
      bubble.textContent = `${config.highlight.hintPrefix} (${Math.round(candidate.judgement.confidence * 100)}%)`;

      root.append(box, bubble);
    }
  };

  const renderDetailHighlight = (config) => {
    const root = ensureOverlayRoot();
    root.replaceChildren();

    const element = state.detailNextArrowElement || state.detailCopyButton;
    if (!element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

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
    bubble.textContent = state.detailNextArrowElement
      ? config.detailImage.arrowHintText
      : config.detailCopy.hintText;

    root.append(box, bubble);
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
    const imageUrls = Array.from(state.detailCollectedImageUrls);
    if (imageUrls.length > 0) {
      out.imageUrls = imageUrls;
    }
    return out;
  };

  const submitIngestAfterCopy = async (config, plainText) => {
    if (!config.ingest?.enable) {
      return;
    }
    const baseUrl = config.ingest.baseUrl?.trim();
    if (!baseUrl) {
      return;
    }
    const url = `${baseUrl.replace(/\/$/, "")}/api/xhs/rental-ingest`;
    const payload = {
      pageUrl: window.location.href,
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
      if (status >= 200 && status < 300 && data?.ok) {
        logInfo("已写入远程数据库", { id: data.id, channel: "GM" });
        return;
      }
      logWarn("写入数据库失败", { status, data });
    } catch (firstError) {
      const msg =
        firstError instanceof Error ? firstError.message : String(firstError);
      if (msg !== "NO_GM_HTTP") {
        logWarn("写入数据库（GM）异常", msg);
        return;
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
        if (response.ok && data?.ok) {
          logInfo("已写入远程数据库", { id: data.id, channel: "fetch" });
          return;
        }
        logWarn("写入数据库失败", { status: response.status, data });
      } catch (error) {
        logWarn(
          "写入数据库请求异常",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
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
      logInfo("正文复制成功", { chars: plainText.length });
      await submitIngestAfterCopy(config, plainText);
    } catch (error) {
      setCopyButtonStatus(config.detailCopy.copyFailText, false);
      logWarn("正文复制失败", error instanceof Error ? error.message : String(error));
    }

    window.setTimeout(() => {
      setCopyButtonStatus(config.detailCopy.buttonText, false);
    }, 1200);
  };

  const ensureDetailCopyButton = (config) => {
    if (state.detailCopyButton?.parentNode) {
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
    button.style.borderRadius = "10px";
    button.style.padding = "10px 14px";
    button.style.fontSize = "14px";
    button.style.fontWeight = "600";
    button.style.background = "#ff2442";
    button.style.color = "#ffffff";
    button.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.25)";
    button.style.cursor = "pointer";
    button.addEventListener("click", () => {
      void handleCopyButtonClick(config);
    });
    document.body.append(button);
    state.detailCopyButton = button;
  };

  const scheduleRender = (config) => {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
    }
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      const liveMatches = Array.from(state.matchedById.values()).filter((item) =>
        document.body.contains(item.element),
      );
      renderHighlightItems(liveMatches, config);
    });
  };

  const analyzeRound = async (config) => {
    state.llmReviewedInRound = 0;

    const candidates = collectVisibleTitleCandidates(config);
    const relatedInRound = [];

    for (const candidate of candidates) {
      const cacheKey = normalizeTitle(candidate.text).toLowerCase();
      const cached = state.judgeCache.get(cacheKey);
      if (cached) {
        if (cached.isBayAreaRentingRelated) {
          candidate.judgement = cached;
          relatedInRound.push(candidate);
        }
        continue;
      }

      if (state.inFlightText.has(cacheKey)) {
        continue;
      }
      state.inFlightText.add(cacheKey);
      const result = await runTitleJudgementPipeline(candidate, config);
      state.judgeCache.set(cacheKey, result);
      state.inFlightText.delete(cacheKey);

      if (result.isBayAreaRentingRelated) {
        candidate.judgement = result;
        relatedInRound.push(candidate);
      }
    }

    state.matchedById.clear();
    for (const candidate of relatedInRound) {
      state.matchedById.set(candidate.id, candidate);
    }
    scheduleRender(config);
    logInfo("本轮完成", {
      scanned: candidates.length,
      highlighted: relatedInRound.length,
      llmReviewed: state.llmReviewedInRound,
    });
  };

  const refreshDetailMode = (config) => {
    ensureDetailCopyButton(config);
    state.detailNextArrowElement = findDetailNextArrowElement(config);
    state.detailContentElement = findDetailContentElement(config);
    collectDetailImages(config);
    renderDetailHighlight(config);

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
    state.detailContentElement = null;
    state.detailNextArrowElement = null;
    state.detailCollectedImageUrls.clear();
    state.mode = "idle";
    removeDetailCopyButton();
    clearOverlay();
  };

  const bootTitleMode = (config) => {
    ensureOverlayRoot();
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
    setupDetailModeObservers(config);
    refreshDetailMode(config);
    state.detailTimer = window.setInterval(() => {
      refreshDetailMode(config);
    }, config.detailCopy.pollIntervalMs);
    logInfo("详情页复制引导已启动");
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
      if (state.mode === "detail" && isDetailPage(config)) {
        state.detailCollectedImageUrls.clear();
      }
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
