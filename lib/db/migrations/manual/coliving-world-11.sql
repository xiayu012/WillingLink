-- ============================================================================
-- 合租房世界模型 · 第十一批：给"多方协调"这件事装一个不会遗忘的能力
--
-- 起因（2026-09-04 用户）：真实上线对话里，房东说"我要六点或七点"，AI 回
-- "你的六点我先记下了，会优先排给你"，转头把六点、七点都排给了另外两个人，
-- 回头告诉房东"只剩八点到九点，你看行不行"——房东上一句刚说过"谁会愿意
-- 八点到九点啊，都饿死了"。整个过程没有把冲突摆出来，也没有最终通知。
--
-- 用户明确说了：**不要我（开发者）定"房东该不该优先"这种业务规则，
-- 让提示词大脑自己看着办；但要给大脑装能力**。
--
-- 诊断：这不是"大脑不会判断"，是"大脑没有不健忘的地方存判断要用的原料"。
-- 房东说过的话、AI 自己许过的承诺，全靠模型在几轮对话之后凭上下文窗口
-- 记住——记住了就好，没记住就是这次这样。跟这个项目里所有"deduce, don't
-- store"系列的教训是同一个道理，只是这次要存的不是能现算的布尔值，是
-- **原始表态本身**：谁、对哪件事、说了什么（想要什么/拒绝什么），
-- 以及 AI 自己对谁许过什么承诺。
--
-- 这张表不是给模型"判断力"，是给模型一个**收口时不能绕过的清单**：
-- 结案（closeCase, kind=resolved）时，如果这件事有记录过表态，必须把
-- 每一条都过一遍、说清楚满足没满足——这是代码强制的，不是提示词里
-- 一句"记得要交代"就能保证的（提示词能被模型忽略，NOT NULL 约束和
-- 工具执行时的校验不能）。**怎么排、谁优先，还是模型自己判断——
-- 这张表只保证判断的时候不会漏看已经说过的话。**
-- ============================================================================

create table if not exists coliving.case_position (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references coliving.case_file(id) on delete cascade,
  household_id    uuid not null references coliving.household(id) on delete cascade,
  person_id       uuid not null references coliving.person(id) on delete cascade,
  -- preference = 这个人说他想要什么；rejection = 明确拒绝了什么；
  -- commitment = AI 自己对这个人许下的承诺（"优先排给你"这类）——
  -- 记 commitment 不是为了约束模型必须兑现，是为了结案时能对着这句话
  -- 自查"我刚才说的和现在定的对不对得上"，对不上要么改方案要么说清楚为什么变了
  kind            text not null check (kind in ('preference', 'rejection', 'commitment')),
  -- 一句话，念给当事人听的那种，不是内部黑话
  statement       text not null,
  created_at      timestamptz not null default now(),
  -- 收尾（closeCase）时才填，之前一直是 null——null 就代表"还没被交代"，
  -- 这是这张表唯一需要模型去更新的字段，而且是通过工具执行时校验强制的，
  -- 不是靠模型自觉
  honored         boolean,
  resolution_note text,
  accounted_at    timestamptz
);
create index if not exists case_position_case_idx
  on coliving.case_position (case_id);
create index if not exists case_position_person_idx
  on coliving.case_position (person_id, created_at desc);
