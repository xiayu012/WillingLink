import { VoyageAIClient } from "voyageai";

type EmbedDataItem = { index?: number; embedding?: number[] };
type RerankDataItem = { index?: number; relevanceScore?: number };

// biome-ignore lint: required env var
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });

const EMBED_MODEL = "voyage-3" as const;
const RERANK_MODEL = "rerank-2-lite" as const;
const EMBED_DIMS = 1024;

/**
 * 将单条文本转成 1024 维向量。
 * inputType:
 *   - "document" 用于索引（帖子文本）
 *   - "query"    用于搜索（用户输入）
 */
export async function embedText(
  text: string,
  inputType: "document" | "query" = "query"
): Promise<number[]> {
  const res = await voyage.embed({
    input: [text],
    model: EMBED_MODEL,
    inputType,
  });
  const item = res.data?.[0];
  const vec = item?.embedding;
  if (!vec || vec.length !== EMBED_DIMS) {
    throw new Error(`Unexpected embedding dims: ${vec?.length}`);
  }
  return vec;
}

/**
 * 批量嵌入文本（最多 128 条/次，Voyage 限制）。
 * 返回与输入顺序对应的向量数组。
 */
export async function embedBatch(
  texts: string[],
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await voyage.embed({
    input: texts,
    model: EMBED_MODEL,
    inputType,
  });
  return (res.data ?? [])
    .slice()
    .sort((a: EmbedDataItem, b: EmbedDataItem) => (a.index ?? 0) - (b.index ?? 0))
    .map((d: EmbedDataItem) => d.embedding ?? []);
}

/**
 * 用 Voyage rerank-2-lite 对候选文档重排序。
 * 返回按相关性从高到低排列的原始下标数组（最多 topK 个）。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  topK = 8
): Promise<number[]> {
  if (documents.length === 0) return [];
  const actualTopK = Math.min(topK, documents.length);
  const res = await voyage.rerank({
    query,
    documents,
    model: RERANK_MODEL,
    topK: actualTopK,
    returnDocuments: false,
  });
  return (res.data ?? [])
    .slice()
    .sort((a: RerankDataItem, b: RerankDataItem) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
    .map((d: RerankDataItem) => d.index ?? 0);
}

