import "server-only";

import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai/providers";

/**
 * 判例与资料的向量化。
 *
 * **只用于检索证据，不用于行为规则。** 行为准则留在 doctrine/*.md 里——
 * 规则越多越互相抵消（见 AGENT_LOG 2026-08-30 的「按周轮换」事故），
 * 而"这类事以前怎么收场的"是知识，多多益善。
 *
 * 维度必须与建表时的 `vector(1536)` 一致。换模型就要改列定义并重算全部向量。
 */
export const EMBEDDING_DIM = 1536;

function modelId(): string {
  return process.env.COLIVING_EMBEDDING_MODEL?.trim() || "openai/text-embedding-3-small";
}

/** pgvector 的字面量格式是 `[0.1,0.2,...]`，不是 postgres 数组 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function embedOne(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: getEmbeddingModel(modelId()),
    value: text,
  });
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(modelId()),
    values: texts,
  });
  return embeddings;
}
