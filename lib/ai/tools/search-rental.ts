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

const CITY_PATTERNS: Array<{ re: RegExp; en: string; zh: string }> = [
  { re: /圣何塞|San\s*Jose/i,             en: "San Jose",      zh: "圣何塞" },
  { re: /旧金山|三藩市|San\s*Francisco/i,  en: "San Francisco", zh: "旧金山" },
  { re: /伯克利|Berkeley/i,               en: "Berkeley",      zh: "伯克利" },
  { re: /奥克兰|Oakland/i,                en: "Oakland",       zh: "奥克兰" },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, en: "Palo Alto",   zh: "帕洛阿尔托" },
  { re: /山景城|Mountain\s*View/i,        en: "Mountain View", zh: "山景城" },
  { re: /桑尼维尔|Sunnyvale/i,            en: "Sunnyvale",     zh: "桑尼维尔" },
  { re: /弗里蒙特|Fremont/i,              en: "Fremont",       zh: "弗里蒙特" },
  { re: /圣克拉拉|Santa\s*Clara/i,        en: "Santa Clara",   zh: "圣克拉拉" },
  { re: /戴利城|Daly\s*City/i,            en: "Daly City",     zh: "戴利城" },
  { re: /库比蒂诺|Cupertino/i,            en: "Cupertino",     zh: "库比蒂诺" },
  { re: /圣马特奥|San\s*Mateo/i,          en: "San Mateo",     zh: "圣马特奥" },
  { re: /红木城|Redwood\s*City/i,         en: "Redwood City",  zh: "红木城" },
  { re: /圣克鲁斯|Santa\s*Cruz/i,         en: "Santa Cruz",    zh: "圣克鲁斯" },
];

function detectCity(query: string): { en: string; zh: string } | null {
  for (const p of CITY_PATTERNS) {
    if (p.re.test(query)) return { en: p.en, zh: p.zh };
  }
  return null;
}

// ── LLM geo-expansion ─────────────────────────────────────────────────────────
// Rewrites the query to include neighboring cities / landmarks before embedding.
// Costs ~80 tokens; falls back to original on any failure.

async function geoExpandQuery(query: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: gateway.languageModel("anthropic/claude-haiku-4.5"),
      system:
        "You are a Bay Area rental geography expert. " +
        "Rewrite the given rental search query into a single rich English search string. " +
        "Rules:\n" +
        "- Expand geographic terms: include the original place PLUS immediate neighbors " +
        "(Sunnyvale → add Mountain View, Santa Clara, Cupertino; " +
        "San Jose → add Santa Clara, Milpitas, Campbell, Sunnyvale; " +
        "Palo Alto → add Menlo Park, Mountain View, Stanford area)\n" +
        "- Replace Chinese city names with English (圣何塞→San Jose, 旧金山→San Francisco, etc.)\n" +
        "- If a school/company is mentioned, add its city " +
        "(Stanford→Palo Alto, Apple→Cupertino, Google→Mountain View, Meta→Menlo Park)\n" +
        "- Preserve non-geographic parts (bedrooms, budget, requirements) unchanged\n" +
        "- Return ONLY the rewritten query, no explanation, no quotes",
      prompt: query,
      maxOutputTokens: 120,
    });
    return text.trim() || query;
  } catch {
    return query;
  }
}

// ── Vector search with geo-expanded query ─────────────────────────────────────

async function vectorSearch(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  if (!process.env.VOYAGE_API_KEY) return [];
  try {
    const expandedQuery = await geoExpandQuery(query);
    const vec = await embedText(expandedQuery, "query");
    return await vectorSearchXhsRentalListings(vec, VECTOR_CANDIDATES, excludeIds);
  } catch (err) {
    console.error("Vector search failed:", err);
    return [];
  }
}

// ── ILIKE keyword fallback ────────────────────────────────────────────────────

async function keywordSearch(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  const city = detectCity(query);
  const { results } = await searchXhsRentalListings({
    locationText: city?.en ?? query.trim().slice(0, 80),
  });
  return results.filter((r) => !excludeIds.includes(r.id));
}

