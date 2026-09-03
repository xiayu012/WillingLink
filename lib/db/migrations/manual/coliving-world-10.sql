-- ============================================================================
-- 合租房世界模型 · 第十批：别让模型判断布尔结论，让它只说事实
--
-- 起因（2026-09-03 用户）：resides 被一条迁移清空，用户问「是不是该删掉
-- 一些字段，让 AI 架构级有自己的记忆，而不是靠开发字段被迫记忆」。
--
-- 查了两处："deduce, don't store"（不要缓存可以现算的结论）和
-- Zep/Graphiti 的实际做法（**从不缓存"是否完成"，永远从当前有效的事实
-- 现场推导当前状态**——这正是用户之前那份调研里评分最高的路线）。
--
-- 对照代码找到两处真正的病灶，两处都是同一个模式：
-- **模型被要求算一个布尔结论，而代码手里已经有算这个结论要的原始数字**。
--
--   confirmRoster 工具：模型传 total，还要传 complete（total==已知人数？）——
--   而 execute() 里第 642 行 `known` 已经算出来了，却被晾在一边不用，
--   改用模型自己判断、经常判错的 complete。
--
--   rule.consulted_at：一个需要被"手动关掉"的完成标志，
--   而 pendingNames（谁还没表态）本来就能现场算出来，
--   算出来 length===0 就是"完成"，根本不需要另存一个标志位再记得去关它。
--
-- 这批只加列、不删列（删列不可逆）：declared_size 是新的事实列，
-- roster_complete 保留在表里但停止被应用代码依赖，减损面而不冒风险。
-- ============================================================================

alter table coliving.household
  add column if not exists declared_size integer;

comment on column coliving.household.declared_size is
  '有人说过"这屋一共住几个人"，这里存那个原始数字。**只存事实**——
   "名册是否已经收全"不再存成另一个字段，改为每次现场拿这个数字
   跟当前成员数比较算出来。别让模型去判断这个布尔结论：
   算术交给代码，代码手里本来就有两个操作数。';

comment on column coliving.household.roster_complete is
  '已废弃：被 declared_size 取代（现算，不缓存判断结果）。
   列保留但应用代码不再读写它，避免又一次"删列引发迁移事故"。';

comment on column coliving.rule.consulted_at is
  '仅作审计时间戳（"哪天所有人都表过态了"），**不再是完成判断的依据**。
   完成与否永远现场算：pendingNames（现场对比 membership 与
   agreed_by/objected）为空即完成。存这一列只是因为知道"哪天完成的"
   本身有价值，不是为了当开关读。';
