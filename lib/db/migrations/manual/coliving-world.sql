-- ============================================================================
-- 合租房 AI 管理员 · 世界事实账本
--
-- 放在独立的 `coliving` schema 里，与 public 下租房搜索那 17 张表物理隔离：
-- drizzle-kit 不扫这个 schema，搜索链路一行代码都碰不到。
-- 全量回退：drop schema coliving cascade;
--
-- 设计原则（来自用户 2026-08-30 的设计稿，改动前先读那份）：
--   · 保存稳定事实；关系带时间范围；保留历史而不是覆盖历史
--   · 环境数据属于「地点 + 时间」，不属于某个人
--   · Event 记录发生了什么，Case 串联需要持续跟踪的事务
--   · Decision（治理判断）与 Communication（实际发出的话）分开存
--   · 临时相关性运行时算，不预先落库成关系
--   · 不建知识图谱：这里的关系都是普通关系库擅长的
-- ============================================================================

create extension if not exists postgis;
create extension if not exists vector;
create extension if not exists pg_trgm;

create schema if not exists coliving;

-- ────────────────────────────────────────────────────────────────────────────
-- 一、Identity —— 人的身份不因搬家而改变
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists coliving.person (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  -- 对方习惯用的语言，进提示词用（"用对方说话的那种语言回"）
  locale          text,
  -- 关联到 web 端账号；短信来的人多数没有账号，可以为空
  account_id      uuid references public."User"(id),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 一个人可以有多个联系方式；短信手机号是目前唯一在用的那种
create table if not exists coliving.person_contact (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references coliving.person(id) on delete cascade,
  kind            text not null check (kind in ('sms','email','xhs','wecom','other')),
  -- 手机号一律存 E.164（+15551230001）
  value           text not null,
  is_primary      boolean not null default false,
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);
-- 同一种渠道的同一个地址只能属于一个人，这是入站消息认人的依据
create unique index if not exists person_contact_kind_value_uniq
  on coliving.person_contact (kind, value);
create index if not exists person_contact_person_idx
  on coliving.person_contact (person_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 二、Physical World —— 住户会换，地点不会
-- ────────────────────────────────────────────────────────────────────────────

-- place 是地理锚点。房子是 place，机场、工地、餐馆也是 place。
create table if not exists coliving.place (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('dwelling','poi','area','other')),
  label           text not null,
  address_line    text,
  city            text,
  region          text,
  postal_code     text,
  country         text default 'US',
  -- 4326 = WGS84 经纬度。geography 而非 geometry：距离直接以米计算
  geog            geography(Point, 4326),
  created_at      timestamptz not null default now()
);
create index if not exists place_geog_idx on coliving.place using gist (geog);
create index if not exists place_kind_idx on coliving.place (kind);

create table if not exists coliving.dwelling (
  id              uuid primary key default gen_random_uuid(),
  place_id        uuid not null references coliving.place(id),
  label           text not null,
  unit            text,
  bedrooms        smallint,
  bathrooms       numeric(3,1),
  -- HMO 设施标准判断要用：几套厨房设施、几套卫浴（见 conflict.md 的人数上限）
  kitchen_sets    smallint,
  bathroom_sets   smallint,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists dwelling_place_idx on coliving.dwelling (place_id);

create table if not exists coliving.room (
  id              uuid primary key default gen_random_uuid(),
  dwelling_id     uuid not null references coliving.dwelling(id) on delete cascade,
  label           text not null,
  kind            text not null default 'bedroom'
                    check (kind in ('bedroom','shared','bathroom','kitchen','other')),
  created_at      timestamptz not null default now()
);
create index if not exists room_dwelling_idx on coliving.room (dwelling_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 三、Social World —— Household 的身份连续，成员会全部换掉
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists coliving.household (
  id              uuid primary key default gen_random_uuid(),
  dwelling_id     uuid not null references coliving.dwelling(id),
  label           text not null,
  status          text not null default 'active'
                    check (status in ('active','dormant','ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  -- 这栋房子的安静时段、垃圾日等，在 rule 表里；这里只放自由说明
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists household_dwelling_idx on coliving.household (dwelling_id);

-- 成员结构的阶段。用来分辨「这栋房子长期如此」还是「某一批人凑在一起才出问题」
create table if not exists coliving.household_epoch (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  seq             integer not null,
  label           text,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists household_epoch_seq_uniq
  on coliving.household_epoch (household_id, seq);

-- 带时间的关系：某人在某段时间以某种身份关联到某个 household。
-- **成员变化不覆盖历史行，而是给旧行填 valid_to，另插一行。**
create table if not exists coliving.membership (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  person_id       uuid not null references coliving.person(id),
  -- landlord 不住在这里，所以身份和「是否居住」分开两列
  role            text not null check (role in ('tenant','landlord','coordinator','other')),
  resides         boolean not null default true,
  room_id         uuid references coliving.room(id),
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  note            text,
  created_at      timestamptz not null default now()
);
-- 同一个人在同一个 household 里同时只能有一条生效关系
create unique index if not exists membership_active_uniq
  on coliving.membership (household_id, person_id)
  where valid_to is null;
create index if not exists membership_person_idx on coliving.membership (person_id);
create index if not exists membership_window_idx
  on coliving.membership (household_id, valid_from, valid_to);

-- ────────────────────────────────────────────────────────────────────────────
-- 四、Observations —— 属于地点和时间，不属于人
-- ────────────────────────────────────────────────────────────────────────────
-- 「Kevin 和这个臭味有关」不落库。需要时按
-- Kevin 当时在哪个 household → household 在哪个 dwelling → 距离多少米 → 时间是否重合
-- 动态推算。房子换了住户，环境历史仍然属于那个地点。

create table if not exists coliving.observation (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,   -- odor / noise / air_quality / construction / weather / ...
  place_id        uuid references coliving.place(id),
  geog            geography(Point, 4326),
  -- 影响半径（米）。运行时用 ST_DWithin(geog, 房子的 geog, radius_m) 判断是否可能相关
  radius_m        integer,
  observed_at     timestamptz not null,
  ends_at         timestamptz,
  severity        numeric(3,2) check (severity between 0 and 1),
  confidence      numeric(3,2) check (confidence between 0 and 1),
  source          text not null check (source in ('resident','sensor','external','inferred')),
  source_person_id uuid references coliving.person(id),
  summary         text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists observation_geog_idx on coliving.observation using gist (geog);
create index if not exists observation_time_idx on coliving.observation (observed_at desc);
create index if not exists observation_kind_time_idx on coliving.observation (kind, observed_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 五、Governance —— Event / Case / Decision / Outcome / Rule / Obligation
-- ────────────────────────────────────────────────────────────────────────────

-- 「case」是 SQL 保留字，表名用 case_file，概念上就是设计稿里的 Case
create table if not exists coliving.case_file (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  kind            text not null,   -- late_night_noise / kitchen_contention / rent_late / ...
  title           text not null,
  status          text not null default 'open'
                    check (status in ('open','monitoring','waiting','resolved','closed','escalated')),
  severity        text check (severity in ('P0','P1','P2','P3')),
  opened_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at       timestamptz,
  resolution      text,
  -- 找相似历史 Case 用（点 11：向量只是普通查询之外的一种检索方式）
  embedding       vector(1536),
  created_at      timestamptz not null default now()
);
create index if not exists case_household_status_idx
  on coliving.case_file (household_id, status, last_activity_at desc);
create index if not exists case_kind_idx on coliving.case_file (household_id, kind);

-- 发生了一件事。可以先不属于任何 Case，后来再挂上去。
create table if not exists coliving.event (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid references coliving.household(id) on delete set null,
  dwelling_id     uuid references coliving.dwelling(id),
  place_id        uuid references coliving.place(id),
  case_id         uuid references coliving.case_file(id) on delete set null,
  kind            text not null,   -- complaint / environmental_complaint / repair_request / ...
  reported_by     uuid references coliving.person(id),
  -- 这件事说的是谁。数组而非关联表：查询永远是「整条读出来」，不需要独立索引维度
  about_person_ids uuid[] not null default '{}',
  occurred_at     timestamptz,
  recorded_at     timestamptz not null default now(),
  severity        text check (severity in ('P0','P1','P2','P3')),
  summary         text not null,
  detail          text,
  payload         jsonb not null default '{}'::jsonb
);
create index if not exists event_household_time_idx
  on coliving.event (household_id, recorded_at desc);
create index if not exists event_case_idx on coliving.event (case_id);
create index if not exists event_about_idx on coliving.event using gin (about_person_ids);
create index if not exists event_kind_idx on coliving.event (household_id, kind, recorded_at desc);

-- AI 的治理判断。**与实际说出口的话分开存**，这样以后能分别评估
-- 「判断对不对」和「表达合不合适」。
create table if not exists coliving.decision (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  case_id         uuid references coliving.case_file(id) on delete set null,
  event_id        uuid references coliving.event(id) on delete set null,
  kind            text not null check (kind in (
                    'observe','stay_silent','log_only','reply_only',
                    'contact_one','contact_group','propose_rule','escalate')),
  -- 决定要联系谁（不含当前对话人）
  target_person_ids uuid[] not null default '{}',
  intent          text,            -- 这次沟通想达成什么
  rationale       text,            -- 为什么这么判断
  confidence      numeric(3,2),
  -- 复盘要用：当时用的什么模型、加载了哪几份准则、上下文多大
  model_id        text,
  doctrine_modules text[] not null default '{}',
  context_chars   integer,
  decided_at      timestamptz not null default now(),
  payload         jsonb not null default '{}'::jsonb
);
create index if not exists decision_household_time_idx
  on coliving.decision (household_id, decided_at desc);
create index if not exists decision_case_idx on coliving.decision (case_id);

-- 事情后来怎么样了
create table if not exists coliving.outcome (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references coliving.case_file(id) on delete cascade,
  kind            text not null check (kind in (
                    'resolved','improved','recurred','worsened','no_response',
                    'escalated','withdrawn')),
  observed_at     timestamptz not null default now(),
  note            text,
  -- 住户对处理结果的反馈，-1 负面 / 0 中性 / 1 正面
  sentiment       smallint check (sentiment between -1 and 1),
  created_at      timestamptz not null default now()
);
create index if not exists outcome_case_idx on coliving.outcome (case_id, observed_at desc);

-- 这栋房子当前生效的规则。Ostrom：规则由住的人参与形成才活得下来，
-- 所以要记下来是谁同意的。
create table if not exists coliving.rule (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  kind            text not null,   -- quiet_hours / kitchen_schedule / trash / guests / ...
  statement       text not null,   -- 一句话说清，是要念给住户听的那句
  status          text not null default 'active'
                    check (status in ('proposed','active','retired')),
  source_case_id  uuid references coliving.case_file(id) on delete set null,
  agreed_by       uuid[] not null default '{}',
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists rule_household_active_idx
  on coliving.rule (household_id, status, kind);

-- 谁该在什么时候做什么。垃圾、清洁这类落到具体人的事。
create table if not exists coliving.obligation (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  person_id       uuid references coliving.person(id),
  rule_id         uuid references coliving.rule(id) on delete set null,
  description     text not null,
  due_at          timestamptz,
  status          text not null default 'pending'
                    check (status in ('pending','done','missed','waived')),
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists obligation_household_due_idx
  on coliving.obligation (household_id, status, due_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 六、Communication —— 实际发生的人际沟通
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists coliving.conversation (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid references coliving.household(id) on delete set null,
  person_id       uuid not null references coliving.person(id),
  channel         text not null,   -- sms / xhs / web / wecom
  external_thread_id text,
  started_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
-- 一个人在一个渠道里只有一条会话线
create unique index if not exists conversation_person_channel_uniq
  on coliving.conversation (person_id, channel);
create index if not exists conversation_household_idx
  on coliving.conversation (household_id, last_message_at desc);

-- Decision 产生的实际外呼。先落库再发送，发送结果回写。
create table if not exists coliving.communication (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references coliving.household(id) on delete cascade,
  decision_id     uuid references coliving.decision(id) on delete set null,
  case_id         uuid references coliving.case_file(id) on delete set null,
  to_person_id    uuid not null references coliving.person(id),
  channel         text not null,
  purpose         text,            -- 这条消息想达成什么（来自 Decision 的 intent）
  body            text not null,
  status          text not null default 'queued'
                    check (status in ('queued','sent','failed','skipped')),
  sent_at         timestamptz,
  external_message_id text,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists communication_household_time_idx
  on coliving.communication (household_id, created_at desc);
create index if not exists communication_decision_idx on coliving.communication (decision_id);
create index if not exists communication_case_idx on coliving.communication (case_id);

create table if not exists coliving.message (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references coliving.conversation(id) on delete cascade,
  person_id       uuid not null references coliving.person(id),
  direction       text not null check (direction in ('inbound','outbound')),
  channel         text not null,
  external_message_id text,
  body            text not null,
  -- 出站消息指回它来自哪次 communication；入站消息指回它在回应哪次 communication
  communication_id uuid references coliving.communication(id) on delete set null,
  sent_at         timestamptz not null default now(),
  payload         jsonb not null default '{}'::jsonb
);
create index if not exists message_conversation_time_idx
  on coliving.message (conversation_id, sent_at desc);
create unique index if not exists message_external_uniq
  on coliving.message (channel, external_message_id)
  where external_message_id is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 七、Memory —— 长期记忆与总结
-- ────────────────────────────────────────────────────────────────────────────
-- 与 Event 的区别：Event 是「发生了什么」，Memory 是「因此我们现在知道什么」。
-- 偏好会过期，所以同样带 valid_from / valid_to，不覆盖。

create table if not exists coliving.memory (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid references coliving.household(id) on delete cascade,
  person_id       uuid references coliving.person(id) on delete cascade,
  kind            text not null check (kind in ('preference','schedule','fact','summary','sensitivity')),
  content         text not null,
  confidence      numeric(3,2),
  source_event_id uuid references coliving.event(id) on delete set null,
  embedding       vector(1536),
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists memory_person_active_idx
  on coliving.memory (person_id, kind) where valid_to is null;
create index if not exists memory_household_active_idx
  on coliving.memory (household_id, kind) where valid_to is null;

-- ────────────────────────────────────────────────────────────────────────────
-- 八、Knowledge —— 外部治理资料与历史判例
-- ────────────────────────────────────────────────────────────────────────────
-- 建好但暂不填充。这里是 RAG 的正确位置：**放证据不放规则**。
-- 行为准则留在 lib/ai/brains/*/doctrine/*.md，不进这张表——
-- 规则越多越互相抵消，见 AGENT_LOG 2026-08-30。

create table if not exists coliving.knowledge_doc (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  source          text,
  kind            text not null default 'reference'
                    check (kind in ('reference','case_precedent','regulation','research')),
  jurisdiction    text,
  body            text,
  created_at      timestamptz not null default now()
);

create table if not exists coliving.knowledge_chunk (
  id              uuid primary key default gen_random_uuid(),
  doc_id          uuid not null references coliving.knowledge_doc(id) on delete cascade,
  ord             integer not null,
  body            text not null,
  embedding       vector(1536),
  created_at      timestamptz not null default now()
);
create index if not exists knowledge_chunk_doc_idx on coliving.knowledge_chunk (doc_id, ord);

-- 向量索引：数据量小的时候顺序扫更快，等有量了再建 hnsw。
-- 建的时候用：
--   create index on coliving.case_file using hnsw (embedding vector_cosine_ops);
--   create index on coliving.knowledge_chunk using hnsw (embedding vector_cosine_ops);