// ── Rerank / pick best ────────────────────────────────────────────────────────

async function pickBest(
  query: string,
  candidates: XhsRentalSearchResultRow[]
): Promise<XhsRentalSearchResultRow> {
  if (process.env.VOYAGE_API_KEY && candidates.length > 1) {
    try {
      const texts = candidates.map((c) => c.rawText);
      const [bestIdx] = await rerankDocuments(query, texts, 1);
      return candidates[bestIdx] ?? candidates[0];
    } catch {
      // ignore rerank failure
    }
  }
  return candidates[0];
}

// ── Block-term filter ─────────────────────────────────────────────────────────

function applyBlockFilter(
  rows: XhsRentalSearchResultRow[],
  blockTerms: string[]
): XhsRentalSearchResultRow[] {
  if (blockTerms.length === 0) return rows;
  return rows.filter(
    (r) => !blockTerms.some((term) => r.rawText.toLowerCase().includes(term))
  );
}

// ── Unified search cascade ────────────────────────────────────────────────────
//
// Called on EVERY tool invocation, whether it is a first search or a "换一个".
// Always respects excludeIds so the same listing is never shown twice per chat.
//
// Strategy waterfall (stops at first hit):
//   S0  Strict  — vector+geo-expand, block filter applied, excludeIds applied
//   S1  No-block — same vector results, block filter dropped (relax hard constraint)
//   S2  ILIKE fallback — keyword search, no block filter, excludeIds applied
//   S3  City-broad — city-level search with geo-expand, no block filter, excludeIds applied
//   S4  Latest DB — fetch all latest listings, pick best by rerank, excludeIds applied
//   null → truly exhausted

async function findNextListing(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<{ listing: XhsRentalSearchResultRow; relaxedNote: string | null } | null> {
  // ── S0: strict vector search + block filter ──────────────────────────────
  const vectorCandidates = await vectorSearch(query, excludeIds);
  const strictCandidates = applyBlockFilter(vectorCandidates, blockTerms);

  if (strictCandidates.length > 0) {
    return { listing: await pickBest(query, strictCandidates), relaxedNote: null };
  }

  // ── S1: same vector results, drop block filter ───────────────────────────
  // (Re-use vectorCandidates — no extra search needed)
  if (blockTerms.length > 0 && vectorCandidates.length > 0) {
    return {
      listing: await pickBest(query, vectorCandidates),
      relaxedNote:
        '找不到完全符合要求的房源，已放宽硬性排除条件（如"仅限一人"等限制），为您找到以下最相近的房源',
    };
  }

  // ── S2: ILIKE keyword fallback (vector unavailable or empty) ────────────
  const keywordCandidates = await keywordSearch(query, excludeIds);
  const keywordStrict = applyBlockFilter(keywordCandidates, blockTerms);
  if (keywordStrict.length > 0) {
    return { listing: await pickBest(query, keywordStrict), relaxedNote: null };
  }
  if (keywordCandidates.length > 0) {
    return {
      listing: await pickBest(query, keywordCandidates),
      relaxedNote: "已放宽部分限制条件，为您找到以下最相近的房源",
    };
  }

  // ── S3: city-level broadened search ─────────────────────────────────────
  const city = detectCity(query);
  if (city) {
    const broadQuery = `${city.en} rental apartment Bay Area`;
    const broadCandidates = await vectorSearch(broadQuery, excludeIds);
    if (broadCandidates.length > 0) {
      return {
        listing: await pickBest(query, broadCandidates),
        relaxedNote: `找不到完全符合要求的房源，已扩大到${city.zh}周边地区搜索，为您找到以下房源`,
      };
    }
  }

  // ── S4: any listing not yet shown, ranked by semantic similarity ─────────
  const { results: allLatest } = await searchXhsRentalListings({});
  const remaining = allLatest.filter((r) => !excludeIds.includes(r.id));
  if (remaining.length > 0) {
    return {
      listing: await pickBest(query, remaining),
      relaxedNote:
        "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
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
      "Returns ONE listing the user has not yet seen. " +
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
        console.error("searchRental tool failed:", error);
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
