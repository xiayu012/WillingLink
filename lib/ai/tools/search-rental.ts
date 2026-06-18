/**
 * searchRental tool — semantic + keyword search over XhsRentalListing.
 *
 * Search cascade (stops at first hit, always respects excludeIds):
 *
 *   S0  Vector search with LIGHT geo-expansion, block filter applied
 *   S1  Same vector candidates, block filter dropped
 *   S2  Vector search with ORIGINAL (unexpanded) query, block filter applied
 *   S3  ILIKE keyword fallback on city/location, block filter dropped
 *   S4  Full-text rawText keyword scan (all terms from query), excludeIds applied
 *   null → truly exhausted
 *
 * Key design decisions:
 * - geo-expansion is kept LIGHT (≤3 neighbors) to avoid homogenising query vectors
 * - pickBest uses topK=3 + random-weighted selection to add variety
 * - S4 uses actual text keywords extracted from the query, NOT a fixed 20-row dump
 * - excludeIds is server-managed via Redis/in-memory; LLM never touches it
 */

import { generateText, tool } from "ai";
import { z } from "zod";
import { gateway } from "@ai-sdk/gateway";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { getSeenListingIds, markListingAsSeen } from "@/lib/db/seen-listings";
import {
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";

const VECTOR_CANDIDATES = 50;

// ── City patterns (Chinese ↔ English) ─────────────────────────────────────────

const CITY_PATTERNS: Array<{ re: RegExp; en: string; zh: string; neighbors: string[] }> = [
  {
    re: /圣何塞|San\s*Jose/i,
    en: "San Jose", zh: "圣何塞",
    neighbors: ["Santa Clara", "Milpitas", "Sunnyvale"],
  },
  {
    re: /旧金山|三藩市|San\s*Francisco/i,
    en: "San Francisco", zh: "旧金山",
    neighbors: ["Daly City", "South San Francisco", "Oakland"],
  },
  {
    re: /伯克利|Berkeley/i,
    en: "Berkeley", zh: "伯克利",
    neighbors: ["Oakland", "Albany", "Emeryville"],
  },
  {
    re: /奥克兰|Oakland/i,
    en: "Oakland", zh: "奥克兰",
    neighbors: ["Berkeley", "Emeryville", "San Leandro"],
  },
  {
    re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i,
    en: "Palo Alto", zh: "帕洛阿尔托",
    neighbors: ["Menlo Park", "Mountain View", "Los Altos"],
  },
  {
    re: /山景城|Mountain\s*View/i,
    en: "Mountain View", zh: "山景城",
    neighbors: ["Sunnyvale", "Palo Alto", "Los Altos"],
  },
  {
    re: /桑尼维尔|Sunnyvale/i,
    en: "Sunnyvale", zh: "桑尼维尔",
    neighbors: ["Santa Clara", "Mountain View", "Cupertino"],
  },
  {
    re: /弗里蒙特|Fremont/i,
    en: "Fremont", zh: "弗里蒙特",
    neighbors: ["Newark", "Union City", "Milpitas"],
  },
  {
    re: /圣克拉拉|Santa\s*Clara/i,
    en: "Santa Clara", zh: "圣克拉拉",
    neighbors: ["Sunnyvale", "San Jose", "Cupertino"],
  },
  {
    re: /戴利城|Daly\s*City/i,
    en: "Daly City", zh: "戴利城",
    neighbors: ["San Francisco", "South San Francisco", "Colma"],
  },
  {
    re: /库比蒂诺|Cupertino/i,
    en: "Cupertino", zh: "库比蒂诺",
    neighbors: ["Sunnyvale", "Santa Clara", "Saratoga"],
  },
  {
    re: /圣马特奥|San\s*Mateo/i,
    en: "San Mateo", zh: "圣马特奥",
    neighbors: ["Foster City", "Burlingame", "Redwood City"],
  },
  {
    re: /红木城|Redwood\s*City/i,
    en: "Redwood City", zh: "红木城",
    neighbors: ["San Carlos", "Menlo Park", "San Mateo"],
  },
  {
    re: /圣克鲁斯|Santa\s*Cruz/i,
    en: "Santa Cruz", zh: "圣克鲁斯",
    neighbors: ["Capitola", "Scotts Valley", "Aptos"],
  },
];

function detectCity(query: string): (typeof CITY_PATTERNS)[0] | null {
  for (const p of CITY_PATTERNS) {
    if (p.re.test(query)) return p;
  }
  return null;
}

// ── Light geo-expansion ────────────────────────────────────────────────────────
// Unlike the old LLM-based expansion that ballooned queries and homogenised
// all embeddings, this is purely deterministic: we append ≤3 nearest neighbors
// from a local lookup table.  The original query text is preserved verbatim.
//
// This keeps query vectors distinct while still helping when a user says
// "Sunnyvale" and a matching listing only mentions "Mountain View".

function lightGeoExpand(query: string): string {
  const city = detectCity(query);
  if (!city) return query;
  // Replace Chinese city name with English so Voyage embeds it correctly
  const withEn = query.replace(city.re, city.en);
  // Append up to 3 neighbors as additional context
  const neighborStr = city.neighbors.slice(0, 3).join(" ");
  return `${withEn} ${neighborStr}`;
}

// ── Extract plain keywords from a query ───────────────────────────────────────
// Used for S4: pull out English/Chinese words that are likely meaningful
// (location names, room types, budget keywords).

function extractKeywords(query: string): string[] {
  const city = detectCity(query);
  const words: string[] = [];

  if (city) {
    words.push(city.en);
    // Also push the Chinese form if present
    if (city.zh && query.includes(city.zh)) words.push(city.zh);
  }

  // Common Chinese rental keywords to scan for
  const chKeywords = [
    "主卧", "次卧", "studio", "整租", "合租", "转租", "sublease",
    "宠物", "pet", "情侣", "couples", "水电", "utilities",
    "停车", "parking", "家具", "furnished",
  ];
  for (const kw of chKeywords) {
    if (query.toLowerCase().includes(kw.toLowerCase())) words.push(kw);
  }

  // Pull out numbers that might be bedrooms (1BR, 2室, etc.)
  const bedroomMatch = query.match(/(\d)\s*(?:br|bed|室|卧|房)/i);
  if (bedroomMatch) words.push(bedroomMatch[0]);

  return [...new Set(words)].filter((w) => w.length > 0);
}

// ── Vector search ──────────────────────────────────────────────────────────────

async function vectorSearch(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  if (!process.env.VOYAGE_API_KEY) return [];
  try {
    const vec = await embedText(query, "query");
    return await vectorSearchXhsRentalListings(vec, VECTOR_CANDIDATES, excludeIds);
  } catch (err) {
    console.error("[searchRental] Vector search failed:", err);
    return [];
  }
}

// ── Block-term filter ──────────────────────────────────────────────────────────

function applyBlockFilter(
  rows: XhsRentalSearchResultRow[],
  blockTerms: string[]
): XhsRentalSearchResultRow[] {
  if (blockTerms.length === 0) return rows;
  return rows.filter(
    (r) => !blockTerms.some((term) => r.rawText.toLowerCase().includes(term))
  );
}

// ── Pick best with diversity ───────────────────────────────────────────────────
// Uses Voyage reranker with topK=3, then randomly picks from the top-3
// weighted by rank (rank 1 = 3 chances, rank 2 = 2 chances, rank 3 = 1 chance).
// This adds meaningful variety while still biasing toward the best match.

async function pickBest(
  query: string,
  candidates: XhsRentalSearchResultRow[]
): Promise<XhsRentalSearchResultRow> {
  if (candidates.length === 1) return candidates[0];

  if (process.env.VOYAGE_API_KEY && candidates.length > 1) {
    try {
      const texts = candidates.map((c) => c.rawText);
      const topK = Math.min(3, candidates.length);
      const topIndices = await rerankDocuments(query, texts, topK);

      if (topIndices.length > 0) {
        // Weighted random: weights [3,2,1] for ranks [0,1,2]
        const weights = topIndices.map((_, i) => topK - i);
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let rnd = Math.random() * totalWeight;
        for (let i = 0; i < topIndices.length; i++) {
          rnd -= weights[i];
          if (rnd <= 0) {
            return candidates[topIndices[i]] ?? candidates[0];
          }
        }
        return candidates[topIndices[0]] ?? candidates[0];
      }
    } catch {
      // reranker failure → fall through to candidates[0]
    }
  }

  // No reranker: random pick from first 3 to still get some variety
  const pool = candidates.slice(0, Math.min(3, candidates.length));
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Unified search cascade ────────────────────────────────────────────────────
//
// Every level explicitly passes excludeIds to avoid returning seen listings.
// The cascade stops as soon as any level returns at least one candidate.

async function findNextListing(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<{ listing: XhsRentalSearchResultRow; relaxedNote: string | null } | null> {
  const expanded = lightGeoExpand(query);

  // ── S0: vector on geo-expanded query, with block filter ───────────────────
  const vectorCandidates = await vectorSearch(expanded, excludeIds);
  const strictCandidates = applyBlockFilter(vectorCandidates, blockTerms);

  if (strictCandidates.length > 0) {
    return { listing: await pickBest(query, strictCandidates), relaxedNote: null };
  }

  // ── S1: same vector candidates, drop block filter ─────────────────────────
  if (blockTerms.length > 0 && vectorCandidates.length > 0) {
    return {
      listing: await pickBest(query, vectorCandidates),
      relaxedNote:
        "找不到完全符合要求的房源，已放宽部分限制条件，为您找到以下最相近的房源",
    };
  }

  // ── S2: vector on ORIGINAL (unexpanded) query, drop block filter ──────────
  // Re-embed with the raw query to catch listings not containing neighbor names.
  if (expanded !== query) {
    const rawVec = await vectorSearch(query, excludeIds);
    const rawStrict = applyBlockFilter(rawVec, blockTerms);
    if (rawStrict.length > 0) {
      return { listing: await pickBest(query, rawStrict), relaxedNote: null };
    }
    if (rawVec.length > 0) {
      return {
        listing: await pickBest(query, rawVec),
        relaxedNote: "已放宽部分限制条件，为您找到以下最相近的房源",
      };
    }
  }

  // ── S3: ILIKE keyword fallback on city / location ─────────────────────────
  const city = detectCity(query);
  if (city) {
    const { results: cityResults } = await searchXhsRentalListings({
      locationText: city.en,
    });
    const cityFiltered = cityResults.filter((r) => !excludeIds.includes(r.id));
    if (cityFiltered.length > 0) {
      return {
        listing: await pickBest(query, cityFiltered),
        relaxedNote: `暂无完全匹配的房源，已在${city.zh}范围内为您找到以下房源`,
      };
    }
  }

  // ── S4: full-text keyword scan on extracted terms ─────────────────────────
  // Use meaningful keywords from the query rather than fetching a fixed 20-row dump.
  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    const { results: kwResults } = await searchXhsRentalListings({ keywords });
    const kwFiltered = kwResults.filter((r) => !excludeIds.includes(r.id));
    if (kwFiltered.length > 0) {
      return {
        listing: await pickBest(query, kwFiltered),
        relaxedNote: "找不到完全匹配的房源，已扩大搜索范围，为您找到以下最相近的房源",
      };
    }
  }

  // ── S5: last resort — any unseen listing, ordered by recency ─────────────
  const { results: allRecent } = await searchXhsRentalListings({});
  const remaining = allRecent.filter((r) => !excludeIds.includes(r.id));
  if (remaining.length > 0) {
    return {
      listing: await pickBest(query, remaining),
      relaxedNote: "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
    };
  }

  return null;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Call once per request with the current chatId.
 * The tool automatically deduplicates across all turns — the LLM never needs
 * to track or pass excludeIds; just call with the same query on every "换一个".
 */
export function createSearchRentalTool(chatId: string) {
  return tool({
    description:
      "Semantic search over the XhsRentalListing database. " +
      "Call this for ANY housing/rental request — first searches AND every '换一个'/'next'/'不满意'. " +
      "Returns ONE listing the user has not yet seen this session. " +
      "If no exact match exists, the tool automatically relaxes criteria and returns the closest available listing. " +
      "Never skip calling this tool; the server handles deduplication automatically.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Full natural language search request with ALL accumulated context from the conversation. " +
            "Carry forward location, budget, bedrooms, move-in date, requirements from prior turns. " +
            "Example: '圣何塞两室一厅，预算2500以下，宠物友好，情侣入住'"
        ),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a listing if found in its rawText. " +
            "Carry forward across turns. Examples:\n" +
            "- User wants couples/family → ['仅限一人', '单人', 'one person only', '一人入住']\n" +
            "- User wants landlord posts only → ['求组', '找室友', '合租找人', '拼租', '招室友']\n" +
            "- User wants no agent → ['中介', 'agent fee', '佣金']\n" +
            "Include both Chinese and English variants."
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
          const msg =
            excludeIds.length > 0
              ? "NO_MORE: 已经没有更多符合要求的房源了。告诉用户可以调整筛选条件再试，或放宽某些限制。"
              : "NO_RESULTS: 数据库暂时没有可推荐的房源，请稍后再试。";
          return { listing: null, relaxedNote: null, action: msg };
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
              "For subsequent '换一个' requests: call searchRental again with the SAME query.",
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
        console.error("[searchRental] tool failed:", error);
        return {
          listing: null,
          relaxedNote: null,
          action:
            "SEARCH_FAILED: Tell the user the search service hit a temporary error and ask them to retry in a moment.",
        };
      }
    },
  });
}
