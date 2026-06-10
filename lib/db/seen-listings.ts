/**
 * Tracks which listing IDs have been shown to a user within a chat session.
 *
 * Storage tier:
 *   1. Redis (REDIS_URL set) — survives server restarts, works across
 *      horizontally-scaled Vercel instances.  TTL = 14 days.
 *   2. In-process Map fallback — local dev without Redis.
 */
import { getRedis } from "@/lib/redis";

const SEEN_TTL_SECONDS = 14 * 24 * 3600;
const KEY_PREFIX = "wl:seen:";

/** In-process fallback for environments without Redis. */
const inMemory = new Map<string, Set<string>>();

function inMemoryGet(chatId: string): string[] {
  return [...(inMemory.get(chatId) ?? [])];
}

function inMemoryAdd(chatId: string, id: string): void {
  if (!inMemory.has(chatId)) inMemory.set(chatId, new Set());
  // biome-ignore lint/style/noNonNullAssertion: just set above
  inMemory.get(chatId)!.add(id);
  // Evict oldest entries to keep memory bounded
  if (inMemory.size > 500) {
    const firstKey = inMemory.keys().next().value;
    if (firstKey) inMemory.delete(firstKey);
  }
}

export async function getSeenListingIds(chatId: string): Promise<string[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      return await redis.sMembers(`${KEY_PREFIX}${chatId}`);
    } catch (err) {
      console.error("[seen-listings] Redis sMembers failed, using fallback:", err);
    }
  }
  return inMemoryGet(chatId);
}

export async function markListingAsSeen(chatId: string, listingId: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.sAdd(`${KEY_PREFIX}${chatId}`, listingId);
      await redis.expire(`${KEY_PREFIX}${chatId}`, SEEN_TTL_SECONDS);
      return;
    } catch (err) {
      console.error("[seen-listings] Redis sAdd failed, using fallback:", err);
    }
  }
  inMemoryAdd(chatId, listingId);
}
