-- ============================================================================
-- 合租房世界模型 · 第七批：事实 ≠ 推断，且事实本身有有效期
--
-- 起因（2026-09-02 用户）：长期多主体记忆的设计。原来的 memory 表
-- 只有一个自由文本 content，导致两个会随时间复利恶化的问题：
--
-- 1. **推断被当成事实存**。「我上夜班」和「所以他白天睡觉」存得一模一样。
--    几年下来 AI 会把自己的猜测读回去当事实，再基于它做新推断——
--    **记忆被自己污染，而且不可逆**。
--
-- 2. **分不清「记录的有效期」和「事实的有效期」**。
--    valid_from/valid_to 记的是我们什么时候改的记录；
--    但「这周上夜班」和「长期上夜班」在世界里的有效期完全不同。
--    3 月说「11点睡」、8 月说「凌晨3点回」——不是两条并列的记忆，
--    是后者**取代**了前者。
--
-- 取代的判据是 subject_key：同一个人 + 同一个主题 = 只有一条当前有效。
-- 这比按文本相似度去重可靠得多（中文改写的相似度会掉到 0.05）。
-- ============================================================================

alter table coliving.memory
  -- stated=当事人自己说的 · observed=系统观察到的 · inferred=你推出来的
  add column if not exists basis text not null default 'stated'
    check (basis in ('stated', 'observed', 'inferred')),
  -- 谁说的。可能不是这条记忆的主人（室友转述、房东提到）
  add column if not exists stated_by uuid references coliving.person(id),
  -- 主题键：sleep_schedule / work / diet / health / guests / language …
  -- **同一个人同一个主题只留一条当前有效**，新的来了旧的置为 superseded
  add column if not exists subject_key text,
  -- 这条事实在**世界里**什么时候成立。与 valid_from/valid_to（记录有效期）不同：
  -- 「这周上夜班」fact_to 是本周末，「长期上夜班」fact_to 是 null
  add column if not exists fact_from timestamptz,
  add column if not exists fact_to timestamptz,
  -- 被哪条新记忆取代了。留着才能回答「他什么时候改的作息」
  add column if not exists superseded_by uuid references coliving.memory(id);

comment on column coliving.memory.basis is
  'stated=当事人自己说的（可当事实用）· observed=系统观察到的 ·
   inferred=**你推出来的，不是事实**。混淆这三者会让记忆被自己的猜测污染';
comment on column coliving.memory.subject_key is
  '同一个人同一个主题只留一条当前有效。新的来了旧的 superseded，不删——
   保留历史才能回答「他什么时候改的作息」';

create index if not exists memory_subject_current_idx
  on coliving.memory (person_id, subject_key)
  where valid_to is null and subject_key is not null;

create index if not exists memory_basis_idx
  on coliving.memory (person_id, basis) where valid_to is null;

-- 语义召回：向量列早就建好了，一直没人往里写。
-- 「之前是不是也发生过类似的厨房问题」这种问法用 SQL 查不了，
-- 因为说法千变万化（半夜切菜/凌晨有人/别晚上做饭/宵夜吵醒我）。
create index if not exists memory_embedding_idx
  on coliving.memory using hnsw (embedding vector_cosine_ops);
