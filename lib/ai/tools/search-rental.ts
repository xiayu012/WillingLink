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
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import {
  checkMoveInFeasibility,
  extractQueryDate,
  parseFlexibleDate,
} from "@/lib/rental/date-availability";
import { getSeenListingIds, markListingAsSeen } from "@/lib/db/seen-listings";
import {
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";

// ── Constants ─────────────────────────────────────────────────────────────────

const VECTOR_CANDIDATES = 50;   // pgvector top-N before rerank
const LAST_RESORT_LIMIT = 50;   // wider pool for Phase 4 last-resort rerank

// ── City table ────────────────────────────────────────────────────────────────

type CityEntry = {
  re: RegExp;
  en: string;
  zh: string;
  neighbors: string[];  // ≤3 adjacent cities to append to the query vector
};

const CITY_TABLE: CityEntry[] = [
  { re: /圣何塞|San\s*Jose/i,             en: "San Jose",       zh: "圣何塞",    neighbors: ["Santa Clara", "Milpitas", "Sunnyvale"] },
  { re: /旧金山|三藩市|San\s*Francisco/i,  en: "San Francisco",  zh: "旧金山",    neighbors: ["Daly City", "South San Francisco", "Oakland"] },
  { re: /伯克利|Berkeley/i,               en: "Berkeley",       zh: "伯克利",    neighbors: ["Oakland", "Albany", "Emeryville"] },
  { re: /奥克兰|Oakland/i,                en: "Oakland",        zh: "奥克兰",    neighbors: ["Berkeley", "Emeryville", "San Leandro"] },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, en: "Palo Alto",    zh: "帕洛阿尔托", neighbors: ["Menlo Park", "Mountain View", "Los Altos"] },
  { re: /山景城|Mountain\s*View/i,        en: "Mountain View",  zh: "山景城",    neighbors: ["Sunnyvale", "Palo Alto", "Los Altos"] },
  { re: /桑尼维尔|Sunnyvale/i,            en: "Sunnyvale",      zh: "桑尼维尔",   neighbors: ["Santa Clara", "Mountain View", "Cupertino"] },
  { re: /弗里蒙特|Fremont/i,              en: "Fremont",        zh: "弗里蒙特",   neighbors: ["Newark", "Union City", "Milpitas"] },
  { re: /圣克拉拉|Santa\s*Clara/i,        en: "Santa Clara",    zh: "圣克拉拉",   neighbors: ["Sunnyvale", "San Jose", "Cupertino"] },
  { re: /戴利城|Daly\s*City/i,            en: "Daly City",      zh: "戴利城",    neighbors: ["San Francisco", "South San Francisco", "Colma"] },
  { re: /库比蒂诺|Cupertino/i,            en: "Cupertino",      zh: "库比蒂诺",   neighbors: ["Sunnyvale", "Santa Clara", "Saratoga"] },
  { re: /圣马特奥|San\s*Mateo/i,          en: "San Mateo",      zh: "圣马特奥",   neighbors: ["Foster City", "Burlingame", "Redwood City"] },
  { re: /红木城|Redwood\s*City/i,         en: "Redwood City",   zh: "红木城",    neighbors: ["San Carlos", "Menlo Park", "San Mateo"] },
  { re: /圣克鲁斯|Santa\s*Cruz/i,         en: "Santa Cruz",     zh: "圣克鲁斯",   neighbors: ["Capitola", "Scotts Valley", "Aptos"] },
];

function detectCity(query: string): CityEntry | null {
  for (const entry of CITY_TABLE) {
    if (entry.re.test(query)) return entry;
  }
  return null;
}

// ── Geo-expansion (deterministic, no LLM) ────────────────────────────────────
// Replaces any Chinese city name with its English form and appends ≤3 neighbors.
// Keeps query vectors meaningfully distinct across cities while still matching
// listings that only mention a neighboring city.

