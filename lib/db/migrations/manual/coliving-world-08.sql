-- ============================================================================
-- 合租房世界模型 · 第八批：把断掉的两环接上
--
-- 起因（2026-09-03 用户）：「感觉数据库只是有表了，没做到让数据库很好地
-- 紧密结合 llm 和代码运转。」照设计稿十五点逐条查，确实有表没跑起来：
--
--   room / observation / obligation  —— **零写入**，建了没人往里放东西
--   updateCase / recordOutcome       —— 函数写了，**没人调用**
--
-- 于是设计稿第十四点那条链
--   House State → Event → Decision → Communication → Human Response → Outcome
-- **断在最后两环**：
--   · Outcome 表永远是空的（「事情后来怎么样了」查不到）
--   · Human Response 没被链接（住户回的那条消息，跟促成它的 Communication
--     之间没有任何关联，「人怎么回应」也就无从分析）
--
-- 这两环恰恰是用户说的「以后最有价值的数据」。这批就是接它们。
-- ============================================================================

-- ── Human Response：住户的回复要能追回到是哪条沟通引出来的 ───────────────
alter table coliving.communication
  add column if not exists responded_at timestamptz,
  add column if not exists response_message_id uuid references coliving.message(id);

comment on column coliving.communication.responded_at is
  '对方回话的时间。**由代码自动关联**，不靠模型判断：
   收到入站消息时，回填到该住户最近一条已发出、尚未有人回应的沟通上。
   没有这个，「AI 说了什么 → 人怎么回应」这条链就断了';

create index if not exists communication_awaiting_reply_idx
  on coliving.communication (to_person_id, sent_at desc)
  where status = 'sent' and responded_at is null;

-- ── 当时 AI 看到了什么 ───────────────────────────────────────────────────
-- 设计稿第十四点要求能回答「AI 当时获得了哪些相关信息」。
-- 原来只存了模块名和字符数，复盘时重建不出它当时看到的世界。
alter table coliving.decision
  add column if not exists context_snapshot text;

comment on column coliving.decision.context_snapshot is
  'Context Builder 当时喂给模型的运行时上下文原文。
   **判断对不对，取决于它当时看到了什么**——只存字符数是复盘不了的';

-- ── 观察：没有经纬度时也要能按地点匹配 ──────────────────────────────────
-- ST_DWithin 需要 geog，而我们通常只有「这栋房子」没有坐标。
-- 补一个按 place_id 直接归属的索引，让同一地点的观察先能用起来；
-- 以后拿到地址再补坐标，空间查询自然生效。
create index if not exists observation_place_time_idx
  on coliving.observation (place_id, observed_at desc);
