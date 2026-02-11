import { generateObject } from "ai";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { getTitleModel } from "@/lib/ai/providers";
import { ChatSDKError } from "@/lib/errors";

const COMMUNITY_QUOTES_REGEX = /^["']|["']$/g;
const COMMUNITY_PUNCTUATION_REGEX = /[.!?]/;

type CommunityRequestBody = {
  text?: string;
};

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  let body: CommunityRequestBody;
  try {
    body = await request.json();
  } catch {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const input = body.text?.trim();
  if (!input) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const { object } = await generateObject({
    model: getTitleModel(),
    system:
      "Extract the community name from the user's message. " +
      "Return only the community name with no extra words, punctuation, or quotes. " +
      "If no community is mentioned, return an empty string.",
    prompt: input,
    schema: z.object({
      community: z.string(),
    }),
  });

  const community = object.community.trim().replace(COMMUNITY_QUOTES_REGEX, "");
  const isValidCommunity =
    community.length > 0 &&
    community.length <= 80 &&
    !community.includes("\n") &&
    !COMMUNITY_PUNCTUATION_REGEX.test(community);

  if (!isValidCommunity) {
    return Response.json({ community: "" });
  }

  return Response.json({ community });
}
