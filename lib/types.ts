import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { getWeather } from "./ai/tools/get-weather";
import type { createSearchRentalTool } from "./ai/tools/search-rental";
import type { queryListings } from "./ai/tools/query-listings";

export type DataPart = { type: "append-message"; message: string };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type searchRentalTool = InferUITool<ReturnType<typeof createSearchRentalTool>>;
type queryListingsTool = InferUITool<typeof queryListings>;

export type ChatTools = {
  getWeather: weatherTool;
  searchRental: searchRentalTool;
  queryListings: queryListingsTool;
};

export type CustomUIDataTypes = {
  appendMessage: string;
  "chat-title": string;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
