import { tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

const VECTOR_CANDIDATES = 50;

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
    const queryVec = await embedText(query, "query");

    const rawCandidates = await vectorSearchXhsRentalListings(
      queryVec,
      VECTOR_CANDIDATES,
      excludeIds ?? []
    );

    // Hard constraint filtering
    const blockTerms = (mustNotContain ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    const candidates =
      blockTerms.length > 0
        ? rawCandidates.filter(
            (c) =>
              !blockTerms.some((term) => c.rawText.toLowerCase().includes(term))
          )
        : rawCandidates;

    if (candidates.length === 0) {
      return {
        listing: null,
        action:
          excludeIds && excludeIds.length > 0
            ? "NO_MORE: The database has no more listings matching the criteria that haven't been shown yet. Say EXACTLY: '数据库里已经没有更多符合要求的房源了，您可以调整筛选条件再试试。'"
            : "NO_RESULTS: No listings found at all. Apologize and suggest different criteria.",
      };
    }

    // Rerank and take the single best result
    const rerankTexts = candidates.map((c) => c.rawText);
    const [bestIndex] = await rerankDocuments(query, rerankTexts, 1);
    const listing = candidates[bestIndex];

    return {
      listing,
      action:
        `SHOW_LISTING: Display this one listing (id: ${listing.id}). ` +
        "Add this ID to seen_ids in your <memory> block. " +
        "When user says '换一个'/'next'/'不满意'/'换一个': call searchRental again with " +
        "the SAME query + mustNotContain, and excludeIds = ALL seen_ids from memory. " +
        "Do NOT try to pick from a pool — always call this tool for a fresh result.",
    };
  },
});
