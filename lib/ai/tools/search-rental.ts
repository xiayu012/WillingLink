import { tool } from "ai";
import { z } from "zod";
import {
  embedText,
  rerankDocuments,
} from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

const VECTOR_CANDIDATES = 20;
const POOL_SIZE = 5;

export const searchRental = tool({
  description:
    "Semantic search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental related request — 找房, 租房, looking for an apartment, show me listings, etc. " +
    "Pass the user's request verbatim (or combined with accumulated context from the conversation) as `query`. " +
    "Do NOT pre-filter or decompose the query; the vector model handles all semantic matching including " +
    "location, price range, room type, amenities, pet-friendly, near transit, furnished, short-term, etc. " +
    "Pass `excludeIds` when the user wants fresh results excluding already-shown listings (pool exhausted).",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The user's natural language rental search request in full. " +
          "Include all context from the conversation: location, budget, room type, special requirements, etc. " +
          "Example: '圣何塞两室一厅，预算2500以下，宠物友好，靠近Caltrain'"
      ),
    excludeIds: z
      .array(z.string())
      .optional()
      .describe(
        "List of listing IDs already shown to the user in this conversation. " +
          "Pass these only when the user has exhausted the current pool and wants completely fresh results."
      ),
  }),
  execute: async ({ query, excludeIds }) => {
    // 1. Embed the user query
    const queryVec = await embedText(query, "query");

    // 2. Vector similarity search — top 20 candidates, excluding seen IDs
    const candidates = await vectorSearchXhsRentalListings(
      queryVec,
      VECTOR_CANDIDATES,
      excludeIds ?? []
    );

    if (candidates.length === 0) {
      return {
        pool: [],
        action:
          "NO_RESULTS: No listings found. Apologize briefly and suggest the user try different criteria or check back later.",
      };
    }

    // 3. Voyage rerank — reorder candidates, keep top POOL_SIZE
    const rerankTexts = candidates.map((c) => c.rawText);
    const rankedIndices = await rerankDocuments(query, rerankTexts, POOL_SIZE);
    const pool = rankedIndices.map((i) => candidates[i]);

    return {
      pool,
      action:
        "POOL_READY: You now have a ranked candidate pool. Show ONLY pool[0] to the user. " +
        "Keep the full pool in memory. " +
        "If the user says '换一个' / 'show another' / 'not satisfied' / '不满意' / 'next one' / '再换': pick the next unused item from the pool WITHOUT calling this tool again. " +
        "If the user says '最近发布的' / 'newest' / '最新的': sort the pool by createdAt descending and show the newest one. " +
        "If the user says '再换' and the pool is exhausted: call this tool again with excludeIds = all IDs from the current pool. " +
        "NEVER call this tool again just because the user is navigating within the pool.",
    };
  },
});
