-- ============================================================================
-- 合租房世界模型 · 第九批：修 05 号迁移造成的数据损坏
--
-- 05 号迁移里我写了：
--   update coliving.membership set resides = null
--     where resides = true and note is null;
--
-- 本意是「这次改造之前的 true 都是代码默认填的，不算确认过」。
-- **但那是错的**：`addResident` / `enrollLandlord` / `moveIn` 都是显式写 true，
-- 那是断言不是默认值。一刀切清成 null 之后：
--
--   · 上下文里「确认住在这里的」变成 0 人
--   · 「分配共用资源就按 N 个人算」没了分母
--   · 规则征询算不出「3 个人里已经 2 个同意」
--
-- 用户看到的表现：三个人都确认了，AI 还在问第三个人。
--
-- 除了那次迁移，**没有任何代码路径会把 resides 写成 null**，
-- 所以现存的 null 全都是被那条 update 清掉的，恢复成 true 是还原不是猜测。
-- ============================================================================

update coliving.membership
set resides = true
where resides is null and valid_to is null;
