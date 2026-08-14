/**
 * searchRental tool — semantic + keyword search over XhsRentalListing.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Search cascade (stops at first hit; excludeIds always respected)        │
 * │                                                                         │
 * │  P1  Vector search (geo-expanded query)                                 │
 * │        1a. strict: vector candidates + blockFilter  → SHOW_LISTING      │
 * │        1b. relaxed: same candidates, drop blockFilter → SHOW_RELAXED    │
 * │                                                                         │
 * │  P2  City keyword search (only when a city is detected in the query)    │
 * │        2a. strict: city matches + blockFilter       → SHOW_LISTING      │
 * │        2b. relaxed: city matches, drop blockFilter  → SHOW_RELAXED      │
 * │                                                                         │
 * │  P3  Non-city keyword fulltext search                                   │
 * │        3a. strict: keyword matches + blockFilter    → SHOW_LISTING      │
 * │        3b. relaxed: keyword matches, drop blockFilter → SHOW_RELAXED    │
 * │                                                                         │
 * │  P4  Last resort — 50 most recent listings reranked by query            │
 * │        always → SHOW_RELAXED                                            │
 * │                                                                         │
 * │  null → truly exhausted                                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Design notes:
 * - Geo-expansion is deterministic (lookup table, ≤3 neighbors appended).
 *   No LLM call needed; keeps query vectors distinct across cities.
 * - City search (P2) and non-city keyword search (P3) use separate keyword
 *   sets so they never overlap.
 * - pickBest reranks top-3 candidates and picks with weighted randomness
 *   (rank-1 = 3× weight) to balance relevance and variety across "换一个".
 * - excludeIds is server-managed (Redis/in-memory); the LLM never sees them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT MODE (current default — the cascade above is LEGACY, kept for
 * rollback via SEARCH_LEGACY_PICK_ONE=1):
 *
 * The legacy flow returns ONE listing at a time and auto-relaxes until
 * something is shown, which trains users into endless "换一个" loops over
 * loosely-matching results. Strict mode replaces that contract:
 *
 *   - Filter the WHOLE pool strictly by every requirement the user voiced
 *     (city exact, budget, bedrooms, move-in, pet/couple/utilities/parking).
 *   - Return the top ≤5 matches at once (reranked when Voyage is available,
 *     else most recent first).
 *   - If nothing satisfies everything → return an empty list and say so.
 *     No relaxation, no substitution, no rotation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { tool } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import {
  logSearchQuery,
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";
import { getSeenListingIds, markListingAsSeen } from "@/lib/db/seen-listings";
import {
  type CityEntry,
  cityAliases,
  detectCity,
  detectCityStrict,
  isOutOfBayQuery,
} from "@/lib/rental/cities";
import {
  applyBlockTerms,
  applyHardConstraints,
  extractBooleanPrefs,
  extractHardConstraints,
  hasAnyConstraint,
  rowViolates,
} from "@/lib/rental/query-constraints";

// ── Constants ─────────────────────────────────────────────────────────────────

const VECTOR_CANDIDATES = 50; // pgvector top-N before rerank
const LAST_RESORT_LIMIT = 50; // wider pool for Phase 4 last-resort rerank

// ── after() shim ──────────────────────────────────────────────────────────────
// after() keeps serverless alive until the log write lands, but it THROWS when
// called outside a Next.js request scope (eval scripts, unit tests). Fall back
// to a direct fire-and-forget there — in a long-lived script nothing recycles
// the process before the insert finishes.

function scheduleAfterResponse(cb: () => Promise<unknown>): void {
  try {
    after(cb);
  } catch {
    cb().catch(() => {
      // logging is fail-open by design
    });
  }
}

// ── Geo-expansion (deterministic, no LLM) ────────────────────────────────────
// Normalizes the city mention to its bilingual canonical form ("San Jose
// 圣何塞" — mirroring the 城市: line in composeListingEmbeddingDoc) and
// appends ≤3 neighbors. Keeps query vectors meaningfully distinct across
// cities while still matching listings that only mention a neighboring city.

function lightGeoExpand(query: string, city: CityEntry): string {
  const withCanonical = query.replace(city.re, `${city.en} ${city.zh}`);
  const neighborStr = city.neighbors.join(" ");
  return `${withCanonical} ${neighborStr}`;
}

// ── Non-city keyword extraction ───────────────────────────────────────────────
// Extracts room-type / amenity keywords from the query.
// City name is intentionally excluded — Phase 2 handles the city specifically.

const RENTAL_KEYWORDS: string[] = [
  "主卧",
  "次卧",
  "客卧",
  "studio",
  "整租",
  "合租",
  "转租",
  "sublease",
  "宠物",
  "pet",
  "情侣",
  "couples",
  "水电",
  "utilities",
  "停车",
  "parking",
  "家具",
  "furnished",
];

function extractNonCityKeywords(query: string): string[] {
  const found: string[] = [];

  for (const kw of RENTAL_KEYWORDS) {
    if (query.toLowerCase().includes(kw.toLowerCase())) {
      found.push(kw);
    }
  }

  // bedroom count pattern: "2室", "2BR", "两室" (numeric only, not Chinese numerals)
  const bedroomMatch = query.match(/(\d)\s*(?:br|bed|室|卧|房)/i);
  if (bedroomMatch) found.push(bedroomMatch[0]);

  return [...new Set(found)];
}

// ── Vector search ─────────────────────────────────────────────────────────────

async function vectorSearch(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  if (!process.env.VOYAGE_API_KEY) return [];
  try {
    const vec = await embedText(query, "query");
    return await vectorSearchXhsRentalListings(
      vec,
      VECTOR_CANDIDATES,
      excludeIds
    );
  } catch (err) {
    console.error("[searchRental] vectorSearch failed:", err);
    return [];
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function applyBlockFilter(
  rows: XhsRentalSearchResultRow[],
  blockTerms: string[]
): XhsRentalSearchResultRow[] {
  if (blockTerms.length === 0) return rows;
  return rows.filter(
    (r) => !blockTerms.some((term) => r.rawText.toLowerCase().includes(term))
  );
}

function filterExcluded(
  rows: XhsRentalSearchResultRow[],
  excludeIds: string[]
): XhsRentalSearchResultRow[] {
  if (excludeIds.length === 0) return rows;
  return rows.filter((r) => !excludeIds.includes(r.id));
}

// ── City-region preference ─────────────────────────────────────────────────
// Vector similarity is dominated by room-type / amenity wording, so a "旧金山
// 2B2B" query can rank a Santa Clara 2B2B above every San Francisco listing.
// When the query names a city, PREFER candidates that actually sit in that
// city's region (city + neighbours, matched across EN/ZH aliases and the stored
// `city` column). Soft, not strict: if NONE of the semantic candidates are in
// region, keep them all rather than dead-end — a later cascade phase or the
// ranker still gets a shot.

function rowInCityRegion(
  row: XhsRentalSearchResultRow,
  city: CityEntry
): boolean {
  const region = [city.en, ...city.neighbors].map((s) => s.toLowerCase());

  // 1. Trust the LLM-normalized `city` column when present — it is the single
  //    canonical city and covers non-table neighbours (e.g. "San Leandro").
  //    A column naming a different real city is authoritative → out of region.
  const col = row.city?.trim().toLowerCase();
  if (col && col !== "null" && col.length > 0) {
    return region.includes(col);
  }

  // 2. No column → detect from text with region-wide "湾区/Bay Area" phrases
  //    neutralized, so "旧金山湾区…东湾Hayward" is read as Hayward, not SF.
  const rc = detectCityStrict(
    `${row.title ?? ""} ${row.locationText ?? ""} ${row.propertyName ?? ""} ${row.rawText}`
  );
  return rc ? region.includes(rc.en.toLowerCase()) : false;
}

function preferCityRegion(
  rows: XhsRentalSearchResultRow[],
  city: CityEntry | null
): XhsRentalSearchResultRow[] {
  if (!city) return rows;
  const inRegion = rows.filter((r) => rowInCityRegion(r, city));
  return inRegion.length > 0 ? inRegion : rows;
}

// ── Pick best with variety ────────────────────────────────────────────────────
// Reranks top-3 candidates via Voyage, then selects using weighted randomness
// so users get different listings on each "换一个" even for the same query.
// Weight: rank-1 = 3×, rank-2 = 2×, rank-3 = 1×.
//
// SEARCH_DETERMINISTIC=1 disables the randomness (always rank-1) so eval runs
// are reproducible. Never set in production.

function isDeterministic(): boolean {
  return process.env.SEARCH_DETERMINISTIC === "1";
}

async function pickBest(
  query: string,
  candidates: XhsRentalSearchResultRow[]
): Promise<XhsRentalSearchResultRow> {
  if (candidates.length === 1) return candidates[0];

  if (process.env.VOYAGE_API_KEY) {
    try {
      const topK = Math.min(3, candidates.length);
      const topIndices = await rerankDocuments(
        query,
        candidates.map((c) => c.rawText),
        topK
      );

      if (topIndices.length > 0) {
        if (isDeterministic()) {
          return candidates[topIndices[0]] ?? candidates[0];
        }
        const weights = topIndices.map((_, i) => topK - i); // [3, 2, 1]
        const total = weights.reduce((a, b) => a + b, 0);
        let rnd = Math.random() * total;
        for (let i = 0; i < topIndices.length; i++) {
          rnd -= weights[i];
          if (rnd <= 0) return candidates[topIndices[i]] ?? candidates[0];
        }
        return candidates[topIndices[0]] ?? candidates[0];
      }
    } catch {
      // reranker failure → fall through
    }
  }

  // No reranker: random pick from first 3 (rank-1 when deterministic)
  if (isDeterministic()) return candidates[0];
  const pool = candidates.slice(0, Math.min(3, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Main search cascade ───────────────────────────────────────────────────────

type CascadeResult = {
  listing: XhsRentalSearchResultRow;
  relaxedNote: string | null;
  /** Which cascade phase produced the result (for logging/eval). */
  phase: string;
} | null;

