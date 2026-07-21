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
const ATTEMPTS_PREFIX = "wl:attempts:";

/** In-process fallback for environments without Redis. */
const inMemory = new Map<string, Set<string>>();

/** In-process fallback for the per-chat search-attempt counter. */
const inMemoryAttempts = new Map<string, number>();

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

/**
 * Increments and returns the number of database searches performed in this
 * chat session. Lets the assistant know how hard it has already tried, so it
 * can decide — on its own — when to stop cycling and honestly tell the user
 * the database has nothing better. Shares the same 14-day TTL as seen listings.
 */
export async function incrementSearchAttempts(chatId: string): Promise<number> {
  const redis = await getRedis();
  if (redis) {
    try {
      const count = await redis.incr(`${ATTEMPTS_PREFIX}${chatId}`);
      await redis.expire(`${ATTEMPTS_PREFIX}${chatId}`, SEEN_TTL_SECONDS);
      return count;
    } catch (err) {
      console.error("[seen-listings] Redis incr failed, using fallback:", err);
    }
  }
  const next = (inMemoryAttempts.get(chatId) ?? 0) + 1;
  inMemoryAttempts.set(chatId, next);
  if (inMemoryAttempts.size > 500) {
    const firstKey = inMemoryAttempts.keys().next().value;
    if (firstKey) {
      inMemoryAttempts.delete(firstKey);
    }
  }
  return next;
}
