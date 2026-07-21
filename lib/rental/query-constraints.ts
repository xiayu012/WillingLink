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
import { neighborsOf } from "./cities";

export type HardConstraints = {
  rentMin: number | null;
  rentMax: number | null;
  bedroomsNum: number | null;
  moveIn: FlexibleDate;
  petFriendly: boolean | null;
  couplesOk: boolean | null;
  utilitiesIncluded: boolean | null;
  parkingIncluded: boolean | null;
  furnished: string | null;
  /** Requested city (English or Chinese). Soft + neighbour-aware, never strict. */
  city: string | null;
  /** Neighbouring cities that also satisfy `city`. Empty when city is unset. */
  cityNeighbors: string[];
};

/** A listing row exposes at least these structured fields (all nullable). */
export type ConstrainableRow = {
  rentNumeric: number | null;
  bedroomsNum: number | null;
  availableFrom: string | null;
  petFriendly: boolean | null;
  couplesOk: boolean | null;
  utilitiesIncluded: boolean | null;
  parkingIncluded: boolean | null;
  furnished: string | null;
  city: string | null;
};

const EMPTY_MOVE_IN: FlexibleDate = { kind: "unknown" };

/** A constraint set with nothing set — the "no filter" identity. */
export function emptyConstraints(): HardConstraints {
  return {
    rentMin: null,
    rentMax: null,
    bedroomsNum: null,
    moveIn: EMPTY_MOVE_IN,
    petFriendly: null,
    couplesOk: null,
    utilitiesIncluded: null,
    parkingIncluded: null,
    furnished: null,
    city: null,
    cityNeighbors: [],
  };
}

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

/**
 * Recover hard constraints from a free-text query (in-app tenant search).
 * Populates the constraints a natural-language request reliably carries —
 * budget, bedrooms, move-in date. Boolean prefs / city stay unset here: the
 * in-app cascade already biases those via keyword phases + geo-expansion.
 */
export function extractHardConstraints(
  query: string,
  ref: Date = new Date()
): HardConstraints {
  const { rentMin, rentMax } = extractBudget(query);
  return {
    ...emptyConstraints(),
    rentMin,
    rentMax,
    bedroomsNum: extractBedrooms(query),
    moveIn: extractQueryDate(query, ref),
  };
}

/**
 * Build the same canonical constraints from the GPT route's typed params,
 * merged with anything the natural-language query also expresses (so the GPT
 * path gains NL budget/date parsing too). Typed params win when both are set.
 */
export function constraintsFromParams(
  params: {
    city?: string | null;
    rentMin?: number | null;
    rentMax?: number | null;
    bedroomsNum?: number | null;
    petFriendly?: boolean | null;
    couplesOk?: boolean | null;
    utilitiesIncluded?: boolean | null;
    parkingIncluded?: boolean | null;
    furnished?: string | null;
  },
  query: string,
  ref: Date = new Date()
): HardConstraints {
  const nl = extractHardConstraints(query, ref);
  const city = params.city ?? null;
  return {
    rentMin: params.rentMin ?? nl.rentMin,
    rentMax: params.rentMax ?? nl.rentMax,
    bedroomsNum: params.bedroomsNum ?? nl.bedroomsNum,
    moveIn: nl.moveIn,
    petFriendly: params.petFriendly ?? null,
    couplesOk: params.couplesOk ?? null,
    utilitiesIncluded: params.utilitiesIncluded ?? null,
    parkingIncluded: params.parkingIncluded ?? null,
    furnished: params.furnished ?? null,
    city,
    cityNeighbors: city ? neighborsOf(city) : [],
  };
}

export function hasAnyConstraint(c: HardConstraints): boolean {
  return (
    c.rentMin != null ||
    c.rentMax != null ||
    c.bedroomsNum != null ||
    c.moveIn.kind !== "unknown" ||
    c.petFriendly != null ||
    c.couplesOk != null ||
    c.utilitiesIncluded != null ||
    c.parkingIncluded != null ||
    c.furnished != null ||
    c.city != null
  );
}

/**
 * Does a row provably violate a hard constraint?
 *
 * Numeric / date fields are LENIENT: an unparsed (null) rent, bedroom count, or
 * available-date is never treated as a violation — we only cut confident
 * mismatches. Boolean requirements (pet / couples / utilities / parking) and
 * furnished are STRICT on null: if the tenant requires pets allowed, a listing
 * that never states its pet policy isn't a confirmed match and is excluded.
 * City is SOFT + neighbour-aware: the requested city, any neighbour, or an
 * unknown city all pass — only a different, known region is cut.
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
  if (c.petFriendly === true && row.petFriendly !== true) return true;
  if (c.petFriendly === false && row.petFriendly === true) return true;
  if (c.couplesOk === true && row.couplesOk !== true) return true;
  if (c.utilitiesIncluded === true && row.utilitiesIncluded !== true) return true;
  if (c.parkingIncluded === true && row.parkingIncluded !== true) return true;
  if (
    c.furnished != null &&
    row.furnished != null &&
    row.furnished.toLowerCase() !== c.furnished.toLowerCase()
  ) {
    return true;
  }
  if (c.city != null && row.city != null) {
    const wanted = [c.city, ...c.cityNeighbors].map((n) => n.toLowerCase());
    if (!wanted.includes(row.city.toLowerCase())) return true;
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

/** Drop rows whose searchable text contains any block term (hard exclusion). */
export function applyBlockTerms<
  T extends {
    title: string | null;
    rawText: string;
    locationText: string | null;
    propertyName: string | null;
  },
>(rows: T[], blockTerms: string[]): T[] {
  const terms = blockTerms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = [row.title, row.rawText, row.locationText, row.propertyName]
      .filter((v): v is string => typeof v === "string")
      .join("\n")
      .toLowerCase();
    return !terms.some((term) => haystack.includes(term));
  });
}

export type RelaxationLevel = {
  constraints: HardConstraints;
  /** User-facing explanation, or null for the strict (level 0) pass. */
  note: string | null;
};

/**
 * The shared, ordered relaxation ladder both search paths widen through when a
 * strict match is empty. Drops soft life-style prefs first, then loosens budget,
 * then region + move-in — always keeping bedrooms and hard pet policy longest.
 */
export function relaxationLevels(c: HardConstraints): RelaxationLevel[] {
  const dropSoftPrefs: HardConstraints = {
    ...c,
    furnished: null,
    utilitiesIncluded: null,
    parkingIncluded: null,
    couplesOk: null,
  };
  const widerBudget: HardConstraints = {
    ...dropSoftPrefs,
    rentMax: c.rentMax != null ? Math.ceil(c.rentMax * 1.15) : null,
  };
  const widestRegion: HardConstraints = {
    ...widerBudget,
    city: null,
    cityNeighbors: [],
    moveIn: EMPTY_MOVE_IN,
  };

  return [
    { constraints: c, note: null },
    {
      constraints: dropSoftPrefs,
      note: "没有完全匹配的房源；已先放宽家具、水电、停车、情侣入住等生活偏好，保留核心地点/预算/卧室要求。",
    },
    {
      constraints: widerBudget,
      note: "没有完全匹配的房源；预算上限放宽约 15%，同时保留其他核心要求。",
    },
    {
      constraints: widestRegion,
      note: "没有完全匹配的房源；已放宽到附近区域/全湾区，并放宽入住时间要求，但尽量保留预算和房型。",
    },
  ];
}
