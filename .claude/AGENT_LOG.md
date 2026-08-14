# Agent Log — Claude 会话决策记录

> 本文件专供 Claude 阅读（用户明确说不给人看，可写得技术密集）。目的：让后续
> 会话不必重新考古"为什么代码长这样"。每个会话结束时**追加**一节，倒序排列
> （最新在上）。记录格式：做了什么 → 为什么 → 踩过的坑 → 遗留问题。
> 用户（夏宇）沟通用中文；他常要求"只讨论别改代码"——严格遵守，讨论清楚后他会
> 明确说"动手"。

---

## 2026-08-14 · 废弃"换一个"→ 严格模式 → 入库管线修复 → LLM-native 查询理解

涉及 commits：`f20bf1b` → `76893f8` → `650d8b2`（均直接推 main，用户要求）。
远程分支 `废弃换一个` = 切换前 main 的快照（用户要求创建，勿删）。

### 1. 产品方向（用户原话的意译，做任何搜索相关决策前先对齐这个）

- 旧交互：searchRental 每次只返回 1 条 + 自动放宽兜底，用户被迫反复说"换一个"
  刷不匹配的结果。用户要求废弃。
- 新契约：**严格按用户说出的需求筛选，一次最多 5 条，没有就如实说没有**。
- 用户后来专门补充澄清："严格"是**偏严格**，不是百分百硬筛选——他不想要老套的
  软件开发思路（堆正则、精益求精的硬过滤）。**这个项目要 LLM-native**：
  租房帖和查询都是自然语言，理解交给 LLM，数据库硬筛选不必做到极致，
  LLM 本来也做不到稳定 100%。
- 由此确立的架构分工（改动前先确认没有破坏这个分工）：
  - **查询理解层 = 调用工具的聊天 LLM**。它在调用 searchRental 时传结构化参数
    （city/rentMin/rentMax/bedroomsNum/四个布尔），地名→城市靠它的世界知识
    （SOMA/Mission→San Francisco，Moffett Park→Sunnyvale，UCB→Berkeley）。
    零额外延迟零成本。性别限制、不要中介、不要室友这类 schema 表达不了的需求，
    prompt 教它转成 mustNotContain。非租房请求（租车等）和湾区外城市，
    prompt 教它**不调工具**。
  - **房源理解层 = 入库时的 LLM 提取**（bedroomsNum/city/petFriendly/couplesOk/
    utilitiesIncluded/parkingIncluded 六列）。
  - **硬筛选 = 偏严格兜底**：只剔除"可证明违反"的行（字段 null 时宽容放行）；
    正则 NL 提取只在聊天 LLM 没传参数时兜底。
  - **排序 = Voyage 语义 rerank**，相关性是 rerank 的职责，不是过滤器的。

### 2. 关键代码位置与设计

- `lib/ai/tools/search-rental.ts` —— 一个文件两套逻辑，**故意的**：
  - 文件上半部分是 LEGACY"换一个"级联（P1 vector → P2 city → P3 keyword →
    P4 last-resort，带自动放宽和加权随机 pickBest）。**用户明确要求保留勿删**，
    `SEARCH_LEGACY_PICK_ONE=1` 切回（tool 与 prompt 同步切换）。
  - `═══ STRICT MODE ═══` 横幅以下是现行默认逻辑。
  - `buildStrictPredicate(query, params?)` 是**唯一的匹配语义定义**，运行时和
    评测共用——改匹配语义只改这里，两边自动一致，永不漂移。
  - `createSearchRentalTool` 是分发入口，按 flag 选 strict/legacy。
- `lib/ai/prompts.ts`：`STRICT_RENTAL_SECTION` / `LEGACY_RENTAL_SECTION` 两段，
  同一个 flag 选择。文件里大量 `?` 是历史编码损坏（mojibake），legacy 段落保持
  原样没修；strict 段落是干净中文。
- `lib/rental/query-constraints.ts`：`extractBooleanPrefs`（NL 布尔需求提取，
  只提取"要求为 true"，否定句如"不养宠物"不构成约束）。
- `lib/rental/cities.ts`：`NON_BAY_CITY_RE` + `isOutOfBayQuery`（湾区外查询
  直接拒绝）。评测和运行时共用，别在评测里另写一份。
- 评测：`scripts/search-eval.ts`，跑法
  `pnpm search-eval -- --source wanted --limit 181`（求租帖全量）。
  判定：返回的每条房源用 buildStrictPredicate 核验，任何一条不满足或
  "库里有却返回空"→ CODE_BUG；空结果且库里确实没有 → DATA_GAP（正确行为）。
  **CODE_BUG=0 才能发布**。LLM judge 用 OPENAI_API_KEY（gpt-4.1-mini）,
  失败时静默返回 null——**judge 数字为 0 时先确认 key 有额度，否则可能根本没跑**
  （2026-08-14 就发生过：额度耗尽，judge 全程静默失败，汇报了假的"判0分:0"）。

### 3. 数据现实（决定了很多设计取舍，改筛选逻辑前必读）

- 表 `XhsRentalListing` ~765 行（持续增长，userscript 实时入库）。
- **结构化列曾经覆盖率极低**：backfill 前 rentNumeric 13%、bedroomsNum 3%、
  city 3%。原因：入库 route 从不填这六列，唯一填充途径是手动脚本
  `scripts/backfill-listing-fields.ts`，且它曾因两个类型错误跑不了
  （tsx 不检查类型所以其实能跑，真正原因是 OpenAI key 无额度）。
- 2026-08-14 全量 backfill 完成：738 行成功 0 失败 → bedroomsNum 90%、
  city 88%。**新行由 rental-ingest 的 after() 自动提取**（见 §4），
  手动脚本降为兜底补漏。
