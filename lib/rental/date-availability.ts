/**
 * Canonical move-in / availability date engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * Listing `availableFrom` and wanted-post `moveInDate` are stored as FREE TEXT
 * ("7/1", "ASAP", "随时入住", "8月初", "2025-07-01"). Historically the search
 * path either ignored these fields entirely or compared them as raw strings —
 * which is lexicographic, not chronological ("7/1" > "10/1" as text, but July
 * comes before October as dates). That let listings whose unit only becomes
 * available AFTER the tenant's desired move-in slip into results.
 *
 * The business invariant is simple and one-directional:
 *
 *     a tenant can only move in ON or AFTER the unit is available
 *     (move-in date  >=  available-from date)
 *
 * This module is the SINGLE SOURCE OF TRUTH for turning those free-text values
 * into a comparable form and for deciding feasibility. Every search entry point
 * — in-app tools AND GPT Action routes — must go through it. Never compare
 * these fields as raw strings again.
 */

export type FlexibleDate =
  | { kind: "asap" } // 随时 / ASAP / now — available immediately
  | { kind: "date"; iso: string } // concrete calendar day, ISO "YYYY-MM-DD"
  | { kind: "unknown" }; // absent or unparseable

export type FeasibilityVerdict = "ok" | "infeasible" | "unknown";

// "Available immediately" expressions on either side.
const ASAP_RE =
  /(随时(?:入住|可入住)?|即可入住|即刻入住|立即入住|马上入住|尽快入住|现在可入住|\bnow\b|a\.?s\.?a\.?p\.?|immediate(?:ly)?|ready\s*to\s*move|move[\s-]?in\s*ready)/i;

// Context words signalling that the surrounding text is about a move-in /
// availability date — not a budget, bedroom count, or phone number. A query
// with no such context imposes NO date constraint (zero behaviour change).
const MOVE_IN_CONTEXT_RE =
  /(入住|起租|搬入|可入住|入住时间|起租时间|放租|空出|什么时候|哪天|move[\s-]?in|available|avail\b)/i;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Format a Date as local ISO "YYYY-MM-DD". */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayIso(ref: Date = new Date()): string {
  return toIso(ref);
}

/**
 * Choose the calendar year for a month/day written without one. Rental move-in
 * dates point at the near future, so pick the current year unless that lands
 * more than ~6 months in the past, in which case roll forward to next year.
 * `ref` keeps the choice deterministic and testable.
 */
function inferIso(month: number, day: number, ref: Date): string {
  const refYear = ref.getFullYear();
  const thisYear = new Date(refYear, month - 1, day);
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;
  const year =
    thisYear.getTime() < ref.getTime() - sixMonthsMs ? refYear + 1 : refYear;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse a single free-text date/expression into a comparable FlexibleDate.
 * Scans for the first recognizable date; returns {kind:"unknown"} if none.
 * ISO output means feasibility can compare with plain string `<=` safely.
 */
export function parseFlexibleDate(
  input: string | null | undefined,
  ref: Date = new Date()
): FlexibleDate {
  if (!input) return { kind: "unknown" };
  const text = input.trim();
  if (text.length === 0) return { kind: "unknown" };

  if (ASAP_RE.test(text)) return { kind: "asap" };

  // 1) ISO / numeric with 4-digit year first: YYYY-M-D, YYYY/M/D, YYYY.M.D
  let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: `${m[1]}-${pad2(month)}-${pad2(day)}` };
    }
  }

  // 2) Chinese with year: YYYY年M月[D日/号]
  m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?/);
  if (m) {
    const month = Number(m[2]);
    const day = m[3] ? Number(m[3]) : 1;
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: `${m[1]}-${pad2(month)}-${pad2(day)}` };
    }
  }

  // 3) Chinese M月D日 / M月D号
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: inferIso(month, day, ref) };
    }
  }

  // 4) Chinese M月[初/中/中旬/底/末]
  m = text.match(/(\d{1,2})\s*月\s*(初|中旬|中|底|末)/);
  if (m) {
    const month = Number(m[1]);
    const bucket = m[2];
    const day = bucket === "初" ? 5 : bucket === "底" || bucket === "末" ? 28 : 15;
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: inferIso(month, day, ref) };
    }
  }

  // 5) Chinese bare M月 (no day)
  m = text.match(/(\d{1,2})\s*月(?!\s*\d)/);
  if (m) {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) {
      return { kind: "date", iso: inferIso(month, 1, ref) };
    }
  }

  // 6) Numeric M/D/YYYY or M/D/YY (US month-first)
  //
  // 尾部的 `(?![\d/.\-])` 是**区间保护**，不是可有可无的收尾：租房帖里日期区间
  // 到处都是（"入住时间10/13-11/14"、"8/15-10/15"）。只写 `(?!\d)` 的话，
  // "10/13-11/14" 会被读成 M/D/YY —— 把区间末端的 `-11` 当成年份 →
  // **2011-10-13**，一个十五年前的日期，然后静默参与筛选。
  // 加上这条后它匹配失败，落到下面模式 7 拿到区间的**起点** 10/13，才是对的。
  // 开头的 `(?<![\d/.\-])` 同理，缺了它照样出事：只写 `(?<!\d)` 时，
  // "9/1-12/31" 里的 `1-12/31` 会**从区间中间起匹**（`1` 前面是 `/`，不是数字，
  // 放行）→ 1月12日2031年。两端都要挡住，日期才不会从区间腰上切一刀。
  m = text.match(
    /(?<![\d/.\-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?![\d/.\-])/
  );
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: `${year}-${pad2(month)}-${pad2(day)}` };
    }
  }

  // 7) Numeric M/D (no year) — infer the year
  m = text.match(/(?<!\d)(\d{1,2})[/.-](\d{1,2})(?![/.\d])/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (isValidMonthDay(month, day)) {
      return { kind: "date", iso: inferIso(month, day, ref) };
    }
  }

  return { kind: "unknown" };
}

/**
 * Extract the move-in / availability date expressed in a free-text query.
 * Returns {kind:"unknown"} unless the query actually voices move-in intent, so
 * a query with no date imposes no constraint at all.
 */
export function extractQueryDate(
  query: string,
  ref: Date = new Date()
): FlexibleDate {
  if (!query) return { kind: "unknown" };
  if (!MOVE_IN_CONTEXT_RE.test(query) && !ASAP_RE.test(query)) {
    return { kind: "unknown" };
  }
  return parseFlexibleDate(query, ref);
}

/**
 * Enforce the core invariant  move-in >= available-from.
 *
 * @param availableFrom when the unit is available (the listing side)
 * @param moveIn        when the person wants to move in (the tenant side)
 *
 * Returns "infeasible" only when we are confident the move-in is strictly
 * BEFORE availability. Returns "unknown" (lenient — caller should keep the row)
 * whenever either side can't be parsed, so we never over-filter free text we
 * failed to understand.
 */
export function checkMoveInFeasibility(
  availableFrom: FlexibleDate,
  moveIn: FlexibleDate,
  ref: Date = new Date()
): FeasibilityVerdict {
  if (availableFrom.kind === "unknown" || moveIn.kind === "unknown") {
    return "unknown";
  }
  // Unit is available immediately → any move-in date works.
  if (availableFrom.kind === "asap") return "ok";
  // Mover wants it immediately → feasible only if it is available by today.
  if (moveIn.kind === "asap") {
    return availableFrom.iso <= todayIso(ref) ? "ok" : "infeasible";
  }
  return moveIn.iso >= availableFrom.iso ? "ok" : "infeasible";
}
