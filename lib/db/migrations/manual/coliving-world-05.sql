-- ============================================================================
-- 合租房世界模型 · 第五批：把「我们知道的」和「世界上发生的」分开
--
-- 起因（2026-09-02 用户发现）：房东刚报了租客号码，AI 就给租客发
-- 「刚搬进来这几天住得还顺吗」。**凭什么说人家刚搬进来？**
-- 那人可能已经住了三年，只是我们刚认识他。
--
-- 根因：`onboarded_at` 记的是**录入时间**，提示词把它读成了**入住时间**。
-- 同一类问题还有两处：
--   · `resides` 不知道也默认 true —— 房东到底住不住这儿，我们没问过
--   · 上下文断言「住在这里的一共 N 个人，就是下面这些，没有别人」——
--     房东可能只给了一半号码，而厨房公平分配就建在这个假设上
--
-- 原则：**数据库能表达「不知道」，提示词才不会瞎编。**
-- ============================================================================

-- ── 入住时间：真事实，默认不知道 ────────────────────────────────────────
alter table coliving.person
  add column if not exists moved_in_at timestamptz;

comment on column coliving.person.moved_in_at is
  '他真正搬进来的时间。**只有问出来才填**，null = 不知道。不许拿录入时间顶替';
comment on column coliving.person.onboarded_at is
  '**录入时间**，不是入住时间。我们什么时候把这个人放进系统的，仅此而已';

-- ── 住不住在这里：允许「不知道」────────────────────────────────────────
alter table coliving.membership
  alter column resides drop not null,
  alter column resides drop default;

comment on column coliving.membership.resides is
  'true=确认住在这里，false=确认不住，**null=不知道**。不知道就别猜——
   共用资源怎么分直接取决于这个数，猜错了分配就是错的';

-- 已有的行：只有明确设过的才算确认。这次改造之前的都当作不确定，
-- 因为那时候代码是「不知道也填 true」。
update coliving.membership set resides = null
  where resides = true and note is null;

-- ── 名册全不全 ────────────────────────────────────────────────────────
alter table coliving.household
  add column if not exists roster_complete boolean not null default false;

comment on column coliving.household.roster_complete is
  '名册是否已确认完整。**默认 false**：房东给几个号码我们就有几个，
   不代表这栋房子只住这几个人。分配共用资源前要么确认，要么说清是按已知人数算的';
