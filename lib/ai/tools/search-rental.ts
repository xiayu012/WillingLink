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
 *   - Understand the request ONCE via planQuery (lib/rental/query-plan.ts),
 *     which yields a QueryPlan whose city/bedroom constraints are SETS.
 *   - Filter the WHOLE pool strictly by every requirement the user voiced
 *     (city set, budget ceiling, bedroom set, move-in deadline, lease window,
 *     pet/couple/utilities/parking — cutting only provable violations).
 *   - Rank all matches, verify the top-K once, and hand back ≤8 per batch
 *     (reranked when Voyage is available, else most recent first). "继续/换一批"
 *     slices the next 8 out of that same cached list — instant, never repeats.
 *   - If nothing satisfies everything → return an empty list and say so.
 *     No relaxation, no substitution, no rotation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { tool } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { verifyListingsAgainstQuery } from "@/lib/ai/verify-listings";
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
  cityByName,
  detectCity,
  detectCityStrict,
} from "@/lib/rental/cities";
import { haversineKm, listingPoint } from "@/lib/rental/geo";
import { listingLeaseFromText } from "@/lib/rental/lease-duration";
import {
  applyBlockTerms,
  applyHardConstraints,
  emptyConstraints,
  extractHardConstraints,
  hasAnyConstraint,
  rowViolates,
} from "@/lib/rental/query-constraints";
import {
  type BoolRequirementKey,
  planQuery,
  planSummary,
  type QueryPlan,
  rerankQueryFor,
} from "@/lib/rental/query-plan";
import {
  batchFingerprint,
  loadBatchState,
  saveBatchState,
} from "@/lib/rental/result-batches";

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

const STRICT_MAX_RESULTS = 8; // 每批展示上限
// 一次检索就把 top-K 排好序并整批终审，存进会话缓存，"继续/换一批" 直接切下一批：
// 瞬间返回，且与已展示的天然不重复（同一份有序列表往后走）。
const STRICT_BATCH_POOL = STRICT_MAX_RESULTS * 3;
const STRICT_POOL_LIMIT = 1000; // whole table today (~750 rows)
const STRICT_RERANK_CAP = 100; // rerank cost cap when many rows survive

/**
 * Which city a listing actually sits in. The LLM-normalized `city` column is
 * authoritative when present; otherwise fall back to Bay-Area-phrase-aware
 * text detection over every location-bearing field. Returns null when the city
 * cannot be established at all.
 */
function resolveRowCity(row: XhsRentalSearchResultRow): string | null {
  const col = row.city?.trim();
  if (col && col.toLowerCase() !== "null" && col.length > 0) {
    return cityByName(col)?.en ?? col;
  }
  const rc = detectCityStrict(
    `${row.title ?? ""} ${row.locationText ?? ""} ${row.propertyName ?? ""} ${row.rawText}`
  );
  return rc?.en ?? null;
}

/**
 * Membership in the plan's acceptable-city SET (no neighbour expansion —
 * strict mode returns only cities the user actually named or that their region
 * word covers). Rows whose city cannot be established do NOT count as matches:
 * a listing that never says where it is cannot be shown as an answer to
 * "I want to live in Dublin".
 */
function rowInAnyCity(
  row: XhsRentalSearchResultRow,
  cities: readonly string[]
): boolean {
  const rowCity = resolveRowCity(row);
  if (!rowCity) return false;
  const lower = rowCity.toLowerCase();
  return cities.some((c) => c.trim().toLowerCase() === lower);
}

