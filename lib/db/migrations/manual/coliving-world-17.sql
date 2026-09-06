-- ============================================================================
-- 合租房世界模型 · 第十七批：shadow_run 收紧号码持久化 + 如实记录用了哪个模型
--
-- 起因（上级复审第十六批 Shadow 改动，见 .claude/AGENT_LOG.md 对应条目）：
--
-- 1. `inbound_from` 原来存**真实手机号**（当时的理由是"这张表不进 git，
--    只有运维/开发看得到"）。复审要求即使不进 git，也不该在库里囤积
--    不必要的真实号码。这张表本来就会算出槽位号（`captureSnapshot` 的
--    `phoneMap`），槽位号就够满足这一列的所有实际用途（复核台展示、
--    导出场景时定位是哪个人），不需要真实号码。改成存槽位号。
--
--    影子跑可能在**还没解析出发信人、连是哪栋房子都不知道**的阶段就失败
--    （比如 `resolveSender` 本身抛错），这种情况下没有槽位号可写，
--    所以顺手把 NOT NULL 去掉——失败记录允许这一列是空的。
--
-- 2. 之前的注释写"预留了 SHADOW_MODEL_ID 这个口子"，但全仓从未真正实现，
--    候选版本实际跑的永远是跟生产一样的模型——即"同一份代码同一个模型
--    跑两次"，不是真正的 A/B。`runColivingTurn` 其实早就支持 `modelId`
--    参数覆盖，只是 shadow.ts 没用。这批把它接上：`COLIVING_SHADOW_MODEL`
--    设了就用来跑候选版本，不设就跟生产用同一个模型（如实退化，不再假装
--    是 A/B）。两侧实际用的模型都记下来，复核时能看出这次差异是不是
--    模型造成的，而不是只能猜。
-- ============================================================================

alter table coliving.shadow_run alter column inbound_from drop not null;

alter table coliving.shadow_run add column if not exists production_model text;
alter table coliving.shadow_run add column if not exists shadow_model text;
