-- ============================================================================
-- 合租房世界模型 · 第十六批：影子跑（Shadow）—— 真实流量喂给候选版本，不发出去
--
-- 起因（2026-09-05 用户对 Conversation Replay 现状打 70 分的评估）：
-- 用户指出四个洞，其中两个是这批要解决的：
--
--   ① **快照数据几乎没有**：Replay 发动机造好了，但 `snapshots/` 目录里
--      只有一个 README，长期 regression corpus 根本没在用 snapshot replay。
--      「优秀的 Replay 发动机已经造出来了，但是油箱基本是空的。」
--   ④ **缺 Shadow**：真人今天新发来的每条短信，应该同时喂给候选版本
--      完整跑一遍、但不发送、只保存结果——这样候选版本吃到的是真人本人、
--      真实措辞、真实时间、真实历史、真实 DB、真实关系、真实当下状态，
--      「只缺最后真正把 Candidate 的短信发出去」。
--
-- **关键设计发现：这两个洞是同一个机制。**
--
-- 影子跑不能直接在真人住的那栋房子上跑候选版本——`runColivingTurn` 会往
-- 库里写 decision / memory / communication，等于拿真人的世界当草稿纸
-- （这正是 guard.ts 记的那次事故的形态）。正确做法是复用已有的快照机制：
--
--     真实消息进来
--       → 生产版本正常跑、正常发短信（不受任何影响）
--       → 影子：把这栋房子在**消息到达之前**那一刻的完整世界状态冻下来
--       → 恢复成一栋全新的 is_test=true 副本
--       → 候选版本在副本上跑同一条消息
--       → 结果记下来，短信一个字都不发
--       → 副本用完删掉
--
-- 于是「跑一次影子」＝「自动沉淀一份带真实世界状态的快照」。油箱自己会满。
--
-- 这张表存的就是每次影子跑的完整证据：冻结的世界状态（可以直接变成一条
-- eval 场景）、生产版本真实说了什么、候选版本会说什么。人来复核、挑出
-- 值得进 corpus 的，用 `pnpm coliving-shadow --export` 导出成场景文件。
-- ============================================================================

create table if not exists coliving.shadow_run (
  id              uuid primary key default gen_random_uuid(),

  -- 哪栋真实房子触发的。**不设外键的 cascade 删除**：这张表是审计/语料
  -- 用途，真实房子被清掉之后这条记录本身仍然有价值（快照是自包含的）
  household_id    uuid,
  household_label text,

  -- ── 触发这次影子跑的真实入站消息 ────────────────────────────────────
  -- 号码在这里**存原文**：这张表只有运维/开发看得到，不进 git；
  -- 导出成 eval 场景时才会被换成槽位号（见 snapshot.ts 的 phoneMap）
  inbound_from    text not null,
  inbound_text    text not null,
  -- 消息到达的时刻。快照按这个时间点截断，保证冻的是"这条消息进来之前"
  -- 的世界，不混进生产版本这一轮自己写的东西
  arrived_at      timestamptz not null,

  -- ── 生产版本真实做了什么（这些短信真的发出去了） ────────────────────
  production_reply    text,
  production_tools    text[],

  -- ── 候选版本在副本上做了什么（一个字都没发出去） ────────────────────
  shadow_reply        text,
  shadow_tools        text[],
  -- 候选版本会主动发给谁、说什么、有没有被审稿拦下
  shadow_outbound     jsonb,
  -- 候选版本跑挂了就记在这儿，不影响生产
  shadow_error        text,

  -- ── 冻结的世界状态 ─────────────────────────────────────────────────
  -- 整份 Snapshot（见 lib/chat/coliving/evals/snapshot.ts 的 Snapshot 类型），
  -- 已经做过号码映射。这一列就是"油箱"：复核通过就能直接导出成场景文件
  snapshot        jsonb,

  -- ── 人工复核状态 ───────────────────────────────────────────────────
  -- pending=还没人看 · exported=已导出成 eval 场景 · rejected=没价值，不进语料
  review_status   text not null default 'pending'
                    check (review_status in ('pending','exported','rejected')),
  review_note     text,

  created_at      timestamptz not null default now()
);

create index if not exists shadow_run_household_idx
  on coliving.shadow_run (household_id, created_at desc);
-- 复核队列按这个查：还没人看过的、最新的在前
create index if not exists shadow_run_review_idx
  on coliving.shadow_run (review_status, created_at desc);
