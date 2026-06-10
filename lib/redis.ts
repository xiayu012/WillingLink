/**
 * Lazily-initialized node-redis v5 client.
 *
 * Uses REDIS_URL if set (same variable used by resumable-stream), so no
 * additional environment variable is needed.  Falls back gracefully when
 * Redis is unavailable, letting callers use in-process memory instead.
 */
import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

let _client: RedisClient | null = null;
let _connecting = false;
let _connectPromise: Promise<RedisClient | null> | null = null;

export async function getRedis(): Promise<RedisClient | null> {
  if (!process.env.REDIS_URL) return null;
  if (_client?.isReady) return _client;
  if (_connectPromise) return _connectPromise;

  _connectPromise = (async () => {
    try {
      if (!_connecting) {
        _connecting = true;
        _client = createClient({ url: process.env.REDIS_URL });
        _client.on("error", (err) => {
          console.error("[redis] client error:", err);
        });
        _client.on("end", () => {
          _connecting = false;
          _connectPromise = null;
        });
        await _client.connect();
      }
      return _client;
    } catch (err) {
      console.error("[redis] connect failed:", err);
      _connecting = false;
      _connectPromise = null;
      return null;
    }
  })();

  return _connectPromise;
}
