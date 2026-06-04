import { tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import {
  searchXhsRentalListings,
  vectorSearchXhsRentalListings,
  type XhsRentalSearchResultRow,
} from "@/lib/db/queries";

const VECTOR_CANDIDATES = 50;

const FALLBACK_CITY_PATTERNS: Array<{ re: RegExp; location: string }> = [
  { re: /圣何塞|San\s*Jose/i, location: "San Jose" },
  { re: /旧金山|三藩市|San\s*Francisco/i, location: "San Francisco" },
  { re: /伯克利|Berkeley/i, location: "Berkeley" },
  { re: /奥克兰|Oakland/i, location: "Oakland" },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, location: "Palo Alto" },
  { re: /山景城|Mountain\s*View/i, location: "Mountain View" },
  { re: /桑尼维尔|Sunnyvale/i, location: "Sunnyvale" },
  { re: /弗里蒙特|Fremont/i, location: "Fremont" },
];

function extractLocationForFallback(query: string): string {
  for (const { re, location } of FALLBACK_CITY_PATTERNS) {
    if (re.test(query)) {
      return location;
    }
  }
  return query.trim().slice(0, 80);
}

async function fetchCandidates(
  query: string,
  excludeIds: string[]
): Promise<XhsRentalSearchResultRow[]> {
  if (process.env.VOYAGE_API_KEY) {
    try {
      const queryVec = await embedText(query, "query");
      const vectorResults = await vectorSearchXhsRentalListings(
        queryVec,
        VECTOR_CANDIDATES,
        excludeIds
      );
      if (vectorResults.length > 0) {
        return vectorResults;
      }
    } catch (error) {
      console.error(
        "Vector search failed, falling back to keyword search:",
        error
      );
    }
  }

  const { results } = await searchXhsRentalListings({
    locationText: extractLocationForFallback(query),
  });
  return results.filter((r) => !excludeIds.includes(r.id));
}

export const searchRental = tool({
  description:
    "Semantic search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental request, AND for every '换一个'/'next'/'不满意' request. " +
    "Returns exactly ONE best-matching listing not yet seen by the user.",
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
          "Derive from negative user requirements and carry forward each turn. Examples:\n" +
          "- User wants couples/family → ['仅限一人', '单人', 'one person only']\n" +
          "- User wants landlord posts only → ['求组', '找室友', '合租找人', '拼租', '招室友']\n" +
          "Include both Chinese and English variants."
      ),
    excludeIds: z
      .array(z.string())
      .optional()
      .describe(
        "IDs of ALL listings already shown to the user in this conversation. " +
          "ALWAYS pass this on every call after the first. " +
          "This is how the tool knows to return a fresh, unseen listing."
      ),
  }),
  execute: async ({ query, mustNotContain, excludeIds }) => {
    try {
      const excluded = excludeIds ?? [];
      const rawCandidates = await fetchCandidates(query, excluded);

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

      if (candidates.length === 0) {
        return {
          listing: null,
          action:
            excluded.length > 0
              ? "NO_MORE: The database has no more listings matching the criteria that haven't been shown yet. Say EXACTLY: '数据库里已经没有更多符合要求的房源了，您可以调整筛选条件再试试。'"
              : "NO_RESULTS: No listings found at all. Apologize and suggest different criteria.",
        };
      }

      let listing = candidates[0];
      if (process.env.VOYAGE_API_KEY && candidates.length > 1) {
        try {
          const rerankTexts = candidates.map((c) => c.rawText);
          const [bestIndex] = await rerankDocuments(query, rerankTexts, 1);
          listing = candidates[bestIndex] ?? listing;
        } catch (error) {
          console.error("Rerank failed, using first candidate:", error);
        }
      }

      return {
        listing,
        action:
          `SHOW_LISTING: Display this one listing (id: ${listing.id}). ` +
          "Add this ID to seen_ids in your <memory> block. " +
          "When user says '换一个'/'next'/'不满意'/'换一个': call searchRental again with " +
          "the SAME query + mustNotContain, and excludeIds = ALL seen_ids from memory. " +
          "Do NOT try to pick from a pool — always call this tool for a fresh result.",
      };
    } catch (error) {
      console.error("searchRental tool failed:", error);
      return {
        listing: null,
        error: "SEARCH_FAILED",
        action:
          "SEARCH_FAILED: Tell the user the search service hit a temporary error and ask them to retry in a moment. Do NOT claim an internal function is missing.",
      };
    }
  },
});