// Boolean requirements cut only on a PROVABLE violation — an explicit "no
// pets"/"no parking" in the column or the text. Silence is NOT a violation.
//
// 这条以前是反的（列没确认且正文没肯定 → 剔除），召回评测一跑就现形：
// "养猫人…有停车位" 那条查询库里有 5 个 LLM 认可的房源，谓词一个不剩，
// 因为绝大多数帖子根本不会专门写"允许养宠物/有车位"。沉默不是矛盾——这既是
// CLAUDE.md 写的"只剔除可证明违反的"，也和终审 prompt 里那条"帖子对某需求
// 沉默不算矛盾"一致，之前两处标准打架。
// 代价（确认过的房源和沉默的房源混在一起）由 rankByPlanSignals 在排序上补：
// 确认满足的排前面，沉默的排后面，而不是把沉默的藏起来。
const BOOL_TEXT_POSITIVE: { key: BoolRequirementKey; re: RegExp }[] = [
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

/** Text that explicitly REFUSES a requirement — the only text-level violation. */
const BOOL_TEXT_NEGATIVE: { key: BoolRequirementKey; re: RegExp }[] = [
  {
    key: "petFriendly",
    re: /不(?:可|能|允许|接受)养?宠物?|禁止养?宠物|无宠物家庭|不养宠物|no\s*pets?\b|pets?\s*not\s*allowed/i,
  },
  {
    key: "couplesOk",
    re: /不接受情侣|仅限一人|只租一人|限一人入住|单人入住|no\s*couples?/i,
  },
  {
    key: "utilitiesIncluded",
    re: /水电(?:费)?(?:自理|另算|另付|不含|不包)|不包水电|utilities?\s*not\s*included/i,
  },
  {
    key: "parkingIncluded",
    re: /(?:没有|无|不含|不提供|不带)(?:车位|停车位|停车)|车位(?:自理|另租|另付|需另外)|no\s*parking/i,
  },
];

/** True unless the listing PROVABLY refuses one of the required booleans. */
function satisfiesBooleanPrefs(
  row: XhsRentalSearchResultRow,
  prefs: Record<BoolRequirementKey, boolean | null>
): boolean {
  for (const { key, re } of BOOL_TEXT_NEGATIVE) {
    if (prefs[key] !== true) continue; // not required
    if (row[key] === false) return false; // structured column says no
    if (row[key] === true) continue; // structured column says yes
    if (re.test(row.rawText)) return false; // text says no
  }
  return true;
}

/** How many of the required booleans this listing positively CONFIRMS. */
function confirmedCount(
  row: XhsRentalSearchResultRow,
  prefs: Record<BoolRequirementKey, boolean | null>
): number {
  let n = 0;
  for (const { key, re } of BOOL_TEXT_POSITIVE) {
    if (prefs[key] !== true) continue;
    if (row[key] === true || re.test(row.rawText)) n++;
  }
  return n;
}

const ANCHOR_MIN_CHARS = 4;
const ANCHOR_WEIGHT = 3; // 点名的小区命中 > 任何单个布尔确认
const DISTANCE_WEIGHT = 10; // "靠近X" 压过其它排序信号

/** Does the listing name one of the complexes/landmarks the user asked for? */
function anchorHits(row: XhsRentalSearchResultRow, anchors: string[]): number {
  if (anchors.length === 0) return 0;
  const hay =
    `${row.title ?? ""} ${row.propertyName ?? ""} ${row.locationText ?? ""} ${row.rawText}`.toLowerCase();
  let n = 0;
  for (const a of anchors) {
    // 太短的锚点（"tt"、"sj"）当子串搜会命中一堆无关文本，只留够长的。
    const t = a.trim().toLowerCase();
    if (t.length >= ANCHOR_MIN_CHARS && hay.includes(t)) n++;
  }
  return n;
}

/**
 * Stable re-sort by the two plan signals the semantic reranker cannot judge:
 * how many of the user's boolean requirements the listing positively CONFIRMS,
 * and whether it names a complex/landmark the user asked for by name.
 *
 * Relevance order inside each tier is untouched — this only breaks ties.
 * It is also the other half of making the boolean filter lenient: listings
 * that stay silent on a requirement remain reachable, they just rank below the
 * ones that say yes out loud. Ranking, never filtering.
 */
// 距离分档而不是直接按公里排序：档内保留语义 rerank 的顺序。人找房也是这样
// 想的——"走路能到"和"骑车能到"是两回事，档内差几百米无所谓。
const DISTANCE_TIERS_KM = [1.5, 3, 6, 10, 15];

/**
 * 用户**点名**的城市要压过同一圈里的邻市。
 *
 * 距离分档最细也只到 1.5km，而相邻城市之间常常就差几公里（Mountain View 到
 * Los Altos 约 4km），光靠距离分不开"他说的那个城"和"旁边那个城"。用户在帖子
 * 标题里写了 mountain view，结果第一屏全是 Los Altos / Sunnyvale / Cupertino
 * ——每一条距离上都说得通，但没有一条是他要的（AGENT_LOG 2026-08-26）。
 *
 * 权重比 DISTANCE_WEIGHT 高一档：命中点名城市 > 单纯离得近。这只影响**排序**，
 * 不改硬筛选——邻市房源仍然会出现，只是排在后面。
 */
const NAMED_CITY_WEIGHT = 12;

/** 越近分越高；坐标未知的行落在最低档（不剔除，只是排后面）。 */
function proximityScore(
  row: XhsRentalSearchResultRow,
  plan: QueryPlan
): number {
  if (!plan.near) return 0;
  const p = listingPoint(row);
  if (!p) return 0; // 位置不明 → 不加分，但也不惩罚到剔除
  const km = haversineKm(p, plan.near);
  const tier = DISTANCE_TIERS_KM.findIndex((limit) => km <= limit);
  return tier === -1 ? 1 : DISTANCE_TIERS_KM.length + 1 - tier;
}

function rankByPlanSignals(
  rows: XhsRentalSearchResultRow[],
  plan: QueryPlan
): XhsRentalSearchResultRow[] {
  const needsBool = BOOL_FIELDS.some((k) => plan.requires[k] === true);
  if (
    !(needsBool || plan.anchors.length > 0 || plan.near || plan.cities.length)
  ) {
    return rows;
  }
  return rows
    .map((row, i) => ({
      row,
      i,
      score:
        // 用户说了"靠近X"时，距离压过一切其它排序信号——这正是他要的。
        DISTANCE_WEIGHT * proximityScore(row, plan) +
        NAMED_CITY_WEIGHT * (rowInAnyCity(row, plan.cities) ? 1 : 0) +
        confirmedCount(row, plan.requires) +
        ANCHOR_WEIGHT * anchorHits(row, plan.anchors),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.row);
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
  // 租期列是后加的：老行/新入库行在 LLM 提取落地前为 null，用保守正则从
  // 帖子文本兜底（"一年起租"/"6个月起租"/"仅限一个月短租"等清晰硬表述）。
  // min>max 的自相矛盾提取（多见于长短租双档价帖）不可信 → 视为无数据。
  const colContradictory =
    row.leaseMinMonths != null &&
    row.leaseMaxMonths != null &&
    row.leaseMinMonths > row.leaseMaxMonths;
  const lease =
    colContradictory ||
    (row.leaseMinMonths == null && row.leaseMaxMonths == null)
      ? listingLeaseFromText(`${row.title ?? ""}\n${row.rawText}`)
      : {
          leaseMinMonths: row.leaseMinMonths,
          leaseMaxMonths: row.leaseMaxMonths,
        };
  return {
    ...row,
    rentNumeric: row.rentNumeric ?? rentFromText(row.rent),
    bedroomsNum: row.bedroomsNum ?? bedroomsFromText(row.bedrooms, row.title),
    leaseMinMonths: lease.leaseMinMonths,
    leaseMaxMonths: lease.leaseMaxMonths,
  };
}

// The corpus is supposed to be Bay-Area-only but contains strays (San Diego
// sublets etc.). A row whose text names a non-Bay metro/campus and no Bay city
// is provably out of coverage — strict mode never returns it.
// 匹兹堡（中文写法一律指宾州）和 \bpittsburgh\b 在这里，湾区的 Pittsburg
// （无 h）不在——门禁第一轮就抓到一条"🏙️匹兹堡转租|The Julian 2b2b"混进了
// 东湾查询的结果里。温哥华/列治文同理，中文别名才是无歧义的那个。
const NON_BAY_LISTING_RE =
  /西雅图|seattle|纽约|new\s*york|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|\bucsd\b|\bucla\b|\bucsb\b|\bsdsu\b|尔湾|irvine|波士顿|boston|芝加哥|chicago|匹兹堡|\bpittsburgh\b|\bcmu\b|温哥华|vancouver|多伦多|toronto/i;

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

/** 严格谓词里可以单独放宽的约束维度（零结果时逐个试放宽，定位瓶颈）。 */
export type StrictField =
  | "near"
  | "city"
  | "rent"
  | "bedrooms"
  | "lease"
  | "moveIn"
  | "petFriendly"
  | "couplesOk"
  | "utilitiesIncluded"
  | "parkingIncluded";

const BOOL_FIELDS = [
  "petFriendly",
  "couplesOk",
  "utilitiesIncluded",
  "parkingIncluded",
] as const;

const FIELD_LABEL: Record<StrictField, string> = {
  near: "距离",
  city: "城市",
  rent: "预算",
  bedrooms: "房型",
  lease: "租期",
  moveIn: "入住时间",
  petFriendly: "宠物友好",
  couplesOk: "情侣入住",
  utilitiesIncluded: "包水电",
  parkingIncluded: "车位",
};

/**
 * The strict-match predicate for a QueryPlan — the SINGLE definition of "what
 * counts as a match", shared by the runtime search AND the eval harness
 * (scripts/search-eval.ts) so the two can never drift.
 *
 * The plan is built once by `planQuery` (lib/rental/query-plan.ts); this
 * function is pure and synchronous so the bottleneck loop below can re-run it
 * a dozen times for free.
 *
 * Enforcement stays 偏严格, not absolutist: only PROVABLE violations cut a row.
 * Unparsed fields are lenient (sparse columns are first backfilled from text
 * via withRecoveredFields); a listing that stays SILENT on a required boolean
 * is kept, not cut — silence is not a contradiction, same rule the verifier
 * uses. Out-of-Bay strays never surface. City and bedrooms are SETS: a user who
 * named three acceptable cities gets all three, which is the whole point of the
 * plan layer.
 *
 * Ranking relevance remains the reranker's job, never the filter's —
 * `plan.prefers` and `plan.anchors` deliberately have no effect here; they act
 * in rerankQueryFor and rankByPlanSignals instead.
 */
export function buildStrictPredicate(
  plan: QueryPlan,
  omit: StrictField | null = null
): {
  cities: string[];
  /** 实际生效的约束维度——零结果时逐个试放宽，定位瓶颈。 */
  active: StrictField[];
  matches: (row: XhsRentalSearchResultRow) => boolean;
} {
  const active: StrictField[] = [];
  if (plan.near && plan.radiusKm != null) {
    active.push("near");
  }
  if (plan.cities.length > 0) {
    active.push("city");
  }
  // 只有预算上限是硬约束。租客说"预算1500-1900"时，1500 是自我定位不是要求
  // ——一个 1300 的房源没有违反任何东西，把它筛掉纯属误杀（召回评测里
  // "养猫人 Emeryville" 那条就死在这上面）。下限留在计划里只影响排序。
  if (plan.rentMax != null) {
    active.push("rent");
  }
  if (plan.bedroomsAnyOf.length > 0) {
    active.push("bedrooms");
  }
  if (plan.leaseMonthsMin != null || plan.leaseMonthsMax != null) {
    active.push("lease");
  }
  if (plan.moveIn.kind !== "unknown") {
    active.push("moveIn");
  }
  for (const key of BOOL_FIELDS) {
    if (plan.requires[key] === true) {
      active.push(key);
    }
  }

  const kept = (f: StrictField): boolean => omit !== f;
  const near = kept("near") ? plan.near : null;
  const radiusKm = plan.radiusKm ?? 0;
  const cities = kept("city") ? plan.cities : [];
  const bedrooms = kept("bedrooms") ? plan.bedroomsAnyOf : [];
  const boolPrefs = {
    petFriendly: kept("petFriendly") ? plan.requires.petFriendly : null,
    couplesOk: kept("couplesOk") ? plan.requires.couplesOk : null,
    utilitiesIncluded: kept("utilitiesIncluded")
      ? plan.requires.utilitiesIncluded
      : null,
    parkingIncluded: kept("parkingIncluded")
      ? plan.requires.parkingIncluded
      : null,
  };
  // City, bedrooms and the booleans are set-valued or need a text fallback, so
  // they are checked here and nulled out of the rowViolates constraint set.
  const coreConstraints = {
    ...emptyConstraints(),
    rentMax: kept("rent") ? plan.rentMax : null,
    leaseMonthsMin: kept("lease") ? plan.leaseMonthsMin : null,
    leaseMonthsMax: kept("lease") ? plan.leaseMonthsMax : null,
    moveIn: kept("moveIn") ? plan.moveIn : { kind: "unknown" as const },
  };
  return {
    cities,
    active,
    matches: (raw) => {
      if (isNonRentalRow(raw) || listingOutOfBay(raw)) return false;
      const row = withRecoveredFields(raw);
      // 距离约束生效时**取代**城市约束，因为坐标比市界精确得多。
      // 定不出位置的房源在这里是剔除而不是放行——这不是"沉默"，用户问的就是
      // 位置，一条不说自己在哪的帖子无法成为"靠近X"的答案。与下面 rowInAnyCity
      // 对未知城市的处理是同一条规则。实测放行的后果是半张结果表被
      // "沙城95832雅房分租" 这种无坐标行占满。
      if (near) {
        const p = listingPoint(row);
        if (!p || haversineKm(p, near) > radiusKm) return false;
      }
      if (cities.length > 0 && !rowInAnyCity(row, cities)) return false;
      // Bedrooms: lenient when the listing's unit size is unknown (偏严格),
      // otherwise it must be one of the counts the user said they'd take.
      if (
        bedrooms.length > 0 &&
        row.bedroomsNum != null &&
        !bedrooms.includes(row.bedroomsNum)
      ) {
        return false;
      }
      if (rowViolates(row, coreConstraints)) return false;
      return satisfiesBooleanPrefs(row, boolPrefs);
    },
  };
}

/**
 * 零结果时"只放宽这一条就能匹配到的房源数"。用于如实告诉用户是哪个条件
 * 卡住了——绝不自动放宽、绝不用近似房源替代（严格契约不变）。
 */
type Bottleneck = { field: StrictField; label: string; wouldMatch: number };

type StrictSearchResult = {
  listings: XhsRentalSearchResultRow[];
  /** How many rows satisfied every requirement (before the ≤5 cut). */
  totalMatched: number;
  outOfBay: boolean;
  bottlenecks: Bottleneck[];
};

/**
 * Strict search: filter the whole pool by every voiced requirement, return the
 * top ≤5. Empty result means "数据库里没有" — the caller reports that honestly
 * instead of substituting a近似 listing.
 */
async function findStrictListings(
  query: string,
  plan: QueryPlan,
  blockTerms: string[]
): Promise<StrictSearchResult> {
  // The corpus only covers the Bay Area; a Seattle/NYC/Vancouver request
  // provably has no answer here. The plan layer decides this (it can read
  // "🇨🇦Richmond 列治文" as Vancouver, which no regex can); the regex check is
  // already folded into the plan as the fallback.
  if (plan.outOfScope) {
    return { listings: [], totalMatched: 0, outOfBay: true, bottlenecks: [] };
  }

  const { matches, active } = buildStrictPredicate(plan);

  // Pool: the most recent STRICT_POOL_LIMIT rows — the whole table today
  // (~750). All strictness is enforced in the app layer via the shared
  // predicate; SQL alias-matching is deliberately NOT used to narrow the pool,
  // because a listing whose `city` column is set but whose text never spells
  // the city name would be silently unreachable.
  const { results: pool } = await searchXhsRentalListings({
    limit: STRICT_POOL_LIMIT,
  });

  const matched = rankByPlanSignals(
    applyBlockTerms(pool.filter(matches), blockTerms),
    plan
  );

  // 零结果时定位瓶颈：逐个"只放宽这一条"重跑谓词，看各自能解锁多少房源。
  // 纯内存过滤（≤9 次 × ~800 行），无额外 LLM / DB 成本。让"没有房源"永远
  // 说得出原因——过严筛选不再静默失败。
  if (matched.length === 0) {
    const bottlenecks: Bottleneck[] = [];
    for (const field of active) {
      const relaxed = buildStrictPredicate(plan, field);
      const wouldMatch = applyBlockTerms(
        pool.filter(relaxed.matches),
        blockTerms
      ).length;
      if (wouldMatch > 0) {
        bottlenecks.push({ field, label: FIELD_LABEL[field], wouldMatch });
      }
    }
    bottlenecks.sort((a, b) => b.wouldMatch - a.wouldMatch);
    return { listings: [], totalMatched: 0, outOfBay: false, bottlenecks };
  }

  if (matched.length <= STRICT_BATCH_POOL) {
    return {
      listings: matched,
      totalMatched: matched.length,
      outOfBay: false,
      bottlenecks: [],
    };
  }

  // 超过一次缓存量 → 按相关度排序（有 Voyage 用 rerank，否则按最新）取 top-K。
  // rerank 的查询用 rerankQueryFor 富化：偏好（"最好有独卫"）进不了硬筛选，
  // 但必须在这里体现，否则用户说了等于没说。
  const pool2 = matched.slice(0, STRICT_RERANK_CAP);
  if (process.env.VOYAGE_API_KEY) {
    try {
      const topIndices = await rerankDocuments(
        rerankQueryFor(query, plan),
        pool2.map((r) => r.rawText),
        STRICT_BATCH_POOL
      );
      if (topIndices.length > 0) {
        return {
          listings: rankByPlanSignals(
            topIndices
              .map((i) => pool2[i])
              .filter((r): r is XhsRentalSearchResultRow => Boolean(r)),
            plan
          ),
          totalMatched: matched.length,
          outOfBay: false,
          bottlenecks: [],
        };
      }
    } catch (err) {
      console.error("[searchRental] strict rerank failed:", err);
    }
  }
  return {
    listings: matched.slice(0, STRICT_BATCH_POOL),
    totalMatched: matched.length,
    outOfBay: false,
    bottlenecks: [],
  };
}

/**
 * "继续/换一批"：从上一轮已排序、已终审的结果里切下一批。命中缓存时不查库、
 * 不调 LLM，且与已展示的房源天然不重复。缓存缺失/耗尽时返回 null，由调用方
 * 决定退回完整搜索还是如实告知没有更多。
 */
async function serveNextBatch(chatId: string, fingerprint: string) {
  const state = await loadBatchState(chatId);
  // 指纹不符 = 用户其实改了条件（模型仍传了 more）→ 不能续用旧排序，重新搜。
  if (!state || state.fingerprint !== fingerprint) {
    return null;
  }
  const batch = state.listings.slice(
    state.offset,
    state.offset + STRICT_MAX_RESULTS
  );
  if (batch.length === 0) {
    const shown = state.offset;
    return {
      listings: [],
      totalMatched: state.totalMatched,
      remainingInBatchCache: 0,
      action:
        `NO_MORE: 已按相关度展示完 ${shown} 个符合要求的房源` +
        (state.totalMatched > shown
          ? `（严格筛选共命中 ${state.totalMatched} 个，其余相关度较低）。如实告诉用户已展示完最相关的这些，建议补充或调整条件（预算/城市/房型/入住时间）再搜，以便挑出更贴近的房源。`
          : "，这就是数据库里全部符合要求的房源。如实告诉用户没有更多了，建议调整条件再搜。") +
        "不要重复展示已经给过的房源，也不要编造。",
    };
  }
  await saveBatchState(chatId, {
    ...state,
    offset: state.offset + batch.length,
  });
  const remaining = state.listings.length - (state.offset + batch.length);
  return {
    listings: batch,
    totalMatched: state.totalMatched,
    remainingInBatchCache: remaining,
    action:
      `SHOW_LISTINGS: 这是同一次搜索的下一批，共 ${batch.length} 个（与之前展示过的不重复）。` +
      "把 listings 数组里的每一个房源都完整展示出来（标准格式），不要遗漏、不要编造。" +
      (remaining > 0
        ? `展示完后告诉用户还可以继续说"继续"（还有 ${remaining} 个）。`
        : "这是最后一批，展示完告知用户已经没有更多了。"),
  };
}

/**
 * Strict-mode tool: returns a `listings` ARRAY (≤8 per batch) with no
 * relaxation. The calling chat model is the query-understanding layer: it
 * passes normalized structured constraints (city from neighborhood knowledge,
 * numeric budget, bedrooms, booleans) alongside the free-text query; regex NL
 * extraction only fills whatever it omits. "继续/换一批" is served from the
 * session batch cache (see serveNextBatch), never by re-searching.
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
      cities: z
        .array(z.string())
        .optional()
        .describe(
          "EVERY Bay Area city the user would accept, standardized English names, resolved with " +
            "your world knowledge: 'SOMA公寓' → ['San Francisco']; '在Moffett Park上班想住附近' → " +
            "['Sunnyvale']; '94583附近' → ['San Ramon']. " +
            "List ALL alternatives — 'Dublin优先，San Ramon也可以' → ['Dublin','San Ramon']. " +
            "Naming several cities is NOT a reason to omit: the tool ORs them together. " +
            "Omit only when the user named no location at all or only a broad region " +
            "(南湾/东湾/半岛/湾区), which the tool expands on its own."
        ),
      city: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Deprecated single-city form; prefer `cities`. Merged into it when both are given."
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
      bedroomsAnyOf: z
        .array(z.number().int())
        .optional()
        .describe(
          "EVERY unit bedroom count the user would accept (studio=0, 一室/1B1B=1, 两室/2B2B=2). " +
            "'想租2B2B里的一间' → [2]; '1b1b或studio都行' → [1,0]; '2b2b优先，2b1b、3b2b也可' → [2,3]. " +
            "OMIT when the alternatives include something a bedroom count cannot express " +
            "('Studio最优先，合租也行', '单间', '都可以') — an incomplete set filters out " +
            "listings the user would have taken. Omit too when they never mentioned unit size."
        ),
      bedroomsNum: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Deprecated single-value form; prefer `bedroomsAnyOf`. Merged into it when both are given."
        ),
      petFriendly: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true ONLY if the user needs pets allowed (有猫/养狗/宠物友好)."
        ),
      couplesOk: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true ONLY if the user needs couple occupancy (情侣/夫妻同住)."
        ),
      utilitiesIncluded: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true ONLY if the user requires utilities included (包水电)."
        ),
      parkingIncluded: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "true ONLY if the user REQUIRES parking (要车位/停车). " +
            "'最好有车位' is a preference — omit."
        ),
      leaseMonthsMin: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Minimum months the user intends to stay. '至少租半年'→6; '长租一年'→12; " +
            "bare '长租'→6; '短租3个月'→3 (set max too). Omit if unstated."
        ),
      leaseMonthsMax: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Maximum months the user can stay. '短租3个月'→3; bare '短租'→6; " +
            "'租期8月底到12月底'→4 (compute from the dates). Omit if open-ended."
        ),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a listing if found in its text (hard negative constraints). " +
            "Carry forward across turns. Include both Chinese and English variants."
        ),
      more: z
        .boolean()
        .optional()
        .describe(
          "true ONLY when the user asks for MORE of the same search ('继续', '换一批', " +
            "'还有吗', 'show me more') and the requirements have NOT changed. " +
            "Serves the next batch from the already-ranked result set instantly — " +
            "never repeats a listing already shown. If anything about the " +
            "requirements changed, omit it and pass the updated fields instead."
        ),
    }),
    execute: async ({ query, mustNotContain, more, ...params }) => {
      const startedAt = Date.now();
      try {
        const fingerprint = batchFingerprint(
          query,
          params,
          mustNotContain ?? []
        );

        // "继续/换一批"：直接从上一轮排好序、终审过的结果里切下一批。
        // 不查库、不调 LLM，且不可能与已展示的重复。指纹算在建计划之前，
        // 命中缓存时连理解层的 LLM 调用都省掉——"瞬间"是这条路径的全部意义。
        if (more) {
          const nextBatch = await serveNextBatch(chatId, fingerprint);
          if (nextBatch) {
            return nextBatch;
          }
          // 缓存缺失/过期，或条件其实变了 → 退回一次完整搜索。
        }

        // 理解层：自然语言 → 检索计划。聊天模型传的参数在这里覆盖计划。
        const plan = await planQuery(query, params);
        const blockTerms = [...(mustNotContain ?? []), ...plan.excludes]
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);
        console.log(
          "[searchRental] plan",
          JSON.stringify({
            query: query.slice(0, 120),
            plan: planSummary(plan),
            source: plan.source,
          })
        );

        // 用户说了"靠近X"但我们定位不到 X：**绝不假装知道**。上一次假装的
        // 代价是把 Palo Alto 的需求答成了 San Jose 的房源（Genesis AI）。
        // 照常搜一轮（总比空手好），但让聊天层如实说明并反问。
        if (plan.nearUnresolved) {
          console.log(
            "[searchRental] unresolved place",
            JSON.stringify({ place: plan.nearUnresolved })
          );
        }

        const result = await findStrictListings(query, plan, blockTerms);

        // 终审（路线 C）：一次 LLM 调用对读需求原文与候选原文，剔除言下之意
        // 矛盾的房源。只做减法、fail-open；剔除决策进 Vercel log 供人工复核。
        const { kept, cut } = await verifyListingsAgainstQuery(
          query,
          result.listings
        );
        if (cut.length > 0) {
          console.log(
            "[searchRental] verifier cut",
            JSON.stringify({ query, cut })
          );
        }

        // 留档（评测抽样数据源）；失败绝不影响搜索。见 legacy execute 内注释。
        const phase = result.outOfBay
          ? "STRICT_OUT_OF_BAY"
          : kept.length > 0
            ? "STRICT_MATCH"
            : cut.length > 0
              ? "STRICT_VERIFIER_EMPTY"
              : "STRICT_EMPTY";
        scheduleAfterResponse(() =>
          logSearchQuery({
            chatId,
            query,
            mustNotContain: mustNotContain ?? null,
            phase,
            listingId: kept[0]?.id ?? null,
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
            verifierCutCount: 0,
            action:
              "OUT_OF_BAY: 用户找的地方不在湾区" +
              (plan.outOfScopeReason ? `（${plan.outOfScopeReason}）` : "") +
              "。如实告知：我们目前只收录旧金山湾区的房源，该地区暂无数据。不要展示任何房源。",
          };
        }

        // 终审剔空：硬性条件其实筛出了房源，是逐条复核后发现都与需求矛盾。
        // 把理由如实交给模型转述，否则用户只看到"没有"，误以为库里没数据。
        if (kept.length === 0 && result.listings.length > 0) {
          return {
            listings: [],
            totalMatched: result.totalMatched,
            verifierCutCount: cut.length,
            cutReasons: cut.map((c) => ({ title: c.title, reason: c.reason })),
            action:
              `NO_MATCH: 有 ${result.totalMatched} 个房源通过了硬性条件（城市/预算/房型/租期等），` +
              "但逐条复核后发现都与用户要求矛盾。绝不要展示这些房源。如实告诉用户没有完全符合的，" +
              "并用 cutReasons 里的理由具体说明它们分别卡在哪（如超预算、只出租合租房里的一间、限男生），" +
              "再问用户是否愿意放宽相应要求。",
          };
        }

        if (kept.length === 0) {
          // 瓶颈是算出来的事实，不是让模型猜：直接告诉它放宽哪一条能解锁多少
          // 房源。仍然不返回任何近似房源——严格契约不变。
          const hint = result.bottlenecks
            .map((b) => `放宽「${b.label}」→ ${b.wouldMatch} 个`)
            .join("；");
          if (result.bottlenecks.length > 0) {
            console.log(
              "[searchRental] no match, bottlenecks",
              JSON.stringify({ query, bottlenecks: result.bottlenecks })
            );
          }
          return {
            listings: [],
            totalMatched: 0,
            verifierCutCount: cut.length,
            bottlenecks: result.bottlenecks,
            action:
              (plan.nearUnresolved
                ? `LOCATION_UNKNOWN: 另外，系统查不到「${plan.nearUnresolved}」在哪，先问用户它属于哪个城市或给个地址/邮编，再重搜。
`
                : "") +
              "NO_MATCH: 数据库中没有完全符合用户全部要求的房源。如实告诉用户没有找到，绝不要用近似房源代替。" +
              (hint
                ? `已算出各条件的松紧程度（${hint}）——据此明确告诉用户是哪个条件卡住了、放宽后大约有多少房源，并询问是否要放宽它再搜。`
                : "建议用户调整条件后再搜。"),
          };
        }

        // 整份终审结果存进会话缓存，本轮只展示第一批；"继续/换一批" 从这里
        // 顺序切下去，不会重复也不必重搜。
        const batch = kept.slice(0, STRICT_MAX_RESULTS);
        await saveBatchState(chatId, {
          fingerprint,
          query,
          listings: kept,
          offset: batch.length,
          totalMatched: result.totalMatched,
        });

        return {
          listings: batch,
          totalMatched: result.totalMatched,
          remainingInBatchCache: kept.length - batch.length,
          verifierCutCount: cut.length,
          action:
            (plan.nearUnresolved
              ? `LOCATION_UNKNOWN: 用户要求靠近「${plan.nearUnresolved}」，但系统查不到这个地点的位置，` +
                "下面这批只是按其它条件筛的，**距离没有保证**。展示前先如实说明这一点，" +
                "并请用户补充它在哪个城市、或给个地址/邮编，然后重新搜索。 "
              : "") +
            `SHOW_LISTINGS: 找到 ${batch.length} 个严格符合要求的房源` +
            (result.totalMatched > batch.length
              ? `（共 ${result.totalMatched} 个通过硬性筛选，已按相关度与复核排序）`
              : "") +
            "。把 listings 数组里的每一个房源都完整展示出来（标准格式），不要遗漏、不要编造。" +
            (kept.length > batch.length
              ? `展示完后告诉用户还可以说"继续"看下一批（还有 ${kept.length - batch.length} 个已备好）。`
              : ""),
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
