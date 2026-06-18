/**
 * POST /api/gpt/transit-time
 *
 * GPT Action wrapper around the in-app getTransitTime tool.
 */
import "server-only";

import { requireGptKey } from "@/lib/api/gpt-auth";
import { getTransitTime } from "@/lib/ai/tools/get-transit-time";

type TransitTimeRequest = {
  userAddress: string;
  listingAddress: string;
  listingTitle?: string | null;
};

type ExecutableTool<TInput, TOutput> = {
  execute: (input: TInput) => Promise<TOutput>;
};

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  let body: TransitTimeRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.userAddress !== "string" || body.userAddress.trim() === "") {
    return Response.json(
      { error: "userAddress is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  if (
    typeof body.listingAddress !== "string" ||
    body.listingAddress.trim() === ""
  ) {
    return Response.json(
      { error: "listingAddress is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  try {
    const tool = getTransitTime as unknown as ExecutableTool<
      TransitTimeRequest,
      unknown
    >;
    const result = await tool.execute({
      userAddress: body.userAddress.trim(),
      listingAddress: body.listingAddress.trim(),
      listingTitle: body.listingTitle?.trim() || undefined,
    });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/transit-time] error:", msg);
    return Response.json(
      { error: "Transit time query failed", detail: msg },
      { status: 500 }
    );
  }
}
