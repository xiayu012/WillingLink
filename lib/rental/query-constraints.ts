/**
 * Hard-constraint layer for rental search.
 *
 * WHY THIS EXISTS
 * ---------------
 * Semantic (vector) search answers "is this listing ABOUT what they asked?".
 * It says nothing about whether a listing actually SATISFIES the user's hard
 * requirements — budget ceiling, bedroom count, move-in feasibility. Those are
 * arithmetic/logical invariants, not vibes, and an embedding cannot enforce
 * them. The in-app `searchRental` historically leaned entirely on the ranker
 * and enforced none of these, so "预算2500以下" could return a $4000 unit and
 * "两室" could return a studio.
 *
 * This module is the deterministic filter that runs BEFORE ranking: it pulls
 * hard constraints out of the free-text query and drops rows that provably
 * violate them. It is intentionally LENIENT — a row whose structured field is
 * null (couldn't be parsed at ingest) is kept, never dropped, so we cut only
 * confident violations and let the ranker order the rest.
 *
 * The GPT Actions route receives these constraints as typed params and already
 * filters on them; this brings the in-app tool to parity by recovering the same
 * constraints from natural language.
 */

import {
  type FlexibleDate,
  checkMoveInFeasibility,
  extractQueryDate,
  parseFlexibleDate,
} from "./date-availability";

export type HardConstraints = {
  rentMin: number | null;
  rentMax: number | null;
  bedroomsNum: number | null;
  moveIn: FlexibleDate;
};

/** A listing row exposes at least these structured fields (all nullable). */
export type ConstrainableRow = {
  rentNumeric: number | null;
  bedroomsNum: number | null;
  availableFrom: string | null;
};

const CN_NUMERALS: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
};

const PLAUSIBLE_RENT_MIN = 300;
const PLAUSIBLE_RENT_MAX = 15000;

/** Parse a money-ish token ("2500", "2,500", "2k", "2.5k", "$2500") to a number. */
function parseMoney(raw: string): number | null {
  const kMatch = raw.match(/(\d+(?:\.\d+)?)\s*k/i);
  let n: number;
  if (kMatch) {
    n = Math.round(Number.parseFloat(kMatch[1]) * 1000);
  } else {
    const digits = raw.replace(/[,，$\s]/g, "").match(/\d{3,5}/);
    if (!digits) return null;
    n = Number(digits[0]);
  }
  if (!Number.isFinite(n) || n < PLAUSIBLE_RENT_MIN || n > PLAUSIBLE_RENT_MAX) {
    return null;
  }
  return n;
}

/**
 * Extract a budget from the query. Budgets are 3–5 digit amounts (or "Nk"),
 * which naturally never collide with bedroom counts (1 digit) or dates. A bare
 * number is ignored unless a budget cue word is present, so we never guess.
 */
export function extractBudget(query: string): {
  rentMin: number | null;
  rentMax: number | null;
} {
  // Range: "2000-2500" / "2000到2500" / "2000~2500" / "$2000-$2500"
  const range = query.match(
    /(\$?\s*\d[\d,]{2,4}\s*k?)\s*(?:-|~|—|到|至)\s*(\$?\s*\d[\d,]{2,4}\s*k?)/i
  );
  if (range) {
    const a = parseMoney(range[1]);
    const b = parseMoney(range[2]);
    if (a != null && b != null) {
      return { rentMin: Math.min(a, b), rentMax: Math.max(a, b) };
    }
  }

  const budgetCue =
    /(预算|budget|以下|以内|不超过|最多|最高|max\b|under|below|租金|房租|块|刀|美元|\/\s*月|per\s*month)/i;
  if (budgetCue.test(query)) {
    const tokens = query.match(/\$?\s*\d[\d,]{2,4}\s*k?/gi) ?? [];
    for (const token of tokens) {
      const value = parseMoney(token);
      if (value != null) return { rentMin: null, rentMax: value };
    }
  }

  return { rentMin: null, rentMax: null };
}

/** Extract a requested bedroom count (studio = 0). Returns null if unstated. */
export function extractBedrooms(query: string): number | null {
  const clamp = (n: number): number | null => (n >= 0 && n <= 5 ? n : null);

  // "2b2b" / "2B1B" shorthand → first number is bedrooms (avoids matching bath)
  let m = query.match(/(\d)\s*b\s*\d\s*b/i);
  if (m) return clamp(Number(m[1]));

  // "2 bedroom" / "2bed" / "2br"
  m = query.match(/(\d)\s*(?:bed(?:room)?s?|br)\b/i);
  if (m) return clamp(Number(m[1]));

  // Chinese digit + 室/房/居/卧 (厅 deliberately excluded)
  m = query.match(/(\d)\s*(?:室|房|居|卧)/);
  if (m) return clamp(Number(m[1]));

  // Chinese numeral + 室/房/居/卧
  m = query.match(/([一两二三四五])\s*(?:室|房|居|卧)/);
  if (m) return clamp(CN_NUMERALS[m[1]] ?? Number.NaN);

  // Studio
  if (/\bstudio\b|单间|开间/i.test(query)) return 0;

  return null;
}

/** Recover all hard constraints from a free-text query. */
export function extractHardConstraints(
  query: string,
  ref: Date = new Date()
): HardConstraints {
  const { rentMin, rentMax } = extractBudget(query);
  return {
    rentMin,
    rentMax,
    bedroomsNum: extractBedrooms(query),
    moveIn: extractQueryDate(query, ref),
  };
}

export function hasAnyConstraint(c: HardConstraints): boolean {
  return (
    c.rentMin != null ||
    c.rentMax != null ||
    c.bedroomsNum != null ||
    c.moveIn.kind !== "unknown"
  );
}

/**
 * Does a row provably violate a hard constraint? Lenient: an unparsed
 * (null) structured field is never treated as a violation.
 */
export function rowViolates(
  row: ConstrainableRow,
  c: HardConstraints,
  ref: Date = new Date()
): boolean {
  if (c.rentMax != null && row.rentNumeric != null && row.rentNumeric > c.rentMax) {
    return true;
  }
  if (c.rentMin != null && row.rentNumeric != null && row.rentNumeric < c.rentMin) {
    return true;
  }
  if (
    c.bedroomsNum != null &&
    row.bedroomsNum != null &&
    row.bedroomsNum !== c.bedroomsNum
  ) {
    return true;
  }
  if (
    c.moveIn.kind !== "unknown" &&
    checkMoveInFeasibility(parseFlexibleDate(row.availableFrom), c.moveIn, ref) ===
      "infeasible"
  ) {
    return true;
  }
  return false;
}

/** Drop rows that provably violate the hard constraints. */
export function applyHardConstraints<T extends ConstrainableRow>(
  rows: T[],
  c: HardConstraints,
  ref: Date = new Date()
): T[] {
  if (!hasAnyConstraint(c)) return rows;
  return rows.filter((row) => !rowViolates(row, c, ref));
}
