-- 为 XhsRentalListing 添加 pgvector 向量列，用于语义搜索
-- 运行前确保 Neon / Postgres 已启用 pgvector 扩展（Neon 默认支持）

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "XhsRentalListing"
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- HNSW 索引（cosine 距离），适合高维嵌入 + 近似最近邻搜索
-- m=16, ef_construction=64 是 MVP 阶段的合理默认值
CREATE INDEX IF NOT EXISTS xhs_rental_embedding_hnsw_idx
  ON "XhsRentalListing"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
