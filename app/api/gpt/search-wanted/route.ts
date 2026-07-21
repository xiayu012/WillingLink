/**
 * POST /api/gpt/search-wanted
 *
 * Keyword search over XhsRentalWanted (tenant-seeking posts) for Custom GPT
 * Actions. Mirrors the in-app searchWanted tool, but excludeIds are passed
 * explicitly by the caller instead of tracked server-side (GPT Actions are
 * stateless between calls).
 *
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import { requireGptKey } from "@/lib/api/gpt-auth";
import {
  findNextWanted,
  SEARCH_ATTEMPT_HINT_THRESHOLD,
} from "@/lib/ai/tools/search-wanted";

type SearchWantedRequest = {
  query: string;
  mustNotContain?: string[] | null;
  excludeIds?: string[] | null;
};

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  let body: SearchWantedRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.query !== "string" || body.query.trim().length === 0) {
    return Response.json(
      { error: "query is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  const excludeIds = (body.excludeIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
  const blockTerms = (body.mustNotContain ?? [])
    .map((term) => (typeof term === "string" ? term.trim().toLowerCase() : ""))
    .filter((term) => term.length > 0);

  // GPT Actions are stateless, so we can't count searches server-side. The
  // number of posts already excluded is a good proxy for how many rounds the
  // conversation has cycled through — use it to nudge honesty once it's high.
  const exhaustionHint =
    excludeIds.length >= SEARCH_ATTEMPT_HINT_THRESHOLD
      ? "你已经为这位房东翻过很多条求租帖了。如果对方仍不满意，可以自行判断，坦诚告诉他数据库里暂时没有更合适的，建议调整条件或稍后再来，不要机械地无限换。"
      : null;

  try {
    const result = await findNextWanted(body.query.trim(), excludeIds, blockTerms);

    if (!result) {
      return Response.json({
        wanted: [],
        count: 0,
        relaxedNote: null,
        action: excludeIds.length > 0 ? "NO_MORE" : "NO_RESULTS",
        exhaustionHint,
        message:
          excludeIds.length > 0
            ? "No more tenant-seeking posts matched after excluding posts already shown."
            : "No matching tenant-seeking posts found after progressive relaxation.",
      });
    }

    return Response.json({
      wanted: result.wanted,
      count: result.wanted.length,
      relaxedNote: result.relaxedNote,
      action: result.relaxedNote ? "SHOW_RELAXED_WANTED" : "SHOW_WANTED",
      exhaustionHint,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/search-wanted] error:", msg);
    return Response.json({ error: "Search failed", detail: msg }, { status: 500 });
  }
}
