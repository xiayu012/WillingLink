-- ============================================================================
-- 合租房世界模型 · 第十二批：三个结构性缺口（用户直接指出，逐条排查后确认）
--
-- 起因（2026-09-04 用户）："你再看看提示词大脑。看看还有什么是它需要的能力。
-- 全都装好手脚"——对着 constitution.md 十七条 + core.md 三道闸，逐条核对
-- 现有 17 个工具，找到三类结构性能力目前没有：
--
--   ② 案子结案时无法确认"受影响的人是不是都通知到了"（宪法第十二条）
--   ③ 没有"以后提醒自己"的能力（core.md 三道闸第二条要求"轮换周期不得
--      短于一个月，且每次都由你主动提醒"，但 AI 只有被动回复）
--   ④ 公平份额（三道闸第一条：几个人分/每人多少/差多少）全靠模型每次现算，
--      没有存成可查的数据，容易在跨轮对话里算出前后不一致的份额
--
-- 逐条诊断：
--
-- ③ 不需要新表。`coliving.obligation` 表在最初的世界模型里就建好了
--   （kind: "谁该在什么时候做什么"，带 due_at/status），但排查发现
--   **从建表到现在没有任何代码写过它、outreach.ts 也没有 obligation_due
--   这个 job**——是一张写好了没接上电的表。这次要做的是接线：给模型一个
--   scheduleReminder 工具能写这张表，outreach.ts 加一个 obligation_due
--   job 定期扫描到期的提醒并触发。
--
-- ② 需要新表 case_party：记录"这件事影响到谁"，与 case_position 是两个
--   不同的概念——case_position 记的是"谁对这件事表过什么态"（可能没表态
--   过的人也被这件事影响到，比如厨房时段冲突里，还没抢开口的第四个室友）。
--   closeCase 结案时对着这张表核对，缺了谁没通知到就提醒模型。
--
-- ④ 需要新表 case_share：记录一次算好的份额（这件事、给谁、多少、单位），
--   模型自己算完之后存一次，以后的轮次直接读，不用重新心算——
--   跟 case_position 是同一个哲学："存原始判断结果，不是存判断过程"，
--   算的逻辑还是模型自己的，代码只保证算出来的东西不会在下一轮走样。
-- ============================================================================

-- ── ② 案子影响到谁：结案时用来核对"都通知到了吗" ─────────────────────────
create table if not exists coliving.case_party (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references coliving.case_file(id) on delete cascade,
  household_id    uuid not null references coliving.household(id) on delete cascade,
  person_id       uuid not null references coliving.person(id) on delete cascade,
  -- 这个人为什么算在这件事里（一句话，方便模型回头看的时候记起来）
  reason          text,
  -- 结案时是否已经给他发过"最终结果"这条消息。null=还没判断过，
  -- true/false 由 closeCase 校验时用 recentOutbound 自动核对，
  -- 也允许模型手动标记（比如这个人已经在协商过程中充分知情，不需要单独一条）
  notified        boolean,
  created_at      timestamptz not null default now()
);
create unique index if not exists case_party_case_person_uniq
  on coliving.case_party (case_id, person_id);

-- ── ④ 算好的份额：存一次，以后的轮次直接读 ────────────────────────────────
create table if not exists coliving.case_share (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references coliving.case_file(id) on delete cascade,
  household_id    uuid not null references coliving.household(id) on delete cascade,
  -- 分的是什么（"周一到周五晚间灶台时段"），同一件事可能分好几种东西
  resource        text not null,
  person_id       uuid not null references coliving.person(id) on delete cascade,
  -- 这个人分到多少，单位随事而定（分钟/次/份），amount+unit 合起来才有意义
  amount          numeric not null,
  unit            text not null,
  -- 为什么是这个数，不是均分（作息硬约束/医疗需要/既有书面约定）——
  -- 闸一要求"差距要说得出依据"，这里把依据存下来，跨轮引用时不用重新现编
  rationale       text,
  created_at      timestamptz not null default now()
);
create index if not exists case_share_case_idx on coliving.case_share (case_id);

-- ── ③ 给 obligation 接线：outreach.ts 需要按 due_at 扫描，之前没有索引对齐
--   实际查询模式（household + 只看 pending + 按 due_at 排序）───────────────
create index if not exists obligation_due_scan_idx
  on coliving.obligation (household_id, due_at)
  where status = 'pending';
