/**
 * Validates the Bearer API key for /api/gpt/* endpoints.
 * Returns a 401 Response if the key is missing or wrong, otherwise null (pass).
 *
 * Usage:
 *   const denied = requireGptKey(request);
 *   if (denied) return denied;
 */
export function requireGptKey(request: Request): Response | null {
  const expected = process.env.WILLINGLINK_GPT_API_KEY;
  const auth = request.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!expected) {
    console.error("[gpt-auth] WILLINGLINK_GPT_API_KEY env var is not set");
    return Response.json(
      { error: "Service not configured" },
      { status: 503 }
    );
  }

  if (key !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
