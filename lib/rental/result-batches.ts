/**
 * 分批浏览的会话缓存：一次检索把 top-K 房源排好序、终审完，整份存下来；
 * 用户说"继续/换一批"时直接从这里切下一批，零 DB、零 LLM、瞬间返回，
 * 且与上一批天然不重复（同一份有序列表往后走，不是重新搜一次）。
 *
 * 存储分层与 seen-listings 一致：Redis（多实例/重启存活）→ 进程内 Map 兜底。
 */
import type { XhsRentalSearchResultRow } from "@/lib/db/queries";
import { getRedis } from "@/lib/redis";

const BATCH_TTL_SECONDS = 2 * 3600; // 一次浏览会话足够
const KEY_PREFIX = "wl:batch:";
const MAX_IN_MEMORY = 200;

export type BatchState = {
  /** 生成这份结果的需求指纹（查询+结构化参数+屏蔽词）——变了就不能续用缓存。 */
  fingerprint: string;
  /** 查询原文，仅供日志排查。 */
  query: string;
  /** 已终审、按相关度排序的房源；批次从这里顺序切分。 */
  listings: XhsRentalSearchResultRow[];
  /** 已展示条数（下一批的起点）。 */
  offset: number;
  /** 严格筛选命中的总数（可能远多于缓存的 top-K）。 */
  totalMatched: number;
};

const inMemory = new Map<string, BatchState>();

/**
 * 需求指纹：只有查询与全部筛选条件都没变，"继续" 才允许续用上一轮的排序结果。
 * 用户一旦改了任何条件（哪怕模型仍传了 more），指纹不匹配 → 重新搜索。
 */
export function batchFingerprint(
  query: string,
  params: Record<string, unknown>,
  blockTerms: string[]
): string {
  const normalizedParams = Object.entries(params)
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    query: query.trim().replace(/\s+/g, " "),
    params: normalizedParams,
    blockTerms: [...blockTerms].sort(),
  });
}

/** JSON 往返会把 createdAt 变成字符串，读回时还原成 Date。 */
function reviveDates(state: BatchState): BatchState {
  return {
    ...state,
    listings: state.listings.map((l) => ({
      ...l,
      createdAt: new Date(l.createdAt),
    })),
  };
}

export async function saveBatchState(
  chatId: string,
  state: BatchState
): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(`${KEY_PREFIX}${chatId}`, JSON.stringify(state), {
        EX: BATCH_TTL_SECONDS,
      });
      return;
    } catch (err) {
      console.error("[result-batches] Redis set failed, using fallback:", err);
    }
  }
  inMemory.set(chatId, state);
  if (inMemory.size > MAX_IN_MEMORY) {
    const firstKey = inMemory.keys().next().value;
    if (firstKey) {
      inMemory.delete(firstKey);
    }
  }
}

export async function loadBatchState(
  chatId: string
): Promise<BatchState | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`${KEY_PREFIX}${chatId}`);
      return raw ? reviveDates(JSON.parse(raw) as BatchState) : null;
    } catch (err) {
      console.error("[result-batches] Redis get failed, using fallback:", err);
    }
  }
  const state = inMemory.get(chatId);
  return state ?? null;
}
