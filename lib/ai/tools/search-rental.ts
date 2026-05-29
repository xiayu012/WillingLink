import { tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

// Larger candidate pool so hard-constraint filtering leaves enough results
const VECTOR_CANDIDATES = 50;
const POOL_SIZE = 10;

export const searchRental = tool({
  description:
    "Semantic search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental related request — 找房, 租房, looking for an apartment, show me listings, etc. " +
    "Pass the user's full request as `query`. " +
    "Extract HARD NEGATIVE constraints into `mustNotContain` — these are words/phrases that, " +
    "if present in a listing's text, mean the listing is DISQUALIFIED. " +
    "The tool returns a pool of up to 10 candidates that satisfy all constraints.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The user's full natural language rental search request including all accumulated context. " +
          "Example: '圣何塞两室一厅，预算2500以下，宠物友好，靠近Caltrain，情侣入住'"
      ),
    mustNotContain: z
      .array(z.string())
      .optional()
      .describe(
        "Chinese or English keywords/phrases that DISQUALIFY a listing if found in its text. " +
          "Derive these from the user's negative requirements. Examples:\n" +
          "- User wants couples/family → ['仅限一人', '单人', 'single occupant', '一人入住']\n" +
          "- User wants landlord posts only → ['求组', '找室友', '合租找人', '一起找', '拼租']\n" +
          "- User wants no smoking → ['允许抽烟', '可以抽烟']\n" +
          "- User wants no pets restriction → ['不允许宠物', '不可以养宠物', 'no pets']\n" +
          "Include BOTH Chinese and English variants when the corpus may use either. " +
          "Accumulate across conversation turns — if user stated constraints earlier, keep them."
      ),
    excludeIds: z
      .array(z.string())
      .optional()
      .describe(
        "IDs of listings already shown in this conversation. " +
          "Pass only when the pool is exhausted and the user wants a completely fresh batch."
      ),
  }),
  execute: async ({ query, mustNotContain, excludeIds }) => {
    const queryVec = await embedText(query, "query");

    const rawCandidates = await vectorSearchXhsRentalListings(
      queryVec,
      VECTOR_CANDIDATES,
      excludeIds ?? []
    );

    // Hard constraint filtering: remove any listing whose rawText contains
    // a disqualifying phrase. Done in-memory after retrieval.
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
      const reason =
        blockTerms.length > 0
          ? `No listings passed the constraint filter (blocked terms: ${blockTerms.join(", ")}). ` +
            "Tell the user no matching listings were found and suggest relaxing one constraint."
          : "No listings found at all. Apologize briefly and suggest different criteria.";
      return { pool: [], action: `NO_RESULTS: ${reason}` };
    }

    const rerankTexts = candidates.map((c) => c.rawText);
    const actualPoolSize = Math.min(POOL_SIZE, candidates.length);
    const rankedIndices = await rerankDocuments(query, rerankTexts, actualPoolSize);
    const pool = rankedIndices.map((i) => candidates[i]);

    return {
      pool,
      filteredOut: rawCandidates.length - candidates.length,
      action:
        "POOL_READY: You have a pool of listings that passed all hard constraints. " +
        "Read ALL rawTexts carefully. " +
        "Pick the SINGLE best match for the user's full request. " +
        "STRICT RULE: if a listing still explicitly contradicts a user requirement (e.g. says '仅限一人' when user wants couples), SKIP it and pick the next. " +
        "For '换一个'/'next'/'不满意': pick a different one from the pool without calling this tool. " +
        "Pool exhausted → call tool again with excludeIds = all seen IDs.",
    };
  },
});
