/**
 * GET /api/cron/clean-forum-listings
 *
 * Vercel Cron (daily, see vercel.json): deletes ChineseInSFBay / bay123 forum
 * listings whose postedAt (or createdAt when postedAt is missing) is older
 * than 45 days. XiaoHongShu (userscript) listings are untouched — those are
 * cleaned separately by scripts/clean-xhs-rented-listings.ts based on actual
 * rental status rather than age.
 *
 * Authentication: Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * automatically once CRON_SECRET is set as a project environment variable.
 */
import "server-only";

import { deleteExpiredForumListings } from "@/lib/db/queries";

const MAX_AGE_DAYS = 45;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const deletedCount = await deleteExpiredForumListings(MAX_AGE_DAYS);
    console.log(
      `[cron/clean-forum-listings] deleted=${deletedCount} maxAgeDays=${MAX_AGE_DAYS}`
    );
    return Response.json({ ok: true, deletedCount, maxAgeDays: MAX_AGE_DAYS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron/clean-forum-listings] failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
