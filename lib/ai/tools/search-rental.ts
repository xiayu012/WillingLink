import { gateway } from "@ai-sdk/gateway";
import { generateText, tool } from "ai";
import { z } from "zod";
import { embedText, rerankDocuments } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";

const VECTOR_CANDIDATES = 25;
const POOL_SIZE = 10;
/** Max number of judge-triggered retries (1 = one extra attempt if judge rejects). */
const MAX_RETRIES = 1;

type Listing = Awaited<ReturnType<typeof vectorSearchXhsRentalListings>>[number];
type SearchResult = { pool: Listing[]; action: string };

/**
 * LLM judge: checks if the reranked pool plausibly satisfies the user's query.
 * Uses claude-haiku for speed/cost.
 * Returns pass=true (good pool) or pass=false with a reformulated query for retry.
 */
async function judgeRelevance(
  query: string,
  pool: Listing[]
): Promise<{ pass: boolean; reformulation?: string }> {
  const summary = pool
    .slice(0, 5)
    .map((c, i) => {
      const preview = c.rawText.slice(0, 120).replace(/\n/g, " ");
      return `[${i + 1}] ${c.title ?? "(无标题)"} | ${c.locationText ?? "?"} | ${c.rent ?? "?"} | ${c.roomType ?? "?"} | ${preview}`;
    })
    .join("\n");

  try {
    const { text } = await generateText({
      model: gateway.languageModel("anthropic/claude-haiku-4.5"),
      prompt: `You are a rental listing relevance judge for a Bay Area housing search platform.

User query: "${query}"

Top reranked candidates:
${summary}

Does ANY candidate plausibly satisfy the user's core needs (location, price range, room type, or special requirements)?

Reply with ONLY valid JSON, no markdown fences:
{"pass":true}
or
{"pass":false,"reformulation":"<a simpler/broader rephrasing in English + Chinese for retry>"}`,
    });

    const parsed = JSON.parse(text.trim()) as {
      pass: boolean;
      reformulation?: string;
    };
    return {
      pass: parsed.pass !== false,
      reformulation: parsed.reformulation,
    };
  } catch {
    // If judge fails (network, parse error), trust the original results.
    return { pass: true };
  }
}

/**
 * Recursive search-and-judge pipeline.
 * On first attempt uses the user's original query.
 * If the judge rejects the pool, retries with a reformulated query (up to MAX_RETRIES times).
 * Always rerranks with originalQuery so relevance stays anchored to what the user actually said.
 */
async function doSearch(
  currentQuery: string,
  originalQuery: string,
  excludeIds: string[],
  retriesLeft: number
): Promise<SearchResult> {
  const queryVec = await embedText(currentQuery, "query");
  const candidates = await vectorSearchXhsRentalListings(
    queryVec,
    VECTOR_CANDIDATES,
    excludeIds
  );

  if (candidates.length === 0) {
    return {
      pool: [],
      action:
        "NO_RESULTS: No listings found. Apologize briefly and suggest the user try different criteria.",
    };
  }

  const rankedIndices = await rerankDocuments(
    originalQuery,
    candidates.map((c) => c.rawText),
    POOL_SIZE
  );
  const pool = rankedIndices.map((i) => candidates[i]);

  if (retriesLeft > 0) {
    const { pass, reformulation } = await judgeRelevance(originalQuery, pool);
    if (!pass && reformulation) {
      return doSearch(reformulation, originalQuery, excludeIds, retriesLeft - 1);
    }
  }

  return {
    pool,
    action:
      "POOL_READY: You have a pool of relevant listings below. " +
      "Read ALL of them (rawText is the original post; createdAt is the post date). " +
      "Based on the user's EXACT request, pick the SINGLE best match using your judgment: " +
      "newest → compare createdAt; cheapest → compare rent; specific amenity → read rawText. " +
      "Show that ONE listing in the standard format. " +
      "Keep the full pool in context for navigation: " +
      "'换一个'/'next'/'not satisfied' = pick a DIFFERENT listing from the pool WITHOUT calling this tool again. " +
      "Only call this tool again when the user wants a genuinely new search, or the pool is truly exhausted.",
  };
}

export const searchRental = tool({
  description:
    "Semantic vector search over the XhsRentalListing database. " +
    "Call this for ANY housing / rental related request — 找房, 租房, looking for an apartment, show me listings, 有什么房子, etc. " +
    "Pass the user's full natural language request as `query`. " +
    "The tool embeds the query, retrieves the nearest listings via pgvector, rerranks them with Voyage AI, " +
    "then runs an LLM quality judge that retries with a broader query if results are off-target. " +
    "Returns a curated pool of up to 10 candidates. YOU then pick the single best match for the user.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The user's natural language rental search request in full, including all accumulated context from the conversation. " +
          "Example: '圣何塞两室一厅，预算2500以下，宠物友好，靠近Caltrain'"
      ),
    excludeIds: z
      .array(z.string())
      .optional()
      .describe(
        "IDs of listings already shown in this conversation. " +
          "Pass only when the pool is exhausted and the user explicitly wants a completely fresh batch."
      ),
  }),
  execute: async ({ query, excludeIds }) =>
    doSearch(query, query, excludeIds ?? [], MAX_RETRIES),
});
