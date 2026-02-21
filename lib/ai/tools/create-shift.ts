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
      .describe(
        "When the shift starts: ISO 8601 datetime in Virginia (America/New_York), e.g. 2026-02-21T09:00:00-05:00. Convert relative phrases like 'tomorrow 9am', '后天上午' to this format."
      ),
    location: z
      .string()
      .optional()
      .describe("Where the shift takes place"),
    skillsNeeded: z
      .string()
      .optional()
      .describe("Skills required for this shift"),
    whoIsBeingHelped: z
      .string()
      .optional()
      .describe("Who is being helped by this shift"),
    laborCredits: z
      .string()
      .optional()
      .describe("Labor credits (hours) for this shift"),
    rawMessage: z
      .string()
      .describe("The original natural language message from the user"),
    audioUrl: z
      .string()
      .optional()
      .describe("URL of the voice recording from the user, from [AUDIO_META] tag"),
    audioDurationMs: z
      .number()
      .optional()
      .describe("Duration of audio in ms, from [AUDIO_META] tag"),
    audioMimeType: z
      .string()
      .optional()
      .describe("MIME type of audio, from [AUDIO_META] tag"),
    audioSizeBytes: z
      .number()
      .optional()
      .describe("Size of audio in bytes, from [AUDIO_META] tag"),
  }),
  execute: async ({
    whattodo,
    startTime,
    location,
    skillsNeeded,
    whoIsBeingHelped,
    laborCredits,
    rawMessage,
    audioUrl,
    audioDurationMs,
    audioMimeType,
    audioSizeBytes,
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

    const startTimeValue =
      startTime === undefined || startTime === ""
        ? null
        : (() => {
            const d = new Date(startTime);
            return Number.isNaN(d.getTime()) ? null : d;
          })();

    await saveShift({
      id,
      whattodo: whattodo ?? null,
      startTime: startTimeValue,
      location: location ?? null,
      skillsNeeded: skillsNeeded ?? null,
      whoIsBeingHelped: whoIsBeingHelped ?? null,
      laborCredits: laborCredits ?? null,
      rawMessage,
      embedding: embeddingVector,
      audioUrl: audioUrl ?? null,
      audioDurationMs: audioDurationMs ?? null,
      audioMimeType: audioMimeType ?? null,
      audioSizeBytes: audioSizeBytes ?? null,
    });

    return {
      success: true,
      shiftId: id,
      message: "Shift posted successfully.",
    };
  },
});
