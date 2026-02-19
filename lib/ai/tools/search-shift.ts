import { embed, tool } from "ai";
import { z } from "zod";
import { getEmbeddingModel } from "@/lib/ai/providers";
import { searchShifts } from "@/lib/db/queries";

const SHIFT_FILTER_FIELDS = [
  "whattodo",
  "startTime",
  "location",
  "skillsNeeded",
  "whoIsBeingHelped",
  "laborCredits",
] as const;

export const searchShift = tool({
  description:
    "Search for shifts in the database using semantic similarity and optional filters. " +
    "Use this tool when the user is looking for shifts (conversation starts with 'Search shift'). " +
    "Pass accumulated filter values from the conversation. Only pass a filter when the user has explicitly provided that information.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "The semantic search query combining all user inputs so far, e.g. 'outdoor garden work tomorrow morning'"
      ),
    whattodo: z
      .string()
      .optional()
      .describe("Filter: what work to do (only if user specified)"),
    startTime: z
      .string()
      .optional()
      .describe("Filter: when the shift starts (only if user specified)"),
    location: z
      .string()
      .optional()
      .describe("Filter: where the shift is (only if user specified)"),
    skillsNeeded: z
      .string()
      .optional()
      .describe("Filter: skills required (only if user specified)"),
    whoIsBeingHelped: z
      .string()
      .optional()
      .describe("Filter: who is being helped (only if user specified)"),
    laborCredits: z
      .string()
      .optional()
      .describe("Filter: labor credits/hours (only if user specified)"),
  }),
  execute: async ({
    query,
    whattodo,
    startTime,
    location,
    skillsNeeded,
    whoIsBeingHelped,
    laborCredits,
  }) => {
    // Generate embedding for the search query
    const { embedding: queryEmbedding } = await embed({
      model: getEmbeddingModel(),
      value: query,
    });

    // Search the database
    const { totalCount, results } = await searchShifts({
      queryEmbedding,
      whattodo,
      startTime,
      location,
      skillsNeeded,
      whoIsBeingHelped,
      laborCredits,
    });

    // Build appliedFilters and remainingFields
    const filters: Record<string, string | undefined> = {
      whattodo,
      startTime,
      location,
      skillsNeeded,
      whoIsBeingHelped,
      laborCredits,
    };

    const appliedFilters: Record<string, string> = {};
    const remainingFields: string[] = [];

    for (const field of SHIFT_FILTER_FIELDS) {
      if (filters[field]) {
        appliedFilters[field] = filters[field];
      } else {
        remainingFields.push(field);
      }
    }

    const resultData = results.map(
      ({ distance: _distance, ...rest }) => rest
    );

    return {
      totalCount,
      results: resultData,
      appliedFilters,
      remainingFields,
      // Explicit instruction for the AI based on result count
      action:
        totalCount <= 3
          ? "SHOW_RESULTS_NOW: You MUST display all the results below to the user immediately. Do NOT ask any more questions."
          : `ASK_TO_NARROW: There are ${totalCount} results, which is too many. Pick ONE field from remainingFields to ask about, based on which has the most variety in the results sample.`,
    };
  },
});
