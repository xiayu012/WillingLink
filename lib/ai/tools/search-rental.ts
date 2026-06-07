import { tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import {
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";

const VECTOR_CANDIDATES = 50;

/** Server-side tracking of which listing IDs have been shown per chatId. */
const shownListingsPerChat = new Map<string, Set<string>>();

function getShownIds(chatId: string): string[] {
  return [...(shownListingsPerChat.get(chatId) ?? [])];
}

function markShown(chatId: string, id: string): void {
  if (!shownListingsPerChat.has(chatId)) {
    shownListingsPerChat.set(chatId, new Set());
  }
  // biome-ignore lint/style/noNonNullAssertion: just set above
  shownListingsPerChat.get(chatId)!.add(id);
  if (shownListingsPerChat.size > 500) {
    const firstKey = shownListingsPerChat.keys().next().value;
    if (firstKey) shownListingsPerChat.delete(firstKey);
  }
}

const CITY_PATTERNS: Array<{ re: RegExp; en: string; zh: string }> = [
  { re: /圣何塞|San\s*Jose/i,            en: "San Jose",       zh: "圣何塞" },
  { re: /旧金山|三藩市|San\s*Francisco/i, en: "San Francisco",  zh: "旧金山" },
  { re: /伯克利|Berkeley/i,              en: "Berkeley",       zh: "伯克利" },
  { re: /奥克兰|Oakland/i,               en: "Oakland",        zh: "奥克兰" },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, en: "Palo Alto",   zh: "帕洛阿尔托" },
  { re: /山景城|Mountain\s*View/i,       en: "Mountain View",  zh: "山景城" },
  { re: /桑尼维尔|Sunnyvale/i,           en: "Sunnyvale",      zh: "桑尼维尔" },
  { re: /弗里蒙特|Fremont/i,             en: "Fremont",        zh: "弗里蒙特" },
  { re: /圣克拉拉|Santa\s*Clara/i,       en: "Santa Clara",    zh: "圣克拉拉" },
  { re: /戴利城|Daly\s*City/i,           en: "Daly City",      zh: "戴利城" },
];

function detectCity(query: string): { en: string; zh: string } | null {
  for (const p of CITY_PATTERNS) {
    if (p.re.test(query)) return { en: p.en, zh: p.zh };
  }
  return null;
}

/** Primary semantic search: vector first, ILIKE fallback. */
async function primarySearch(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  if (process.env.VOYAGE_API_KEY) {
    try {
      const vec = await embedText(query, "query");
      const rows = await vectorSearchXhsRentalListings(vec, VECTOR_CANDIDATES, excludeIds);
      if (rows.length > 0) return rows;
    } catch (err) {
      console.error("Vector search failed:", err);
    }
  }
  // ILIKE fallback — use city name if detectable, else full query
  const city = detectCity(query);
  const { results } = await searchXhsRentalListings({
    locationText: city?.en ?? query.trim().slice(0, 80),
  });
  return results.filter((r) => !excludeIds.includes(r.id));
}

/** Pick the single best candidate using Voyage rerank if available, else first. */
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

/**
 * Progressive relaxation: when strict search finds nothing, automatically
 * try three increasingly broad fallback strategies and return the best match
 * along with a human-readable note explaining what was relaxed.
 */
async function autoRelax(
  query: string,
  excludeIds: string[],
  blockTerms: string[]
): Promise<{ listing: XhsRentalSearchResultRow; relaxedNote: string } | null> {
  const city = detectCity(query);

  // Strategy 1: drop mustNotContain hard-blocks (keep original query semantics)
  if (blockTerms.length > 0) {
    const rows = await primarySearch(query, excludeIds);
    if (rows.length > 0) {
      const best = await pickBest(query, rows);
      return {
        listing: best,
        relaxedNote: '找不到完全符合要求的房源，已放宽硬性排除条件（如"仅限一人"等限制），为您找到以下最相近的房源',
      };
    }
  }

  // Strategy 2: broaden to city-level search only
  if (city) {
    const broadQuery = `${city.en} 租房 Bay Area`;
    const rows = await primarySearch(broadQuery, excludeIds);
    if (rows.length > 0) {
      const best = await pickBest(broadQuery, rows);
      return {
        listing: best,
        relaxedNote: `找不到完全符合要求的房源，已放宽到${city.zh}地区所有户型，为您找到以下最相近的房源`,
      };
    }
  }

  // Strategy 3: no location/price/type constraint — just latest listings
  const { results: latest } = await searchXhsRentalListings({});
  const fresh = latest.filter((r) => !excludeIds.includes(r.id));
  if (fresh.length > 0) {
    const best = await pickBest(query, fresh);
    return {
      listing: best,
      relaxedNote: "湾区内暂无完全匹配的房源，已从最近发布的所有房源中为您挑选最接近的",
    };
  }

  return null;
}

/**
 * Factory: call once per request with the current chatId.
 * The tool automatically tracks shown listing IDs server-side so the LLM
 * does NOT need to pass excludeIds manually.
 */
export function createSearchRentalTool(chatId: string) {
  return tool({
    description:
      "Semantic search over the XhsRentalListing database. " +
      "Call this for ANY housing / rental request, AND for every '换一个'/'next'/'不满意' request. " +
      "Returns exactly ONE best-matching listing not yet seen by the user. " +
      "If no exact match exists, the tool automatically relaxes criteria and returns the closest available listing.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Full natural language search request with all accumulated context from the conversation. " +
            "Example: '圣何塞两室一厅，预算2500以下，宠物友好，情侣入住'"
        ),
      mustNotContain: z
        .array(z.string())
        .optional()
        .describe(
          "Keywords that disqualify a listing if found in its rawText. " +
            "Derive from hard negative requirements carry forward each turn. Examples:\n" +
            "- User wants couples/family → ['仅限一人', '单人', 'one person only', '一人入住']\n" +
            "- User wants landlord posts only → ['求组', '找室友', '合租找人', '拼租', '招室友']\n" +
            "- User wants no agent → ['中介', 'agent fee', '佣金']\n" +
            "Include both Chinese and English variants."
        ),
    }),
    execute: async ({ query, mustNotContain }) => {
      try {
        const excluded = getShownIds(chatId);

        const rawCandidates = await primarySearch(query, excluded);

        const blockTerms = (mustNotContain ?? [])
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0);

        const candidates =
          blockTerms.length > 0
            ? rawCandidates.filter(
                (c) =>
                  !blockTerms.some((term) =>
                    c.rawText.toLowerCase().includes(term)
                  )
              )
            : rawCandidates;

        // ── Happy path: found a strict match ────────────────────────────────
        if (candidates.length > 0) {
          const listing = await pickBest(query, candidates);
          markShown(chatId, listing.id);
          return {
            listing,
            relaxedNote: null,
            action:
              "SHOW_LISTING: Display this listing to the user. " +
              "When user says '换一个'/'next'/'不满意' or any dissatisfaction, call searchRental again with the SAME query.",
          };
        }

        // ── No strict match: auto-relax ──────────────────────────────────────
        if (excluded.length > 0) {
          // Already shown some listings; pool exhausted
          return {
            listing: null,
            relaxedNote: null,
            action:
              "NO_MORE: 数据库里已经没有更多符合要求的房源了，您可以调整筛选条件再试试。",
          };
        }

        const relaxed = await autoRelax(query, excluded, blockTerms);
        if (relaxed) {
          markShown(chatId, relaxed.listing.id);
          return {
            listing: relaxed.listing,
            relaxedNote: relaxed.relaxedNote,
            action:
              "SHOW_RELAXED_LISTING: No exact match was found. " +
              "Prepend the value of `relaxedNote` as a brief italic disclaimer before showing the listing details. " +
              "Then display the listing using the standard format. " +
              "End with: '如您仍不满意，可以告诉我具体要求，我再为您调整。'",
          };
        }

        // Truly empty database
        return {
          listing: null,
          relaxedNote: null,
          action: "NO_RESULTS: 数据库暂时没有可推荐的房源，请稍后再试。",
        };
      } catch (error) {
        console.error("searchRental tool failed:", error);
        return {
          listing: null,
          relaxedNote: null,
          error: "SEARCH_FAILED",
          action:
            "SEARCH_FAILED: Tell the user the search service hit a temporary error and ask them to retry in a moment.",
        };
      }
    },
  });
}
