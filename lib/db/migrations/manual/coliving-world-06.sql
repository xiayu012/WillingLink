-- ============================================================================
-- 合租房世界模型 · 第六批：记忆改成通用的
--
-- 起因（2026-09-02 用户）：「记忆力做得通用些，比如用户打字说了『她』
-- 这个字就能知道性别默默记下。**不依赖我们一次次开发数据库字段。**」
--
-- 原来 memory.kind 有 check 约束，只认五种。加一种事实就得改数据库、
-- 改类型、改上下文的过滤条件——三处不改齐就静默失效
-- （已经犯过两次：name_confirmed 写了没人读，roster_complete 读了没人写）。
--
-- 现在 kind 是自由文本：模型想记什么就起个名字记什么。
-- 约束交给提示词，不交给 schema —— 这类"以后会不断长出新类别"的东西，
-- 用 check 约束是把自己焊死。
-- ============================================================================

alter table coliving.memory drop constraint if exists memory_kind_check;

comment on column coliving.memory.kind is
  '自由文本，模型自己起名：schedule / preference / sensitivity / identity /
   health / work / language / fact …… **不要再加 check 约束**，
   加一种就要改三处代码，漏一处就静默失效';

-- 按人查生效记忆会很频繁，补个索引（原来的带 kind 条件，现在不按 kind 过滤了）
create index if not exists memory_person_all_active_idx
  on coliving.memory (person_id) where valid_to is null;
