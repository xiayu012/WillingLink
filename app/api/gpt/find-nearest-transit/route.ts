/**
 * POST /api/gpt/find-nearest-transit
 *
 * GPT Action wrapper around the in-app findNearestTransit tool.
 */
import "server-only";

import { requireGptKey } from "@/lib/api/gpt-auth";
import { findNearestTransit } from "@/lib/ai/tools/find-nearest-transit";

type FindNearestTransitRequest = {
  userAddress: string;
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

  let body: FindNearestTransitRequest;
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

  try {
    const tool = findNearestTransit as unknown as ExecutableTool<
      FindNearestTransitRequest,
      unknown
    >;
    const result = await tool.execute({ userAddress: body.userAddress.trim() });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/find-nearest-transit] error:", msg);
    return Response.json(
      { error: "Transit search failed", detail: msg },
      { status: 500 }
    );
  }
}
