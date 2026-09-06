/**
 * 把合租房大脑的评测报告 JSON 渲染成一个**自包含的 HTML 页面**，
 * 让人像读聊天记录一样逐轮验收 AI 说得对不对。
 *
 * 用法：
 *   pnpm tsx scripts/coliving-report.ts                   # 用 reports/ 里最新的一份
 *   pnpm tsx scripts/coliving-report.ts --report <path>   # 指定报告文件
 *   pnpm tsx scripts/coliving-report.ts --out <path.html> # 指定输出位置
 *
 * 设计取舍（页面的唯一目的是"快速看出这句话说得对不对"，不是好看）：
 * - **对话是主体**：住户的话靠左、AI 回复靠右，像聊天记录一样读下来。
 *   一眼分得清谁说的，比任何统计图表都重要。
 * - **outbound 和 reply 必须分开**：reply 是回给说话那个人的，outbound 是
 *   AI 同一轮**主动发给第三方**的。这是两种完全不同的东西，混在一起就
 *   看不出"发给被投诉方的措辞不对"这类只出现在 outbound 里的问题，
 *   所以 outbound 单独成卡片、单独标出收件人。
 * - **被拦下的 outbound 要显眼**：划掉 + 红框 + "未发出"标签 + 拦下原因。
 *   这是审稿系统真的起作用的证据，用户要能直接看到，不能藏起来。
 * - **judge 的问题锚定到轮次里**：写在对应那一轮下面，而不是堆在场景末尾。
 *   评语离原话越近，越容易判断这条评语本身是不是对的。
 * - **失败的排前面、默认展开；通过的折叠**：用户时间宝贵，先看有问题的。
 * - 纯字符串拼 HTML，不引模板引擎；CSS 内联、不引外部字体/CDN，
 *   一个文件双击就能看，也不会被 CSP 拦。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// ── 输入数据契约（由 coliving-eval 产出，本脚本只读不改） ────────────────
type TurnRecord = {
  fromName: string;
  fromRole: string;
  said: string;
  reply: string;
  toolsUsed: string[];
  outbound: Array<{
    toName: string;
    text: string;
    blocked: boolean;
    blockReason?: string;
  }>;
};

type JudgeFinding = {
  severity: "high" | "medium" | "low";
  turnIndex: number;
  issue: string;
  quote: string;
};

type ScenarioResult = {
  id: string;
  source: string;
  pass: boolean;
  failures: string[];
  turns: TurnRecord[];
  judge?: { pass: boolean; findings: JudgeFinding[] };
  ms: number;
};

// ── CLI args（照抄 coliving-eval.ts 的写法） ─────────────────────────────
function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const REPORT_ARG = argValue("report");
const OUT_ARG = argValue("out");

const REPORT_DIR = path.join(process.cwd(), "tests/coliving-eval/reports");

/** 没指定 --report 时取目录里**改动时间最新**的 JSON（不是文件名最新——
 *  同一天跑两次会覆盖同名文件，按 mtime 才是"刚跑完的那份"）。 */
function findLatestReport(): string {
  if (!existsSync(REPORT_DIR)) {
    fail(
      `找不到报告目录 ${REPORT_DIR}\n` +
        "先跑一次 `pnpm coliving-eval` 产出报告，或者用 --report 指定文件。"
    );
  }
  const candidates = readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = path.join(REPORT_DIR, f);
      return { p, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    fail(
      `报告目录 ${REPORT_DIR} 里没有 .json 报告。\n` +
        "先跑一次 `pnpm coliving-eval`，或者用 --report 指定文件。"
    );
  }
  return candidates[0].p;
}

/** 统一的"讲人话"退出：报错要说清楚是什么问题、下一步该干什么，不抛裸异常。 */
function fail(message: string): never {
  console.error(`\n生成报告页面失败：${message}\n`);
  process.exit(1);
}

