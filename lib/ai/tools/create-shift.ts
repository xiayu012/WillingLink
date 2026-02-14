import { embed, tool } from "ai";
import { z } from "zod";
import { saveShift } from "@/lib/db/queries";
import { getEmbeddingModel } from "@/lib/ai/providers";
import { generateUUID } from "@/lib/utils";

export const createShift = tool({
  description:
    "Save a shift posting to the database. Use this tool when the user describes a shift they want to post, after a 'Post shift' conversation. Extract as many fields as possible from their natural language description.",
  inputSchema: z.object({
    whattodo: z
      .string()
      .optional()
      .describe("What work needs to be done in this shift"),
    startTime: z
      .string()
      .optional()
      .describe("When the shift starts, e.g. 'tomorrow 9am', 'Monday 2pm'"),
    location: z
      .string()
      .optional()
      .describe("Where the shift takes place"),
    skillsNeeded: z
      .string()
      .optional()
      .describe("Skills required for this shift"),
    peopleHelped: z
      .string()
      .optional()
      .describe("People this shift helped or benefits"),
    laborCredits: z
      .string()
      .optional()
      .describe("Labor credits (hours) for this shift"),
    rawMessage: z
      .string()
      .describe("The original natural language message from the user"),
  }),
  execute: async ({
    whattodo,
    startTime,
    location,
    skillsNeeded,
    peopleHelped,
    laborCredits,
    rawMessage,
  }) => {
    const id = generateUUID();

    // Generate embedding from the raw message for semantic search
    let embeddingVector: number[] | undefined;
    try {
      const { embedding } = await embed({
        model: getEmbeddingModel(),
        value: rawMessage,
      });
      embeddingVector = embedding;
    } catch (err) {
      console.error("Failed to generate embedding for shift:", err);
    }

    await saveShift({
      id,
      whattodo: whattodo ?? null,
      startTime: startTime ?? null,
      location: location ?? null,
      skillsNeeded: skillsNeeded ?? null,
      peopleHelped: peopleHelped ?? null,
      laborCredits: laborCredits ?? null,
      rawMessage,
      embedding: embeddingVector,
    });

    return {
      success: true,
      shiftId: id,
      message: "Shift posted successfully.",
    };
  },
});
