import { tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

const VECTOR_CANDIDATES = 20;
const POOL_SIZE = 10;

export const searchRental = tool({
  description:
    "Semantic search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental related request — 找房, 租房, looking for an apartment, show me listings, etc. " +
    "Pass the user's full request as `query`. The tool returns a pool of up to 10 relevant candidates with full data. " +
    "YOU (the LLM) then read the candidates and pick the best one based on the user's intent — " +
    "including any criterion like price, date, amenities, room size, proximity, etc.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The user's natural language rental search request in full, including all accumulated context. " +
          "Example: '圣何塞两室一厅，预算2500以下，宠物友好，靠近Caltrain'"
      ),
    excludeIds: z
      .array(z.string())
      .optional()
      .describe(
        "IDs of listings already shown in this conversation. " +
          "Pass only when the pool is exhausted and the user wants a completely fresh batch."
      ),
  }),
  execute: async ({ query, excludeIds }) => {
    const queryVec = await embedText(query, "query");

    const candidates = await vectorSearchXhsRentalListings(
      queryVec,
      VECTOR_CANDIDATES,
      excludeIds ?? []
    );

    if (candidates.length === 0) {
      return {
        pool: [],
        action:
          "NO_RESULTS: No listings found. Apologize briefly and suggest the user try different criteria.",
      };
    }

    const rerankTexts = candidates.map((c) => c.rawText);
    const rankedIndices = await rerankDocuments(query, rerankTexts, POOL_SIZE);
    const pool = rankedIndices.map((i) => candidates[i]);

    return {
      pool,
      action:
        "POOL_READY: You have a pool of relevant listings below. " +
        "Read ALL of them (rawText contains the full post content, createdAt is the post date). " +
        "Based on the user's EXACT request, pick and display the SINGLE best match using your own judgment — " +
        "if they want newest, pick the largest createdAt; if cheapest, pick the lowest rent from rawText; " +
        "if specific amenities, read rawText to find them; for any other criterion, reason from the content. " +
        "Keep the full pool in context. For '换一个'/'next'/'not satisfied', pick a different one from the pool without calling this tool again. " +
        "Only call this tool again when the user wants a genuinely different search, or the pool is exhausted (pass excludeIds then).",
    };
  },
});