async function findNextListing(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<CascadeResult> {
  const city = detectCity(query);
  const expandedQuery = city ? lightGeoExpand(query, city) : query;

  // Hard constraints (budget ceiling, bedroom count, move-in feasibility) are
  // deterministic invariants a vector ranker cannot enforce. Recover them from
  // the query and drop rows that PROVABLY violate them before ranking. Lenient
  // by design: rows with an unparsed structured field are kept, and the whole
  // step is a no-op when the query states no constraint.
  const constraints = extractHardConstraints(query);
  const constrained = (
    rows: XhsRentalSearchResultRow[]
  ): XhsRentalSearchResultRow[] => applyHardConstraints(rows, constraints);

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1 — Vector search (semantic, best quality)
  // Uses geo-expanded query so neighbor-city listings are reachable.
  // ═══════════════════════════════════════════════════════════════════════════

  // When the query names a city, restrict Phase 1 to semantic candidates that
  // sit in that city's region. If NONE are in region, leave Phase 1 empty and
  // fall through to the city-keyword phase (P2), which scans the whole table —
  // returning an out-of-region listing here would short-circuit before P2 runs
  // and hide correct-city stock that merely ranked past the vector top-N.
  const rawVectorCandidates = constrained(
    await vectorSearch(expandedQuery, excludeIds)
  );
  const vectorCandidates = city
    ? rawVectorCandidates.filter((r) => rowInCityRegion(r, city))
    : rawVectorCandidates;

  // 1a: vector candidates that pass the block filter
  const vectorStrict = applyBlockFilter(vectorCandidates, blockTerms);
  if (vectorStrict.length > 0) {
    return {
      listing: await pickBest(query, vectorStrict),
      relaxedNote: null,
      phase: "P1_VECTOR",
    };
  }

  // 1b: block filter is the only obstacle — relax it, keep semantic candidates
  if (blockTerms.length > 0 && vectorCandidates.length > 0) {
    return {
      listing: await pickBest(query, vectorCandidates),
      relaxedNote:
        "找不到完全符合要求的房源，已放宽部分限制条件，为您找到以下最相近的房源",
      phase: "P1_VECTOR_RELAXED",
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2 — City keyword search
  // Only runs if the query mentions a known Bay Area city.
  // Searches rawText + locationText + title for the city name.
  // ═══════════════════════════════════════════════════════════════════════════

  if (city) {
    // Match the city across ALL its spellings (EN + ZH), not just the English
    // canonical — Chinese-only listings ("旧金山" with no "San Francisco") are a
    // large slice of the data and a single English keyword misses every one.
    const { results: cityRows } = await searchXhsRentalListings({
      locationTerms: cityAliases(city),
      limit: LAST_RESORT_LIMIT,
    });
    // SQL alias-match favours recall (catches Chinese-only posts) but also pulls
    // in "旧金山湾区…东湾X" false positives; re-filter to the precise region so a
    // San-Mateo/East-Bay listing never answers a San-Francisco query.
    const cityUnseen = constrained(filterExcluded(cityRows, excludeIds)).filter(
      (r) => rowInCityRegion(r, city)
    );

    // 2a: strict
    const cityStrict = applyBlockFilter(cityUnseen, blockTerms);
    if (cityStrict.length > 0) {
      return {
        listing: await pickBest(query, cityStrict),
        relaxedNote: null,
        phase: "P2_CITY",
      };
    }

    // 2b: relaxed (drop block filter)
    if (cityUnseen.length > 0) {
      return {
        listing: await pickBest(query, cityUnseen),
        relaxedNote: `找不到完全匹配的房源，已在${city.zh}范围内为您找到以下房源`,
        phase: "P2_CITY_RELAXED",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 3 — Non-city keyword fulltext search
  // Covers room types, amenities, lease terms that vector search may have missed.
  // City name deliberately excluded — Phase 2 already handled city-level search.
  // ═══════════════════════════════════════════════════════════════════════════

  const nonCityKeywords = extractNonCityKeywords(query);
  if (nonCityKeywords.length > 0) {
    const { results: kwRows } = await searchXhsRentalListings({
      keywords: nonCityKeywords,
    });
    const kwUnseen = constrained(filterExcluded(kwRows, excludeIds));

    // 3a: strict
    const kwStrict = applyBlockFilter(kwUnseen, blockTerms);
    if (kwStrict.length > 0) {
      return {
        listing: await pickBest(query, kwStrict),
        relaxedNote:
          "找不到精确匹配的房源，已按关键词扩大搜索，为您找到以下房源",
        phase: "P3_KEYWORD",
      };
    }

    // 3b: relaxed
    if (kwUnseen.length > 0) {
      return {
        listing: await pickBest(query, kwUnseen),
        relaxedNote: "找不到精确匹配的房源，已扩大搜索范围并放宽限制条件",
        phase: "P3_KEYWORD_RELAXED",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 4 — Last resort
  // Fetch 50 recent listings (wider pool improves rerank quality) and let
  // pickBest find the semantically closest unseen one.
  // ═══════════════════════════════════════════════════════════════════════════

  const { results: recentRows } = await searchXhsRentalListings({
    limit: LAST_RESORT_LIMIT,
  });
  const remaining = preferCityRegion(
    constrained(filterExcluded(recentRows, excludeIds)),
    city
  );
  if (remaining.length > 0) {
    return {
      listing: await pickBest(query, remaining),
      relaxedNote:
        "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
      phase: "P4_RECENT",
    };
  }

  // Constraint-relaxed fallback: the tenant stated hard requirements (budget /
  // bedrooms / move-in) but nothing in the pool satisfies them. Rather than
  // dead-ending, surface the closest recent listing and clearly warn that it
  // may not meet every requirement, so the user decides.
  if (hasAnyConstraint(constraints)) {
    const relaxed = filterExcluded(recentRows, excludeIds);
    if (relaxed.length > 0) {
      return {
        listing: await pickBest(query, relaxed),
        relaxedNote:
          "没有完全满足预算 / 房型 / 入住时间要求的房源；以下是最接近的，请留意是否符合你的硬性条件。",
        phase: "P4_CONSTRAINT_RELAXED",
      };
    }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// STRICT MODE — current default logic. Everything above this banner is the
// LEGACY "换一个" cascade, kept intact for rollback (SEARCH_LEGACY_PICK_ONE=1).
// ═════════════════════════════════════════════════════════════════════════════

/** Rollback switch: set SEARCH_LEGACY_PICK_ONE=1 to restore the legacy flow. */
const LEGACY_PICK_ONE = process.env.SEARCH_LEGACY_PICK_ONE === "1";

const STRICT_MAX_RESULTS = 5;
const STRICT_POOL_LIMIT = 1000; // whole table today (~750 rows)
const STRICT_RERANK_CAP = 100; // rerank cost cap when many rows survive

/**
 * Exact-city membership (no neighbours — strict mode returns only the city the
 * user actually named). The LLM-normalized `city` column is authoritative when
 * present; otherwise fall back to Bay-Area-phrase-aware text detection. Rows
 * whose city cannot be established do NOT count as matches.
 */
function rowInCityExact(
  row: XhsRentalSearchResultRow,
  city: CityEntry
): boolean {
  const col = row.city?.trim().toLowerCase();
  if (col && col !== "null" && col.length > 0) {
    return col === city.en.toLowerCase();
  }
  const rc = detectCityStrict(
    `${row.title ?? ""} ${row.locationText ?? ""} ${row.propertyName ?? ""} ${row.rawText}`
  );
  return rc ? rc.en === city.en : false;
}

// Boolean requirements are strict: a listing counts only when the structured
// column confirms it, or (column unparsed) the text itself affirms it.
const BOOL_TEXT_POSITIVE: {
  key: "petFriendly" | "couplesOk" | "utilitiesIncluded" | "parkingIncluded";
  re: RegExp;
}[] = [
  {
    key: "petFriendly",
    re: /宠物友好|可养宠|可以养宠|允许宠物|可带宠|接受宠物|pet[-\s]?friendly|pets?\s*(ok|allowed|welcome)/i,
  },
  {
    key: "couplesOk",
    re: /情侣可|可情侣|接受情侣|情侣友好|欢迎情侣|couples?\s*(ok|welcome|friendly)/i,
  },
  {
    key: "utilitiesIncluded",
    re: /包水电|水电全?包|含水电|包?水电网|utilit(y|ies)\s*(included|全?包)/i,
  },
  {
    key: "parkingIncluded",
    re: /有车位|带车位|含车位|免费停车|有停车|可停车|parking\s*(included|available|spot)|free\s*parking/i,
  },
];

function satisfiesBooleanPrefs(
  row: XhsRentalSearchResultRow,
  prefs: ReturnType<typeof extractBooleanPrefs>
): boolean {
  for (const { key, re } of BOOL_TEXT_POSITIVE) {
    if (prefs[key] !== true) continue; // not required
    const col = row[key];
    if (col === true) continue; // confirmed by structured field
    if (col === false) return false; // explicitly disallowed
    if (!re.test(row.rawText)) return false; // unparsed AND text silent → out
  }
  return true;
}

// ── Row-field recovery (structured columns are sparse) ───────────────────────
// The LLM-backfilled columns cover only a fraction of the table (rentNumeric
// ~13%, bedroomsNum ~3%), so "strict" filtering on columns alone barely cuts
// anything. Recover the same facts from the ingest text columns.

const PER_DAY_RATE_RE = /日|天|\/\s*day|per\s*day|晚/i;
const RENT_TOKEN_RE = /\$?\s*(\d+(?:\.\d+)?)\s*(k?)/i;

/** Rent from the free-text `rent` column ("$1800", "1295", "$2.5k"). Nulls out
 *  per-day rates, zip codes, area codes and other implausible values. */
function rentFromText(rent: string | null): number | null {
  if (!rent) return null;
  if (PER_DAY_RATE_RE.test(rent)) return null; // per-day rate
  const m = rent.match(RENT_TOKEN_RE);
  if (!m) return null;
  const n = m[2] ? Math.round(Number.parseFloat(m[1]) * 1000) : Number(m[1]);
  // Same plausibility window as the rentNumeric backfill.
  if (!Number.isFinite(n) || n < 300 || n > 15_000) return null;
  return n;
}

/** Unit bedroom count from the `bedrooms` text column ("2", "2B2B", "1bed",
 *  "studio") with a title-pattern fallback ("一房出租", "3室2厅", "2b1b"). */
const NBNB_RE = /(\d)\s*b\s*\d\s*b/i;
const SINGLE_DIGIT_RE = /^\d$/;
const BED_COL_PREFIX_RE = /^(\d)\s*b/i;
const STUDIO_COL_RE = /^studio$/i;
const TITLE_BED_EN_RE = /(\d)\s*(?:bed(?:room)?s?|br)\b/i;
const TITLE_BED_ZH_RE = /(\d)\s*(?:室|房|居|卧)/;
const TITLE_BED_CN_NUM_RE = /([一两二三四五])\s*(?:室|房|居|卧)/;
const BED_CN_NUMERALS: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
};

function bedroomsFromText(
  bedrooms: string | null,
  title: string | null
): number | null {
  const clamp = (n: number): number | null => (n >= 0 && n <= 5 ? n : null);
  const t = title ?? "";

  // An explicit "NbNb" in the title is the strongest signal and outranks the
  // ingest-parsed `bedrooms` column, which is occasionally wrong on exactly
  // these posts (e.g. title "1B1B" stored as bedrooms="2").
  let m = t.match(NBNB_RE);
  if (m) return clamp(Number(m[1]));

  const b = bedrooms?.trim() ?? "";
  if (SINGLE_DIGIT_RE.test(b)) return clamp(Number(b));
  m = b.match(BED_COL_PREFIX_RE); // "2B2B", "4B1B（4卧1卫）", "1bed"
  if (m) return clamp(Number(m[1]));
  if (STUDIO_COL_RE.test(b)) return 0;

  // Title fallback — unit size only; deliberately NO "单间→studio" mapping
  // (a "单间" title advertises a room in a shared unit, not a studio).
  m = t.match(TITLE_BED_EN_RE);
  if (m) return clamp(Number(m[1]));
  m = t.match(TITLE_BED_ZH_RE);
  if (m) return clamp(Number(m[1]));
  m = t.match(TITLE_BED_CN_NUM_RE);
  if (m) return clamp(BED_CN_NUMERALS[m[1]] ?? Number.NaN);
  return null;
}

/** Shim sparse structured columns with text-recovered values before the
 *  constraint check, so strict filtering has real teeth on this corpus. */
function withRecoveredFields(
  row: XhsRentalSearchResultRow
): XhsRentalSearchResultRow {
  return {
    ...row,
    rentNumeric: row.rentNumeric ?? rentFromText(row.rent),
    bedroomsNum: row.bedroomsNum ?? bedroomsFromText(row.bedrooms, row.title),
  };
}

// The corpus is supposed to be Bay-Area-only but contains strays (San Diego
// sublets etc.). A row whose text names a non-Bay metro/campus and no Bay city
// is provably out of coverage — strict mode never returns it.
const NON_BAY_LISTING_RE =
  /西雅图|seattle|纽约|new\s*york|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|\bucsd\b|\bucla\b|\bucsb\b|\bsdsu\b|尔湾|irvine|波士顿|boston|芝加哥|chicago/i;

function listingOutOfBay(row: XhsRentalSearchResultRow): boolean {
  const col = row.city?.trim();
  if (col && col.toLowerCase() !== "null") {
    // Trust the LLM-normalized column: a non-Bay city there (San Diego etc.)
    // is authoritative — the row is out of coverage no matter what the text
    // says. Bay/unknown cities pass.
    return NON_BAY_LISTING_RE.test(col);
  }
  const text = `${row.title ?? ""} ${row.locationText ?? ""} ${row.propertyName ?? ""} ${row.rawText}`;
  return !detectCityStrict(text) && NON_BAY_LISTING_RE.test(text);
}

// A handful of scraped rows aren't rental listings at all (event/ad posts,
// storage-unit rentals). Storage offers pass the vocabulary check (they say
// 租), so they get their own title test. Otherwise: no structured
// rent/bedrooms AND no rental vocabulary anywhere → not a listing; strict
// mode never returns it.
const RENTAL_SIGNAL_RE = /租|rent|room|bed|卧|室|studio|sublease|lease|\$\d/i;
const NON_HOUSING_TITLE_RE = /储物|仓储|storage\s*(room|unit|space)|车位出租/i;

function isNonRentalRow(row: XhsRentalSearchResultRow): boolean {
  if (NON_HOUSING_TITLE_RE.test(row.title ?? "")) return true;
  if (row.rent != null || row.bedrooms != null) return false;
  return !RENTAL_SIGNAL_RE.test(`${row.title ?? ""} ${row.rawText}`);
}

/**
 * Structured constraints the CALLING LLM (chat model) passes alongside the
 * free-text query. This is the LLM-native path: the chat model already
 * understands that "SOMA"/"Mission" mean San Francisco and "Moffett Park"
 * means Sunnyvale — knowledge no regex table can carry. Regex NL extraction
 * remains the fallback for anything the model omits.
 */
export type StrictSearchParams = {
  city?: string | null;
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsNum?: number | null;
  petFriendly?: boolean | null;
  couplesOk?: boolean | null;
  utilitiesIncluded?: boolean | null;
  parkingIncluded?: boolean | null;
};

/**
 * The strict-match predicate for a query, shared by the runtime search AND the
 * eval harness (tests/search-eval) so "what counts as a match" can never drift
 * between the two.
 *
 * Constraint sources, in priority order: typed params from the calling LLM
 * (semantic understanding — neighborhood→city etc.), then regex NL extraction
 * filling the gaps. Enforcement stays 偏严格, not absolutist: only PROVABLE
 * violations cut a row (unparsed fields are lenient; sparse columns are first
 * backfilled from text via withRecoveredFields), boolean requirements need
 * column or text confirmation, and out-of-Bay strays never surface. Ranking
 * relevance is the semantic reranker's job, not the filter's.
 */
export function buildStrictPredicate(
  query: string,
  params: StrictSearchParams = {}
): {
  city: CityEntry | null;
  matches: (row: XhsRentalSearchResultRow) => boolean;
} {
  // City: LLM-normalized param wins; resolve it through CITY_TABLE so aliases
  // and text-detection fallbacks keep working. A param city NOT in the table
  // (e.g. "Tracy") degrades to a soft, column-only match via rowViolates.
  const paramCity = params.city?.trim() || null;
  const city = paramCity
    ? (detectCity(paramCity) ?? null)
    : detectCity(query);
  const unknownCity = paramCity && !city ? paramCity : null;

  const nl = extractHardConstraints(query);
  const nlBool = extractBooleanPrefs(query);
  const boolPrefs = {
    petFriendly: params.petFriendly ?? nlBool.petFriendly,
    couplesOk: params.couplesOk ?? nlBool.couplesOk,
    utilitiesIncluded: params.utilitiesIncluded ?? nlBool.utilitiesIncluded,
    parkingIncluded: params.parkingIncluded ?? nlBool.parkingIncluded,
  };
  // Boolean prefs are handled separately (text fallback), so null them out of
  // the rowViolates constraint set.
  const coreConstraints = {
    ...nl,
    rentMin: params.rentMin ?? nl.rentMin,
    rentMax: params.rentMax ?? nl.rentMax,
    bedroomsNum: params.bedroomsNum ?? nl.bedroomsNum,
    petFriendly: null,
    couplesOk: null,
    utilitiesIncluded: null,
    parkingIncluded: null,
    city: unknownCity,
    cityNeighbors: [],
  };
  return {
    city,
    matches: (raw) => {
      if (isNonRentalRow(raw) || listingOutOfBay(raw)) return false;
      const row = withRecoveredFields(raw);
      if (city && !rowInCityExact(row, city)) return false;
      if (rowViolates(row, coreConstraints)) return false;
      return satisfiesBooleanPrefs(row, boolPrefs);
    },
  };
}

type StrictSearchResult = {
  listings: XhsRentalSearchResultRow[];
  /** How many rows satisfied every requirement (before the ≤5 cut). */
  totalMatched: number;
  outOfBay: boolean;
};

/**
 * Strict search: filter the whole pool by every voiced requirement, return the
 * top ≤5. Empty result means "数据库里没有" — the caller reports that honestly
 * instead of substituting a近似 listing.
 */
async function findStrictListings(
  query: string,
  blockTerms: string[],
  params: StrictSearchParams = {}
): Promise<StrictSearchResult> {
  // The corpus only covers the Bay Area; a Seattle/NYC/... request provably
  // has no answer here. Refuse early instead of returning unrelated listings.
  // Checked on both the query text AND the LLM-normalized city param.
  if (
    isOutOfBayQuery(query) ||
    (params.city && !detectCity(params.city) && NON_BAY_LISTING_RE.test(params.city))
  ) {
    return { listings: [], totalMatched: 0, outOfBay: true };
  }

  const { matches } = buildStrictPredicate(query, params);

  // Pool: the most recent STRICT_POOL_LIMIT rows — the whole table today
  // (~750). All strictness is enforced in the app layer via the shared
  // predicate; SQL alias-matching is deliberately NOT used to narrow the pool,
  // because a listing whose `city` column is set but whose text never spells
  // the city name would be silently unreachable.
  const { results: pool } = await searchXhsRentalListings({
    limit: STRICT_POOL_LIMIT,
  });

  const matched = applyBlockTerms(pool.filter(matches), blockTerms);

  if (matched.length <= STRICT_MAX_RESULTS) {
    return { listings: matched, totalMatched: matched.length, outOfBay: false };
  }

  // More than 5 qualify → order by relevance (Voyage rerank when available,
  // most-recent-first otherwise) and cut to 5.
  const pool2 = matched.slice(0, STRICT_RERANK_CAP);
  if (process.env.VOYAGE_API_KEY) {
    try {
      const topIndices = await rerankDocuments(
        query,
        pool2.map((r) => r.rawText),
        STRICT_MAX_RESULTS
      );
      if (topIndices.length > 0) {
        return {
          listings: topIndices
            .map((i) => pool2[i])
            .filter((r): r is XhsRentalSearchResultRow => Boolean(r)),
          totalMatched: matched.length,
          outOfBay: false,
        };
      }
    } catch (err) {
      console.error("[searchRental] strict rerank failed:", err);
    }
  }
  return {
    listings: matched.slice(0, STRICT_MAX_RESULTS),
    totalMatched: matched.length,
    outOfBay: false,
  };
}

/**
 * Strict-mode tool: returns a `listings` ARRAY (≤5) with no relaxation and no
 * per-session rotation. The calling chat model is the query-understanding
 * layer: it passes normalized structured constraints (city from neighborhood
 * knowledge, numeric budget, bedrooms, booleans) alongside the free-text
 * query; regex NL extraction only fills whatever it omits.
 */
function createStrictSearchRentalTool(chatId: string) {
  return tool({
    description:
      "Strict search over the XhsRentalListing database. " +
      "Call this for ANY housing/rental request. " +
      "Returns up to 5 listings that STRICTLY satisfy every requirement the user stated. " +
      "If nothing satisfies all requirements, `listings` is empty — tell the user honestly that there is no match. " +
      "The tool never relaxes criteria and never substitutes near-matches. " +
      "YOU are the query-understanding layer: normalize what the user said into the structured fields " +
      "(map neighborhoods/landmarks to their city: SOMA/Mission/日落区→San Francisco, Moffett Park→Sunnyvale, " +
      "UCB→Berkeley, Stanford→Palo Alto). Only set fields the user actually voiced.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Full natural language search request with ALL accumulated context. " +
            "Carry forward location, budget, bedrooms, move-in date, requirements from prior turns. " +
            "Example: '圣何塞两室一厅，预算2500以下，宠物友好，情侣入住'"
        ),
      city: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Standardized English Bay Area city name the user wants, resolved with your world knowledge: " +
            "'SOMA公寓' → 'San Francisco'; '在Moffett Park上班想住附近' → 'Sunnyvale'; '伯克利' → 'Berkeley'. " +
            "Omit when the user named no location or only a broad region (南湾/东湾/湾区)."
        ),
      rentMin: z
        .number()
        .nullable()
        .optional()
        .describe("Minimum monthly rent in USD, only if the user stated one."),
      rentMax: z
        .number()
        .nullable()
        .optional()
        .describe(
          "Maximum monthly rent in USD ('预算3k以下' → 3000). Only if the user stated a budget."
        ),
      bedroomsNum: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Bedroom count of the UNIT the user wants (studio=0, 一室/1B1B=1, 两室/2B2B=2). " +
            "For '想租2B2B里的一间' pass 2. Omit if unstated."
        ),
      petFriendly: z
        .boolean()
        .nullable()
        .optional()
        .describe("true ONLY if the user needs pets allowed (有猫/养狗/宠物友好)."),
      couplesOk: z
        .boolean()
        .nullable()
        .optional()
        .describe("true ONLY if the user needs couple occupancy (情侣/夫妻同住)."),
      utilitiesIncluded: z
        .boolean()
        .nullable()
        .optional()
        .describe("true ONLY if the user requires utilities included (包水电)."),
      parkingIncluded: z
        .boolean()
        .nullable()
        .optional()
        .describe("true ONLY if the user requires parking (要车位/停车)."),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a listing if found in its text (hard negative constraints). " +
            "Carry forward across turns. Include both Chinese and English variants."
        ),
    }),
    execute: async ({ query, mustNotContain, ...params }) => {
      const startedAt = Date.now();
      try {
        const blockTerms = (mustNotContain ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);

        const result = await findStrictListings(query, blockTerms, params);

        // 留档（评测抽样数据源）；失败绝不影响搜索。见 legacy execute 内注释。
        const phase = result.outOfBay
          ? "STRICT_OUT_OF_BAY"
          : result.listings.length > 0
            ? "STRICT_MATCH"
            : "STRICT_EMPTY";
        scheduleAfterResponse(() =>
          logSearchQuery({
            chatId,
            query,
            mustNotContain: mustNotContain ?? null,
            phase,
            listingId: result.listings[0]?.id ?? null,
            relaxed: false,
            durationMs: Date.now() - startedAt,
          }).catch((err) => {
            console.error("[searchRental] logSearchQuery failed:", err);
          })
        );

        if (result.outOfBay) {
          return {
            listings: [],
            totalMatched: 0,
            action:
              "OUT_OF_BAY: 用户找的城市不在湾区。如实告知：我们目前只收录旧金山湾区的房源，该城市暂无数据。不要展示任何房源。",
          };
        }

        if (result.listings.length === 0) {
          return {
            listings: [],
            totalMatched: 0,
            action:
              "NO_MATCH: 数据库中没有完全符合用户全部要求的房源。如实告诉用户没有找到，绝不要用近似房源代替。可以指出哪个条件（预算/城市/房型/入住时间等）可能过严，建议用户调整后再搜。",
          };
        }

        return {
          listings: result.listings,
          totalMatched: result.totalMatched,
          action:
            `SHOW_LISTINGS: 找到 ${result.listings.length} 个严格符合要求的房源` +
            (result.totalMatched > result.listings.length
              ? `（共 ${result.totalMatched} 个符合，已按相关度取前 ${result.listings.length} 个）`
              : "") +
            "。把 listings 数组里的每一个房源都完整展示出来（标准格式），不要遗漏、不要编造。",
        };
      } catch (error) {
        console.error("[searchRental] strict tool error:", error);
        return {
          listings: [],
          totalMatched: 0,
          action:
            "SEARCH_FAILED: Tell the user the search hit a temporary error and ask them to retry.",
        };
      }
    },
  });
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Create the searchRental tool bound to a specific chatId.
 *
 * Default: STRICT mode — up to 5 listings that satisfy every stated
 * requirement, empty list when nothing does (the "换一个" flow is deprecated).
 * Set SEARCH_LEGACY_PICK_ONE=1 to restore the legacy one-at-a-time cascade.
 */
export function createSearchRentalTool(chatId: string) {
  if (!LEGACY_PICK_ONE) {
    return createStrictSearchRentalTool(chatId);
  }
  return createLegacySearchRentalTool(chatId);
}

/**
 * LEGACY tool (deprecated, kept for rollback): one listing per call, server
 * tracks seen IDs, auto-relaxes until something is shown ("换一个" flow).
 */
function createLegacySearchRentalTool(chatId: string) {
  return tool({
    description:
      "Semantic search over the XhsRentalListing database. " +
      "Call this for ANY housing/rental request — first searches AND every '换一个'/'next'/'不满意'. " +
      "Returns ONE listing the user has not yet seen this session. " +
      "If no exact match, the tool automatically relaxes criteria and returns the closest available listing. " +
      "Never skip calling this; the server handles deduplication automatically.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Full natural language search request with ALL accumulated context. " +
            "Carry forward location, budget, bedrooms, move-in date, requirements from prior turns. " +
            "Example: '圣何塞两室一厅，预算2500以下，宠物友好，情侣入住'"
        ),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a listing if found in its rawText (hard negative constraints). " +
            "Carry forward across turns. Include both Chinese and English variants. Examples:\n" +
            "- Couples/family → ['仅限一人', '单人', 'one person only', '一人入住']\n" +
            "- No agent posts → ['中介', 'agent fee', '佣金']\n" +
            "- No seekers/roommate ads → ['求租', '找室友', '合租找人']"
        ),
    }),
    execute: async ({ query, mustNotContain }) => {
      const startedAt = Date.now();
      try {
        const excludeIds = await getSeenListingIds(chatId);
        const blockTerms = (mustNotContain ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);

        const result = await findNextListing(query, excludeIds, blockTerms);

        // 留档（评测抽样 + 不满意信号数据源）；失败绝不影响搜索。
        // 用 after() 而非裸 fire-and-forget：serverless 在 execute 返回后可能
        // 立刻冻结/回收函数，未 await 的 insert 会被静默丢弃——而留档正是本功能
        // 的全部意义。after() 让平台等这条写入完成再回收。
        scheduleAfterResponse(() =>
          logSearchQuery({
            chatId,
            query,
            mustNotContain: mustNotContain ?? null,
            phase: result?.phase ?? "NO_RESULT",
            listingId: result?.listing.id ?? null,
            relaxed: Boolean(result?.relaxedNote),
            durationMs: Date.now() - startedAt,
          }).catch((err) => {
            console.error("[searchRental] logSearchQuery failed:", err);
          })
        );

        if (!result) {
          return {
            listing: null,
            relaxedNote: null,
            action:
              excludeIds.length > 0
                ? "NO_MORE: 已经没有更多符合要求的房源了。建议用户调整筛选条件或放宽某些限制再试。"
                : "NO_RESULTS: 数据库暂时没有可推荐的房源，请稍后再试。",
          };
        }

        await markListingAsSeen(chatId, result.listing.id);

        if (result.relaxedNote) {
          return {
            listing: result.listing,
            relaxedNote: result.relaxedNote,
            action:
              "SHOW_RELAXED_LISTING: No exact match found; tool auto-relaxed criteria. " +
              "Show `relaxedNote` in italics as first line, then display the listing in standard format. " +
              "End with: '如您仍不满意，可以告诉我具体要求，我再为您调整。' " +
              "For subsequent '换一个': call searchRental again with the SAME query.",
          };
        }

        return {
          listing: result.listing,
          relaxedNote: null,
          action:
            "SHOW_LISTING: Display this listing in standard format. " +
            "For '换一个'/'next'/'不满意': call searchRental again with the SAME query — " +
            "the server automatically excludes already-shown listings.",
        };
      } catch (error) {
        console.error("[searchRental] tool error:", error);
        return {
          listing: null,
          relaxedNote: null,
          action:
            "SEARCH_FAILED: Tell the user the search hit a temporary error and ask them to retry.",
        };
      }
    },
  });
}