function lightGeoExpand(query: string, city: CityEntry): string {
  const withEn = query.replace(city.re, city.en);
  const neighborStr = city.neighbors.join(" ");
  return `${withEn} ${neighborStr}`;
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

  // No reranker: random pick from first 3
  const pool = candidates.slice(0, Math.min(3, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Main search cascade ───────────────────────────────────────────────────────

type CascadeResult = {
  listing: XhsRentalSearchResultRow;
  relaxedNote: string | null;
} | null;

async function findNextListing(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<CascadeResult> {
  const city = detectCity(query);
  const expandedQuery = city ? lightGeoExpand(query, city) : query;

  // Move-in feasibility: a tenant can only move in ON or AFTER a unit's
  // available-from date. When the query voices a move-in date, drop listings
  // that only become available later. No-op when the query has no date.
  const desiredMoveIn = extractQueryDate(query);
  const dateFeasible = (
    rows: XhsRentalSearchResultRow[]
  ): XhsRentalSearchResultRow[] => {
    if (desiredMoveIn.kind === "unknown") return rows;
    return rows.filter(
      (r) =>
        checkMoveInFeasibility(
          parseFlexibleDate(r.availableFrom),
          desiredMoveIn
        ) !== "infeasible"
    );
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Phase 1 — Vector search (semantic, best quality)
  // Uses geo-expanded query so neighbor-city listings are reachable.
  // ═══════════════════════════════════════════════════════════════════════════

  const vectorCandidates = dateFeasible(
    await vectorSearch(expandedQuery, excludeIds)
  );

  // 1a: vector candidates that pass the block filter
  const vectorStrict = applyBlockFilter(vectorCandidates, blockTerms);
  if (vectorStrict.length > 0) {
    return { listing: await pickBest(query, vectorStrict), relaxedNote: null };
  }

  // 1b: block filter is the only obstacle — relax it, keep semantic candidates
  if (blockTerms.length > 0 && vectorCandidates.length > 0) {
    return {
      listing: await pickBest(query, vectorCandidates),
      relaxedNote: "找不到完全符合要求的房源，已放宽部分限制条件，为您找到以下最相近的房源",
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
    const cityUnseen = dateFeasible(filterExcluded(cityRows, excludeIds));

    // 2a: strict
    const cityStrict = applyBlockFilter(cityUnseen, blockTerms);
    if (cityStrict.length > 0) {
      return {
        listing: await pickBest(query, cityStrict),
        relaxedNote: null,
      };
    }

    // 2b: relaxed (drop block filter)
    if (cityUnseen.length > 0) {
      return {
        listing: await pickBest(query, cityUnseen),
        relaxedNote: `找不到完全匹配的房源，已在${city.zh}范围内为您找到以下房源`,
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
    const kwUnseen = dateFeasible(filterExcluded(kwRows, excludeIds));

    // 3a: strict
    const kwStrict = applyBlockFilter(kwUnseen, blockTerms);
    if (kwStrict.length > 0) {
      return {
        listing: await pickBest(query, kwStrict),
        relaxedNote: "找不到精确匹配的房源，已按关键词扩大搜索，为您找到以下房源",
      };
    }

    // 3b: relaxed
    if (kwUnseen.length > 0) {
      return {
        listing: await pickBest(query, kwUnseen),
        relaxedNote: "找不到精确匹配的房源，已扩大搜索范围并放宽限制条件",
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
  const remaining = dateFeasible(filterExcluded(recentRows, excludeIds));
  if (remaining.length > 0) {
    return {
      listing: await pickBest(query, remaining),
      relaxedNote: "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
    };
  }

  // Date-relaxed fallback: the tenant gave a move-in date but nothing is
  // available by then. Rather than dead-ending, surface the closest recent
  // listing and clearly warn that its start date is later.
  if (desiredMoveIn.kind !== "unknown") {
    const dateRelaxed = filterExcluded(recentRows, excludeIds);
    if (dateRelaxed.length > 0) {
      return {
        listing: await pickBest(query, dateRelaxed),
        relaxedNote:
          "没有在您期望入住时间之前起租的房源；以下房源起租时间可能更晚，请留意入住时间是否合适。",
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
      try {
        const excludeIds = await getSeenListingIds(chatId);
        const blockTerms = (mustNotContain ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);

        const result = await findNextListing(query, excludeIds, blockTerms);

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
