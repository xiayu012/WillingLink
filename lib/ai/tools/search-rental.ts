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
 */

import { tool } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { type CityEntry, detectCity } from "@/lib/rental/cities";
import {
  applyHardConstraints,
  extractHardConstraints,
  hasAnyConstraint,
} from "@/lib/rental/query-constraints";
import { getSeenListingIds, markListingAsSeen } from "@/lib/db/seen-listings";
import {
  logSearchQuery,
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";

// ── Constants ─────────────────────────────────────────────────────────────────

const VECTOR_CANDIDATES = 50;   // pgvector top-N before rerank
const LAST_RESORT_LIMIT = 50;   // wider pool for Phase 4 last-resort rerank

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
  "主卧", "次卧", "客卧",
  "studio", "整租", "合租", "转租", "sublease",
  "宠物", "pet",
  "情侣", "couples",
  "水电", "utilities",
  "停车", "parking",
  "家具", "furnished",
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
    return await vectorSearchXhsRentalListings(vec, VECTOR_CANDIDATES, excludeIds);
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
        const weights = topIndices.map((_, i) => topK - i);  // [3, 2, 1]
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

  const vectorCandidates = constrained(
    await vectorSearch(expandedQuery, excludeIds)
  );

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
      relaxedNote: "找不到完全符合要求的房源，已放宽部分限制条件，为您找到以下最相近的房源",
      phase: "P1_VECTOR_RELAXED",
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 2 — City keyword search
  // Only runs if the query mentions a known Bay Area city.
  // Searches rawText + locationText + title for the city name.
  // ═══════════════════════════════════════════════════════════════════════════

  if (city) {
    const { results: cityRows } = await searchXhsRentalListings({
      keywords: [city.en],
    });
    const cityUnseen = constrained(filterExcluded(cityRows, excludeIds));

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
        relaxedNote: "找不到精确匹配的房源，已按关键词扩大搜索，为您找到以下房源",
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
  const remaining = constrained(filterExcluded(recentRows, excludeIds));
  if (remaining.length > 0) {
    return {
      listing: await pickBest(query, remaining),
      relaxedNote: "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
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

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Create the searchRental tool bound to a specific chatId.
 * Call once per chat request; the tool reads/writes seen-listing state
 * automatically so the LLM never needs to track excludeIds.
 */
export function createSearchRentalTool(chatId: string) {
  return tool({
    description:
      "Semantic search over the XhsRentalListing database. " +
      "Call this for ANY housing/rental request — first searches AND every '换一个'/'next'/'不满意'. " +
      "Returns ONE listing the user has not yet seen this session. " +
      "If no exact match, the tool automatically relaxes criteria and returns the closest available listing. " +
      "Never skip calling this; the server handles deduplication automatically.",
    inputSchema: z.object({
      query: z.string().describe(
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
        after(() =>
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
          action: "SEARCH_FAILED: Tell the user the search hit a temporary error and ask them to retry.",
        };
      }
    },
  });
}
