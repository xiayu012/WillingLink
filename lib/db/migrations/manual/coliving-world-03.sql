-- ============================================================================
-- 合租房世界模型 · 第三批：自助加入
--
-- 起因（2026-09-01 用户）：不要填表格的体验。住户不该被审问，
-- 名字都可以先由系统编，AI 在日常对话里听出真名再自己改。
--
-- 所以入住流程收敛成一件事：**把加入码给他，他发条短信带上它。**
-- 幂等，可重复执行。
-- ============================================================================

alter table coliving.household
  -- 短码，给住户念的。不是密钥，只是防止陌生号码乱入某栋房子。
  add column if not exists join_code text;

create unique index if not exists household_join_code_uniq
  on coliving.household (join_code) where join_code is not null;

-- 名字先占位，AI 听出真名再改。记下来「这个名字是不是他自己说的」，
-- 免得 AI 拿自己编的占位名当真名念给住户听。
alter table coliving.person
  add column if not exists name_confirmed boolean not null default false;