- 脏数据模式（都已在 strict 谓词里防御，防御代码别删）：
  - `rent` 文本列混有区号（"415"）、邮编（"94118"）、日租（"40刀/日"）——
    `rentFromText` 有合理性窗口 300–15000 并排除日租。
  - `bedrooms` 列偶尔与标题矛盾（标题"1B1B"存成"2"）——标题 NbNb 模式优先于列。
  - LLM backfill 有时返回**字符串 "null"** 而非 JSON null（city 列出现过 39 行，
    已清洗）。读 city 列的代码都要 `col.toLowerCase() !== "null"` 防御。
  - 库里有湾区外杂行（圣地亚哥 UCSD 转租等）和非住宅行（漂流广告、储物间）——
    `listingOutOfBay`（city 列权威优先，列缺失才文本探测）+ `isNonRentalRow`
    （储物/storage 标题 + 无租房信号）过滤。
  - 标题错位行（标题=漂流广告，正文=房源）：根因是 userscript 全局
    `document.querySelector(".title")` 命中详情弹层背后的瀑布流卡片标题。
    0.13.4 已修（只从 #detail-title 或正文所在容器抓，抓不到宁可不发）。
    **存量错位行未清洗**（量小，rawText 是对的，影响有限）。

### 4. 入库链路（现状）

userscript (`tools/xhs-guide/userscript/xhs-guide.user.js`, 现 0.13.4)
→ POST `/api/xhs/rental-ingest`
→ 分类（other/wanted/listing）
→ `parseListingFields` 正则填文本列 + `parseRentNumeric` 填 rentNumeric
→ 插入
→ `after(Promise.allSettled([embedListingSafe, extractStructuredFieldsSafe]))`
   （embedding + 六列 LLM 提取并行，失败不影响入库；LLM 走
   `getTitleModel()` = gateway claude-haiku，线上 Vercel 可用）。
兜底脚本：`scripts/embed-listings.ts`（embedding）、
`scripts/backfill-listing-fields.ts --limit N`（六列，直连 OpenAI gpt-4o-mini）。

### 5. 环境/凭证事实（本地 = GitHub Codespace）

- `.env.local`：POSTGRES_URL（Neon，可用）、VOYAGE_API_KEY（embedding/rerank，
  可用）、OPENAI_API_KEY（**2026-08-14 用户充值过**，backfill+judge 用它）、
  VERCEL_OIDC_TOKEN（**已过期**，所以本地 gateway 不可用——聊天模型、
  getTitleModel 本地都调不通；线上不受影响）。
- 刷新 OIDC 需用户自己跑 `npx vercel env pull`（要登录，Claude 不能代跑）。
- 用户不常持有本地电脑——**别把关键状态只留在本地**，写进本文件并推远程。

### 6. 本次会话修过的 bug（按发现顺序，防止回归）

1. `after()`（next/server）在请求作用域外抛异常 → 评测/脚本里整个 execute 进
   catch 变 SEARCH_FAILED。修复：`scheduleAfterResponse` shim（try/catch 降级
   直接执行）。**任何在 tool execute 里用 after() 的新代码都要走这个 shim**。
2. 结构化列覆盖 3% 导致"严格"筛选没有牙齿 → `withRecoveredFields` 查询时从
   文本恢复 rent/bedrooms（backfill 完成后仍保留，作为新行未提取完成前的兜底）。
3. 评测 SQL 没选 `rent`/`bedrooms` 列 → 评测端与运行时看到的行不一致，产生假
   CODE_BUG。教训：**评测的 SELECT 必须包含谓词触碰的所有列**。
4. `listingOutOfBay` 早期版本"有 city 列就放行"→ backfill 把圣地亚哥行的 city
   填成 "San Diego" 后反而漏网。现版本：列值权威，列值命中 NON_BAY 即拒。

### 7. 当前基线（2026-08-14 收官数据，回归时对照）

`pnpm search-eval -- --source wanted --limit 181`：
169 条 → **PASS 154 / DATA_GAP 15 / CODE_BUG 0 / judge-0 12**。
剩余 12 个 judge-0 是评测直连工具的固有盲区（非租房查询、性别等软需求——生产
路径由聊天 LLM 传 mustNotContain/不调工具解决，评测跳过了聊天层），不算 bug；
若要消除需给评测加"模拟聊天层"的 LLM 参数填充，成本收益自己权衡。

### 8. 遗留 / 未做（有意不做的写明原因）

- searchWanted（房东找租客侧）**仍是旧的"换一个"逻辑**——用户没要求改，范围
  控制。若将来要改，照 searchRental 的 strict 模式抄。
- 存量标题错位行未清洗（见 §3）。可选做法：用 LLM 对比 title 与 rawText 首行
  相似度批量修复。
- `rentNumeric` 覆盖仍只 ~14%（backfill 六列不含它）。strict 谓词的
  `rentFromText` 在兜底，暂够用；要提升就把 rent 数值提取加进 backfill schema。
- 预存在类型错误只剩 `components/ai-elements/speech-input.tsx`（与本次无关，
  没修）。lint（ultracite）在 main 上本来就有几十个风格错误，**不是本次引入**，
  修自己新增代码的即可，别顺手全修（diff 会失控）。
- `.github/` 目录在工作区未跟踪（不是 Claude 创建的，没动没提交）。

### 9. 更早的仓库事实（来自个人 memory，写进来防丢失）

- `tools/xhs-guide` 有两套本地 LLM 实现：低延迟版是 main 现行版（d25a742 起）；
  串行版 0.9.3 保留在 e3c4f37/af8cec2 及远程分支——**勿删勿覆盖**。