// ── 读 + 校验报告 ────────────────────────────────────────────────────────
function loadReport(file: string): ScenarioResult[] {
  if (!existsSync(file)) {
    fail(`报告文件不存在：${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`报告文件不是合法 JSON：${file}\n${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) {
    fail(`报告文件的顶层应该是一个数组（ScenarioResult[]），实际是 ${typeof raw}：${file}`);
  }
  const results: ScenarioResult[] = [];
  for (const [i, item] of raw.entries()) {
    const o = item as Partial<ScenarioResult> & Record<string, unknown>;
    if (typeof o?.id !== "string") {
      fail(`报告第 ${i} 项缺 id 字段：${file}`);
    }
    if (!Array.isArray(o.turns)) {
      // 老版 runner 只存最后一轮（lastReply / outboundTexts），渲染不出对话，
      // 单独认一下给条明确的话，别让人对着"缺 turns"猜半天
      const legacy = "lastReply" in o || "outboundTexts" in o;
      fail(
        legacy
          ? `报告 ${file} 是**旧格式**（只有 lastReply，没有逐轮的 turns），` +
              "渲染不出对话。请用产出逐轮记录的新版 coliving-eval 重新跑一次。"
          : `报告第 ${i} 项（${o.id}）缺 turns 数组：${file}`
      );
    }
    // 其余字段缺了不致命，补默认值继续渲染——报告是拿来看问题的，
    // 因为某个可选字段没写就整页打不开，反而挡住了要看的东西
    results.push({
      id: o.id,
      source: typeof o.source === "string" ? o.source : "",
      pass: o.pass !== false,
      failures: Array.isArray(o.failures) ? o.failures.map(String) : [],
      turns: (o.turns as TurnRecord[]).map((t) => ({
        fromName: t?.fromName ?? "（未知）",
        fromRole: t?.fromRole ?? "",
        said: t?.said ?? "",
        reply: t?.reply ?? "",
        toolsUsed: Array.isArray(t?.toolsUsed) ? t.toolsUsed : [],
        outbound: Array.isArray(t?.outbound)
          ? t.outbound.map((m) => ({
              toName: m?.toName ?? "（未知）",
              text: m?.text ?? "",
              blocked: m?.blocked === true,
              blockReason: m?.blockReason,
            }))
          : [],
      })),
      judge: o.judge
        ? {
            pass: (o.judge as { pass?: boolean }).pass !== false,
            findings: Array.isArray((o.judge as { findings?: unknown }).findings)
              ? ((o.judge as { findings: JudgeFinding[] }).findings).map((f) => ({
                  severity:
                    f?.severity === "high" || f?.severity === "medium" ? f.severity : "low",
                  turnIndex: Number.isInteger(f?.turnIndex) ? f.turnIndex : -1,
                  issue: f?.issue ?? "",
                  quote: f?.quote ?? "",
                }))
              : [],
          }
        : undefined,
      ms: typeof o.ms === "number" ? o.ms : 0,
    });
  }
  return results;
}

// ── HTML 工具 ────────────────────────────────────────────────────────────
/** 消息正文、issue、quote 里都可能带 < & " '，一律转义后再拼进 HTML。 */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 用作 id/anchor 的安全串。 */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const ROLE_LABEL: Record<string, string> = {
  landlord: "房东",
  tenant: "住客",
};

const SEVERITY_LABEL: Record<JudgeFinding["severity"], string> = {
  high: "严重",
  medium: "一般",
  low: "轻微",
};

// ── 渲染：一轮里的工具标签 ───────────────────────────────────────────────
/** 同名工具一轮里常调好几次，去重 + 标 ×N，省视觉空间又不丢信息。 */
function renderTools(tools: string[]): string {
  if (tools.length === 0) return "";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  const chips = [...counts.entries()]
    .map(
      ([name, n]) =>
        `<span class="tool">${escapeHtml(name)}${n > 1 ? `<i>×${n}</i>` : ""}</span>`
    )
    .join("");
  return `<div class="tools">${chips}</div>`;
}

// ── 渲染：judge 的一条问题 ───────────────────────────────────────────────
function renderFinding(f: JudgeFinding): string {
  const quote = f.quote
    ? `<blockquote class="quote">${escapeHtml(f.quote)}</blockquote>`
    : "";
  return `<div class="finding sev-${f.severity}">
      <div class="finding-head"><span class="sev">${SEVERITY_LABEL[f.severity]}</span>${escapeHtml(f.issue)}</div>
      ${quote}
    </div>`;
}

// ── 渲染：一轮对话 ───────────────────────────────────────────────────────
function renderTurn(t: TurnRecord, index: number, findings: JudgeFinding[]): string {
  const role = ROLE_LABEL[t.fromRole] ?? t.fromRole;
  const roleTag = role ? `<span class="role">${escapeHtml(role)}</span>` : "";

  const said = t.said
    ? `<div class="row left">
         <div class="bubble said">
           <div class="bubble-tag">${escapeHtml(t.fromName)} 说</div>
           <div class="text">${escapeHtml(t.said)}</div>
         </div>
       </div>`
    : "";

  const reply = t.reply
    ? `<div class="row right">
         <div class="bubble reply">
           <div class="bubble-tag">AI 回复 ${escapeHtml(t.fromName)}</div>
           <div class="text">${escapeHtml(t.reply)}</div>
         </div>
       </div>`
    : `<div class="row right"><div class="bubble reply empty">（这一轮没有回复）</div></div>`;

  // outbound 单独一块：跟 reply 拉开距离（虚线框 + 不同底色 + "主动外发"抬头），
  // 因为"发给第三方的措辞"是只可能出现在这里的一类问题
  const outbound = t.outbound
    .map((m) => {
      const blockedTag = m.blocked
        ? '<span class="badge-blocked">未发出 · 被审稿拦下</span>'
        : "";
      const reason =
        m.blocked && m.blockReason
          ? `<div class="ob-reason">拦下原因：${escapeHtml(m.blockReason)}</div>`
          : "";
      return `<div class="ob${m.blocked ? " blocked" : ""}">
          <div class="ob-head"><span class="ob-kind">主动外发</span><span class="ob-to">→ ${escapeHtml(m.toName)}</span>${blockedTag}</div>
          <div class="text ob-text">${escapeHtml(m.text)}</div>
          ${reason}
        </div>`;
    })
    .join("");

  const findingsHtml =
    findings.length > 0
      ? `<div class="findings">${findings.map(renderFinding).join("")}</div>`
      : "";

  return `<div class="turn">
      <div class="turn-head">
        <span class="turn-no">第 ${index + 1} 轮</span>
        <span class="who">${escapeHtml(t.fromName)}${roleTag}</span>
        ${renderTools(t.toolsUsed)}
      </div>
      ${said}
      ${reply}
      ${outbound}
      ${findingsHtml}
    </div>`;
}

// ── 渲染：一个场景 ───────────────────────────────────────────────────────
function renderScenario(r: ScenarioResult): string {
  const judgeFail = r.judge ? !r.judge.pass : false;
  const ok = r.pass && !judgeFail;
  const findings = r.judge?.findings ?? [];
  const highCount = findings.filter((f) => f.severity === "high").length;

  // findings 按轮次归位；turnIndex 越界的不能丢，收到末尾单独列
  const byTurn = new Map<number, JudgeFinding[]>();
  const orphans: JudgeFinding[] = [];
  for (const f of findings) {
    if (f.turnIndex >= 0 && f.turnIndex < r.turns.length) {
      const arr = byTurn.get(f.turnIndex) ?? [];
      arr.push(f);
      byTurn.set(f.turnIndex, arr);
    } else {
      orphans.push(f);
    }
  }

  const badges = [
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "通过" : "有问题"}</span>`,
    r.pass
      ? ""
      : `<span class="badge bad-soft">结构性失败 ${r.failures.length}</span>`,
    judgeFail || findings.length > 0
      ? `<span class="badge ${highCount > 0 ? "bad-soft" : "warn-soft"}">语义问题 ${findings.length}${highCount > 0 ? `（严重 ${highCount}）` : ""}</span>`
      : "",
    `<span class="meta">${r.turns.length} 轮 · ${fmtMs(r.ms)}</span>`,
  ]
    .filter(Boolean)
    .join("");

  const failures =
    r.failures.length > 0
      ? `<div class="failures">
           <div class="failures-title">结构性断言失败</div>
           <ul>${r.failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
         </div>`
      : "";

  const source = r.source
    ? `<details class="source"><summary>场景来历</summary><div class="source-body">${escapeHtml(r.source)}</div></details>`
    : "";

  const orphanHtml =
    orphans.length > 0
      ? `<div class="orphans">
           <div class="failures-title">没能对应到具体轮次的问题</div>
           ${orphans.map(renderFinding).join("")}
         </div>`
      : "";

  const turns = r.turns
    .map((t, i) => renderTurn(t, i, byTurn.get(i) ?? []))
    .join("");

  // 失败的默认展开、通过的默认折叠——用户先看有问题的
  return `<details class="scenario${ok ? "" : " failing"}" id="s-${slug(r.id)}"${ok ? "" : " open"}>
      <summary><span class="sid">${escapeHtml(r.id)}</span>${badges}</summary>
      <div class="scenario-body">
        ${source}
        ${failures}
        <div class="chat">${turns}</div>
        ${orphanHtml}
      </div>
    </details>`;
}

// ── 渲染：整页 ───────────────────────────────────────────────────────────
function renderPage(results: ScenarioResult[], reportPath: string): string {
  const total = results.length;
  const structFail = results.filter((r) => !r.pass).length;
  const judgeFail = results.filter((r) => r.judge && !r.judge.pass).length;
  const allOk = results.filter((r) => r.pass && !(r.judge && !r.judge.pass)).length;
  const allFindings = results.flatMap((r) => r.judge?.findings ?? []);
  const high = allFindings.filter((f) => f.severity === "high").length;
  const judged = results.filter((r) => r.judge).length;

  // 有问题的排前面（原顺序内保持稳定）——这是"先看有问题的"的另一半，
  // 光靠默认展开还不够，通过的场景排在前面照样要往下滚
  const ordered = results
    .map((r, i) => ({ r, i, ok: r.pass && !(r.judge && !r.judge.pass) }))
    .sort((a, b) => Number(a.ok) - Number(b.ok) || a.i - b.i)
    .map((x) => x.r);

  const quickLinks = ordered.filter((r) => !(r.pass && !(r.judge && !r.judge.pass)));
  const quickLinksHtml =
    quickLinks.length > 0
      ? `<div class="quick">有问题的场景：${quickLinks
          .map((r) => `<a href="#s-${slug(r.id)}">${escapeHtml(r.id)}</a>`)
          .join("")}</div>`
      : "";

  const generated = new Date().toLocaleString("zh-CN", { hour12: false });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>合租房 AI 评测验收 · ${escapeHtml(path.basename(reportPath))}</title>
<style>
/* 颜色全部走变量：浅色写在 :root，深色只覆盖变量本身，
   body 显式设背景色（否则深色模式下会露出浏览器默认白底）。 */
:root {
  --bg: #f4f5f7;
  --panel: #ffffff;
  --panel-2: #fafafb;
  --text: #1b1c1f;
  --muted: #6a6c72;
  --border: #e2e3e7;
  --said-bg: #eceef2;
  --said-bd: #dcdee4;
  --reply-bg: #e6f0fb;
  --reply-bd: #c6dcf3;
  --ob-bg: #f4ecfb;
  --ob-bd: #d9c4ee;
  --ok: #1a7f45;
  --ok-bg: #e4f5eb;
  --bad: #bc2222;
  --bad-bg: #fdeaea;
  --warn: #8a6100;
  --warn-bg: #fdf3dd;
  --low: #55575c;
  --low-bg: #eeeef1;
  --accent: #2563b0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --panel: #1e1f23;
    --panel-2: #24252a;
    --text: #e8e8ea;
    --muted: #9b9da4;
    --border: #33353b;
    --said-bg: #2a2c31;
    --said-bd: #3a3c43;
    --reply-bg: #1c2f45;
    --reply-bd: #2c4667;
    --ob-bg: #2d2340;
    --ob-bd: #46345f;
    --ok: #6ed49a;
    --ok-bg: #16321f;
    --bad: #ff8a8a;
    --bad-bg: #3a1c1c;
    --warn: #f0c360;
    --warn-bg: #382d13;
    --low: #b3b5bb;
    --low-bg: #2b2c31;
    --accent: #79b0f0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  /* 中文可读性：优先系统中文字体，行高放到 1.75，正文 15px 起 */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC",
    sans-serif;
  font-size: 15px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 940px; margin: 0 auto; padding: 24px 16px 80px; }

/* ── 顶部汇总 ── */
header { margin-bottom: 18px; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .02em; }
.sub { color: var(--muted); font-size: 13px; word-break: break-all; }
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 10px; }
.stat {
  flex: 1 1 130px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px;
}
.stat .n { font-size: 22px; font-weight: 650; line-height: 1.3; }
.stat .l { font-size: 12px; color: var(--muted); }
.stat.ok .n { color: var(--ok); }
.stat.bad .n { color: var(--bad); }
.stat.warn .n { color: var(--warn); }
.quick { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.quick a {
  color: var(--bad); text-decoration: none; border-bottom: 1px dotted currentColor;
  margin: 0 8px 4px 0; display: inline-block;
}
.controls { margin: 10px 0 18px; display: flex; gap: 8px; }
.controls button {
  font: inherit; font-size: 13px; padding: 4px 12px; cursor: pointer;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 999px;
}
.controls button:hover { border-color: var(--accent); color: var(--accent); }

/* ── 场景 ── */
.scenario {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  margin-bottom: 12px; overflow: hidden;
}
.scenario.failing { border-color: var(--bad); }
.scenario > summary {
  cursor: pointer; padding: 12px 14px; display: flex; align-items: center;
  gap: 8px; flex-wrap: wrap; list-style: none;
}
.scenario > summary::-webkit-details-marker { display: none; }
.scenario > summary::before { content: "▸"; color: var(--muted); font-size: 12px; }
.scenario[open] > summary::before { content: "▾"; }
.scenario[open] > summary { border-bottom: 1px solid var(--border); }
.sid { font-weight: 600; margin-right: auto; word-break: break-all; }
.badge {
  font-size: 12px; padding: 1px 9px; border-radius: 999px; white-space: nowrap;
  font-weight: 600;
}
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.bad { background: var(--bad-bg); color: var(--bad); }
.badge.bad-soft { background: var(--bad-bg); color: var(--bad); font-weight: 500; }
.badge.warn-soft { background: var(--warn-bg); color: var(--warn); font-weight: 500; }
.meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
.scenario-body { padding: 14px; }

.source { margin-bottom: 12px; font-size: 13px; }
.source > summary { cursor: pointer; color: var(--muted); }
.source-body {
  margin-top: 6px; padding: 10px 12px; background: var(--panel-2);
  border-left: 3px solid var(--border); border-radius: 0 6px 6px 0;
  color: var(--muted); white-space: pre-wrap;
}

.failures, .orphans {
  background: var(--bad-bg); border: 1px solid var(--bad); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 14px;
}
.failures-title { font-weight: 600; color: var(--bad); font-size: 13px; }
.failures ul { margin: 4px 0 0; padding-left: 20px; }
.failures li { margin: 2px 0; }
.orphans { background: transparent; border-color: var(--border); margin-top: 14px; }

/* ── 对话 ── */
.turn { padding: 12px 0; border-top: 1px dashed var(--border); }
.turn:first-child { border-top: none; padding-top: 0; }
.turn-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--muted); margin-bottom: 8px;
}
.turn-no { font-variant-numeric: tabular-nums; }
.who { font-weight: 600; color: var(--text); font-size: 13px; }
.role {
  font-weight: 400; font-size: 11px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; margin-left: 5px;
}
.tools { margin-left: auto; display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.tool {
  font-size: 11px; line-height: 1.6; padding: 0 6px; border-radius: 4px;
  background: var(--low-bg); color: var(--low);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.tool i { font-style: normal; opacity: .7; margin-left: 2px; }

.row { display: flex; margin: 6px 0; }
.row.left { justify-content: flex-start; }
.row.right { justify-content: flex-end; }
.bubble {
  max-width: 78%; padding: 8px 12px; border-radius: 12px; border: 1px solid;
}
.bubble .text { white-space: pre-wrap; word-break: break-word; }
.bubble-tag { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.said { background: var(--said-bg); border-color: var(--said-bd); border-top-left-radius: 3px; }
.reply { background: var(--reply-bg); border-color: var(--reply-bd); border-top-right-radius: 3px; }
.reply.empty { color: var(--muted); font-size: 13px; }

/* outbound：虚线 + 另一种底色，跟 reply 一眼分得开 */
.ob {
  margin: 8px 0 8px auto; max-width: 88%;
  background: var(--ob-bg); border: 1px dashed var(--ob-bd);
  border-radius: 10px; padding: 8px 12px;
}
.ob-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; margin-bottom: 3px;
}
.ob-kind { font-weight: 600; color: var(--accent); }
.ob-to { color: var(--muted); }
.ob-text { white-space: pre-wrap; word-break: break-word; }
.ob.blocked { background: var(--bad-bg); border: 1px solid var(--bad); }
.ob.blocked .ob-kind { color: var(--bad); }
.ob.blocked .ob-text { text-decoration: line-through; opacity: .68; }
.badge-blocked {
  background: var(--bad); color: var(--panel); font-size: 11px; font-weight: 600;
  padding: 0 8px; border-radius: 999px; margin-left: auto;
}
.ob-reason {
  margin-top: 5px; font-size: 12px; color: var(--bad);
  border-top: 1px dotted var(--bad); padding-top: 4px;
}

/* ── judge findings ── */
.findings { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.finding { border-left: 3px solid; border-radius: 0 8px 8px 0; padding: 6px 12px; font-size: 13px; }
.finding .sev {
  font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 4px;
  margin-right: 6px; vertical-align: 1px;
}
.finding-head { font-weight: 500; }
.quote {
  margin: 4px 0 0; padding: 4px 10px; font-size: 12.5px; color: var(--muted);
  border-left: 2px solid var(--border); white-space: pre-wrap; word-break: break-word;
}
.sev-high { border-color: var(--bad); background: var(--bad-bg); }
.sev-high .sev { background: var(--bad); color: var(--panel); }
.sev-high .finding-head { color: var(--bad); font-weight: 600; }
.sev-medium { border-color: var(--warn); background: var(--warn-bg); }
.sev-medium .sev { background: var(--warn); color: var(--panel); }
.sev-low { border-color: var(--border); background: var(--low-bg); }
.sev-low .sev { background: var(--low); color: var(--panel); }
.sev-low, .sev-low .finding-head { color: var(--low); }

@media (max-width: 640px) {
  .bubble { max-width: 92%; }
  .ob { max-width: 100%; }
  .tools { margin-left: 0; justify-content: flex-start; width: 100%; }
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>合租房 AI 评测验收</h1>
  <div class="sub">报告：${escapeHtml(reportPath)}<br>生成时间：${escapeHtml(generated)}</div>
  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="l">场景总数</div></div>
    <div class="stat ok"><div class="n">${allOk}</div><div class="l">全部通过</div></div>
    <div class="stat bad"><div class="n">${structFail}</div><div class="l">结构性失败</div></div>
    <div class="stat bad"><div class="n">${judgeFail}</div><div class="l">语义失败${judged < total ? `（${judged}/${total} 有验收）` : ""}</div></div>
    <div class="stat warn"><div class="n">${high}</div><div class="l">严重问题条数</div></div>
  </div>
  ${quickLinksHtml}
  <div class="controls">
    <button type="button" data-all="open">全部展开</button>
    <button type="button" data-all="close">全部折叠</button>
  </div>
</header>
${ordered.map(renderScenario).join("\n")}
</div>
<script>
// 只做展开/折叠，没有别的交互——页面是拿来读的，不是拿来玩的
document.querySelectorAll(".controls button").forEach(function (b) {
  b.addEventListener("click", function () {
    var open = b.dataset.all === "open";
    document.querySelectorAll("details.scenario").forEach(function (d) {
      d.open = open;
    });
  });
});
</script>
</body>
</html>`;
}

// ── main ─────────────────────────────────────────────────────────────────
function main() {
  const reportPath = path.resolve(REPORT_ARG ?? findLatestReport());
  const results = loadReport(reportPath);
  if (results.length === 0) {
    fail(`报告 ${reportPath} 里一个场景都没有，没什么可渲染的。`);
  }
  const outPath = path.resolve(
    OUT_ARG ??
      path.join(path.dirname(reportPath), `${path.basename(reportPath, ".json")}.html`)
  );
  writeFileSync(outPath, renderPage(results, reportPath), "utf8");

  const bad = results.filter((r) => !r.pass || (r.judge && !r.judge.pass)).length;
  console.log(
    `渲染了 ${results.length} 个场景（${bad} 个有问题），来源：${reportPath}`
  );
  console.log(`页面已写入 ${outPath}`);
}

try {
  main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
