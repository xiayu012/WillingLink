-- ============================================================================
-- 合租房世界模型 · 第二批
--
-- 起因（2026-08-30 用户）：
--   · 房屋规则不要做成"有张表等着填"，要靠问话形成
--   · 安静时段这类**共同生活的规则由住的人一起定，不是房东规定**
--     ——房东不是权威，居住权是平等的，他多的只是产权与法定义务
--   · AI 要能主动发起（回访、跟进、征询），不能只会被动回话
--
-- 幂等，可重复执行。
-- ============================================================================

-- ── 规则：要记得问过谁，才谈得上「共同形成」──────────────────────────────
-- agreed_by 已有（谁同意）。这里补「问过谁」和「谁提了异议」，
-- 三者合起来才能判断这条规则是不是真的走完了一轮征询。
alter table coliving.rule
  add column if not exists consulted uuid[] not null default '{}',
  add column if not exists objected uuid[] not null default '{}',
  -- 默认方案先执行，问过一轮之后才算真正成立
  add column if not exists consulted_at timestamptz;

-- ── 人：主动关怀必须能关掉（轻管理第 8 条：不能关的关心是骚扰）──────────
alter table coliving.person
  add column if not exists proactive_ok boolean not null default true,
  -- 最近一次主动找他是什么时候，用于控制频率
  add column if not exists last_outreach_at timestamptz,
  -- 入住日期：头两周是唯一低成本建立约定的窗口，主动关注要密一些
  add column if not exists onboarded_at timestamptz;

-- ── Case：回访要有节奏，不能今天问了明天又问 ────────────────────────────
alter table coliving.case_file
  add column if not exists last_followup_at timestamptz,
  add column if not exists followup_count integer not null default 0;

-- ── 主动发起的记录：哪一次 cron、做了什么、为什么 ────────────────────────
-- 不复用 decision 表：那是「对某件事的治理判断」，这里是「这一轮扫描做了什么」，
-- 两者的复盘问题不一样（判断对不对 vs 有没有骚扰住户）。
create table if not exists coliving.outreach_run (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid references coliving.household(id) on delete cascade,
  job             text not null,   -- case_followup / rule_consult / onboarding / obligation_due
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  considered      integer not null default 0,
  acted           integer not null default 0,
  skipped_reason  jsonb not null default '{}'::jsonb,
  error           text
);
create index if not exists outreach_run_time_idx
  on coliving.outreach_run (started_at desc);

-- ── Knowledge / Case 的向量检索 ─────────────────────────────────────────
-- 数据量小的时候顺序扫也够快，但建了不亏（hnsw 支持增量插入）。
create index if not exists case_embedding_idx
  on coliving.case_file using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunk_embedding_idx
  on coliving.knowledge_chunk using hnsw (embedding vector_cosine_ops);
