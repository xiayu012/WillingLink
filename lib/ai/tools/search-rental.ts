import { tool } from "ai";
import { z } from "zod";
import {
  buildListingEmbedText,
  embedText,
  rerankDocuments,
} from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

const VECTOR_CANDIDATES = 20;
const RERANK_TOP_K = 8;

export const searchRental = tool({
  description:
    "Semantic search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental related request — 找房, 租房, looking for an apartment, show me listings, etc. " +
    "Pass the user's request verbatim (or combined with accumulated context from the conversation) as `query`. " +
    "Do NOT pre-filter or decompose the query; the vector model handles all semantic matching including " +
    "location, price range, room type, amenities, pet-friendly, near transit, furnished, short-term, etc.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The user's natural language rental search request in full. " +
          "Include all context from the conversation: location, budget, room type, special requirements, etc. " +
          "Example: '圣何塞两室一厅，预算2500以下，宠物友好，靠近Caltrain'"
      ),
  }),
  execute: async ({ query }) => {
    // 1. Embed the user query (query-type for asymmetric retrieval)
    const queryVec = await embedText(query, "query");

    // 2. Vector similarity search — top 20 candidates
    const candidates = await vectorSearchXhsRentalListings(
      queryVec,
      VECTOR_CANDIDATES
    );

    if (candidates.length === 0) {
      return {
        totalFound: 0,
        results: [],
        action:
          "NO_RESULTS: No listings found at all. Apologize briefly and suggest the user check back later or describe different criteria.",
      };
    }

    // 3. Voyage rerank — reorder candidates by relevance, keep top 8
    const rerankTexts = candidates.map((c) => buildListingEmbedText(c));
    const rankedIndices = await rerankDocuments(query, rerankTexts, RERANK_TOP_K);

    const results = rankedIndices.map((i) => candidates[i]);

    return {
      totalFound: candidates.length,
      results,
      action:
        results.length > 0
          ? "SHOW_RESULTS_NOW: Display all results below immediately. Do NOT ask more questions unless the user explicitly asks for refinement."
          : "NO_RESULTS: Rerank returned nothing. Apologize and ask the user to try different criteria.",
    };
  },
});
