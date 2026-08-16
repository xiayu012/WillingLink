# Agent Log — Claude 会话决策记录

> 本文件专供 Claude 阅读（用户明确说不给人看，可写得技术密集）。目的：让后续
> 会话不必重新考古"为什么代码长这样"。每个会话结束时**追加**一节，倒序排列
> （最新在上）。记录格式：做了什么 → 为什么 → 踩过的坑 → 遗留问题。
> 用户（夏宇）沟通用中文；他常要求"只讨论别改代码"——严格遵守，讨论清楚后他会
> 明确说"动手"。

---

## 2026-08-15（三） · 治本：偏好不得成为硬约束 + 空结果必须说得出原因

用户报的 case：求租帖写"房型优先级：1. Studio（最优先）2. 合租，最好有独立
卫浴……短租长租都可"，系统答"数据库没有"，但库里明明有大量合租房源。
根因是**优先级/备选表达被当成死命令**：`extractBedrooms` 见到 `studio` 就返回
0，把所有非 studio 行筛光。用户要求"治本，不只针对这个例子"。

### 1. 根因抽象（改这块前先对齐）

严格筛选此前隐含一个错误前提：**从查询里抽出来的信号 = 硬性要求**。真实用户
语言里大量是"最优先/最好/其次/或者/都可以"这类**偏好与备选**，它们不是可证明
的硬约束。一个偏好被误当硬条件，就会把用户明明接受的房源全部筛掉——表现为
"库里有但说没有"。**新规则：偏好永不进入硬筛选，只由 rerank 与终审体现。**

### 2. 三层一起改（缺一层就漏）

- **聊天 LLM（生产主路径）** `prompts.ts` STRICT 段最前面加了"硬性要求 vs
  偏好"总规则 + 四个反例；`search-rental.ts` 里 city/bedroomsNum/parking 的
  参数描述同步注明"列了备选/说'最好'就不要填"。
- **正则兜底** `query-constraints.ts`：新增 `SOFT_CONTEXT_RE` + `inSoftContext`
  （命中点前后 14 字符窗口内出现优先/最好/或/都可 等词 → 该次命中作废）与
  `hasHardMention`。`extractBedrooms` 改为**全局扫描收集候选值**：候选去重后
  **只有唯一值才构成约束**（"studio或1b1b" → null）；`extractBooleanPrefs`
  四个布尔全部走 `hasHardMention`（"最好有车位" 不再是硬条件）。
  另：`单间` 不再映射 studio=0（那是合租房里的一间，不是整套户型要求）。
- **城市** `cities.ts` 新增 `detectCities`（复数）；strict 谓词只在查询提到
  **恰好一个**城市时才硬锁城市，列了多个备选（"Palo Alto / Menlo Park / MTV"）
  不过滤。副作用修好一个老问题："旧金山湾区找房"以前被硬锁成 San Francisco，
  现在按湾区全域处理。

### 3. 另一半：空结果必须说得出原因（否则永远在打地鼠）

即使规则修好了，将来任何一个条件过严仍会回到"静默说没有"。所以给两条空结果
路径都加了如实解释，**严格契约不变（绝不返回近似房源）**：

- **硬筛选筛空** → `buildStrictPredicate` 新增可选第三参 `omit: StrictField`
  与返回值 `active: StrictField[]`；`findStrictListings` 在 matched=0 时逐个
  "只放宽这一条"重跑谓词，算出 `bottlenecks: [{field,label,wouldMatch}]`。
  纯内存过滤（≤9 次 × ~800 行），零额外 LLM/DB 成本。NO_MATCH 的 action 里
  直接写"放宽「房型」→ 29 个"，并 `console.log("[searchRental] no match,
  bottlenecks")` 进 Vercel log。**评测调用 `buildStrictPredicate(query)` 的
  一参签名保持兼容，谓词语义零漂移。**
- **终审剔空**（谓词有结果、被 verifier 全剔）→ 返回 `cutReasons`（标题+理由），
  action 变成"有 N 个通过硬性条件但复核发现矛盾，用 cutReasons 说明各自卡在
  哪"。这条以前完全没有解释，用户只看到"没有"。

### 4. 验证

- 提取器回归 18/18：`房型优先级：1. Studio（最优先）2. 合租`→null、
  `1b1b或者studio都可以`→null、`最好有车位`→null，同时
  `圣何塞两室一厅`→2、`找个studio`→0、`要有车位`→true 全部保持不变。
- 用户原 case：修前 0 条（totalMatched=0），修后 totalMatched=27、返回 2 条。
- 瓶颈诊断实测：聊天层误传 bedroomsNum=0 时，输出"放宽「城市」→108；
  放宽「房型」→29"——即便上游再犯错，用户也能立刻知道卡在哪。
- 门禁（本节改动后重跑，181 条）：**PASS 122 / DATA_GAP 15 /
  VERIFIER_CUT 44 / CODE_BUG 0 / judge-0 2**——与上一节基线逐项相同，零回归。
  这是预期性质而非巧合：评测 ground truth 与运行时共用同一个
  buildStrictPredicate，放松筛选会同步放松两边，判定自然稳定。
  （反过来说：**评测对"筛选过严"本身是盲的**——谓词误杀时两边一起误杀，
  仍记 PASS。所以"库里有却说没有"这类问题只能靠真实用户反馈和 §3 的瓶颈
  日志发现，别指望评测数字变红。这是本次最值得记住的一课。）

用户报告隐含推理失败的典型 case：两个朋友要整租 2B2B，返回了"2b2b 里空出
一间、神仙室友继续住"的合租帖——结构化列（bedroomsNum=2）全部通过，但言下
之意矛盾。跟用户讨论了三条路线后，**用户拍板只走路线 C**，并给了明确边界：

- **路线 A（offeredScope/capacity 列 + partySize 参数）彻底不做**；
  roomType/listingType 两列继续闲置。**别自作主张去做**。
- **路线 B（入库事实层 JSONB）彻底不做**。
- verifier 剔除权限**放开**（不采用"只剔确信违反、不确定放行带提示"）：
  宁缺毋滥，用户明确说接受空结果/更少结果（"用户很愿意多阅读搜索比较失败的"）。
  唯一保留的宽容规则：帖子对某需求**沉默**不算矛盾，不因沉默剔除。
- 剔除决策只进 Vercel log（console.log），**不建人工复核管道**，用户自己派人
  看 log。聊天层 prompt 完全不动（决策 3 被否）。
- 用户追求"代码优雅、改动少"，钱不敏感（每次搜索 ~$0.005-0.01 可接受）。

### 实现（4 个文件）

- `lib/ai/verify-listings.ts`（新）：`verifyListingsAgainstQuery(query, listings)`
  —— **一次** LLM 调用，输入用户需求原文 + ≤5 条候选原文（各截 1200 字），
  输出要剔除的序号+理由。**只做减法 + fail-open**：任何失败原样放行，
  搜索永不因终审挂掉。
- `providers.ts` 新增 `getVerifierModel()` = gateway claude-sonnet-4.5。
- `search-rental.ts` strict execute：findStrictListings 之后过终审；剔除时
  `console.log("[searchRental] verifier cut", JSON.stringify({query, cut}))`
  进 Vercel log；新 phase `STRICT_VERIFIER_EMPTY`；工具结果新增
  `verifierCutCount`。
- `search-eval.ts`：新判定 VERIFIER_CUT（空结果 + groundTruth>0 +
  verifierCutCount>0），不算 CODE_BUG、不挂门禁。另：SEARCH_FAILED 现在
  重试一次再定性（181 连发下 Neon/gateway 偶发瞬时故障曾造成 3 个假 CODE_BUG）。

### 调试史（都是真踩过的坑，换模型/改输出格式前必读）

1. **haiku 不能胜任终审**：稳定臆造用户属性——查询只说"95134 预算3300"，
   它反复以"用户有一只已绝育小猫"为由剔除（把候选帖里反复出现的"无宠物"
   反向脑补成用户有猫），schema 接地（先抽 requirements 清单再判）也压不住。
   换 sonnet 后消失。**别为省钱降回 haiku。**
2. **gateway 对 anthropic 的 generateObject 不稳定**：模型会回显工具模板
   占位符——`{"$PARAMETER_NAME":{…}}`、`{"$parameter":{…}}`、`{"$cuts":[…]}`、
   甚至把 cuts 数组二次编码成 JSON 字符串，NoObjectGeneratedError 随机出现。
   拆壳救援写成了九头蛇，最终**放弃 generateObject，改 generateText +
   prompt 定 JSON 格式 + 自行解析校验**（temperature 0）。
3. **模型引用原文时输出未转义英文双引号**（`"reason": "帖子要求"一年起租"…"`）
   → JSON.parse 崩。修复：prompt 要求引用一律用「」+ `repairInnerQuotes`
   启发式（字符串内 `"` 后面不是 `,}]:` 就转义）。修复后 5 轮 ×3 查询零失败。
4. **fail-open 曾被击穿**：AI SDK beta 的错误对象让 node util.inspect 自身抛
   TypeError，`console.error(error)` 在 catch 里再抛、异常逃逸成 SEARCH_FAILED。
   所以 catch 里只打印 `error.name: error.message`，**永远别把 AI SDK 错误
   对象直接丢给 console.error**。

### 验证与新基线（2026-08-15，verifier 激活）

- 本地 gateway 已可用：用户在 .env.local 加了 AI_GATEWAY_API_KEY（值带引号，
  评测脚本的去引号列表已含它；新脚本记得同样处理）。
- 门禁：181 条 → **PASS 122 / DATA_GAP 15 / VERIFIER_CUT 44 / CODE_BUG 0 /
  judge-0 2**（judge-0 从 14 → 2，terifier 把语义跑偏的基本剔干净了）。
  VERIFIER_CUT 数随 LLM 波动（±10 正常），CODE_BUG=0 仍是唯一硬门禁。
- 抽查 44 个剔空的理由：性别限制、求租帖混入、2b1b≠2b2b、共享卫生间≠独卫、
  "现室友继续住→无法整租"、湾区帖对科州/成都查询——全部有据，无臆造。
- 用户原始 case（两人整租 2B2B vs "神仙室友"合租帖）：正确剔除。

### 遗留

- 生产上 verifier 的剔除质量**没有自动评测**（设计如此）：Vercel log 搜
  `verifier cut` 和 `[verifyListings] fail-open` 抽查。乱剔的第一调整点是
  system prompt 的"沉默不算矛盾"边界；解析失败率上升先看 fail-open 日志里
  的原始输出片段。
- gpt/search route（GPT Actions）与 legacy 级联**没接** verifier（范围控制）。
- 终审延迟：sonnet 一次调用约 3-8 秒，用户未表示介意；若将来要压，
  可换回结构化输出（等 gateway 模板修好）或减候选截断长度。

---

## 2026-08-15 · 租期时长（lease duration）进入严格筛选

用户报告：帖子原文用自然语言写了租期（"一年起租"/"短租到9月"），但搜索"短租
3个月"之类时没被严格匹配。本会话把租期变成结构化约束，全链路打通。

### 1. 数据模型（区间重叠，偏严格）

- 双方各是一个"可接受居住月数区间"[min,max]（null=无界/未知）：
  - 房源列 `leaseMinMonths`（起租门槛：一年起租→12，只接受长租/不短租→6）、
    `leaseMaxMonths`（最长可住：转租窗口按日期折算月数，仅限一个月短租→1）。
    已 ALTER TABLE 加入 XhsRentalListing（migrations 目录依旧没有对应文件，
    与上次六列做法一致）。
  - 查询侧约束 `leaseMonthsMin/leaseMonthsMax`（HardConstraints 新字段）：
    "短租3个月"→[3,3]，"6个月以上"→[6,∞)，光说"短租"→(?,6]，光说"长租"→[6,?)，
    "长短租都行"或长短并存→无约束。
- 违反判定 `leaseConflict`（lib/rental/lease-duration.ts）：两区间可证明不相交
  才剔除；任一侧 null 宽容放行。**偏严格的关键语义**：偏好不是约束
  （"prefer 长租"→null），"最多出租一年"只是 max 不是 min。

### 2. 代码位置

- `lib/rental/lease-duration.ts`（新）：查询侧 NL 提取 + 房源侧文本兜底正则 +
  冲突判定，运行时/评测/入库共用。日期窗口（"9/10-10/30"）正则不管，交给 LLM。
- 链路接入点：schema.ts、queries.ts（行类型 + 3 处 SELECT + 2 处 mapper +
  updateListingStructuredFields，改列必须全改）、query-constraints.ts
  （rowViolates/emptyConstraints/hasAnyConstraint）、search-rental.ts
  （StrictSearchParams + tool 参数 leaseMonthsMin/Max + withRecoveredFields
  文本兜底）、extract-listing-fields.ts + rental-ingest route（入库自动提取）、
  prompts.ts STRICT 段（教聊天 LLM 传参）、gpt/search route（SELECT+mapper）、
  search-eval.ts（SELECT 补两列）。
- 回填：`scripts/backfill-listing-fields.ts --lease`（gpt-4o-mini，只处理两列
  双 NULL 行；重跑幂等但会重复花钱）。2026-08-15 全量 803 行 0 失败。

### 3. 踩过的坑（都已修，防回归）

- LLM 过度提取（违背偏严格）：①"prefer 一年起租"被当硬门槛；②"最多出租一年"
  同时填了 min=12；③**长短租双档价帖**（"长租一年$1600/短租3个月起$1800"）被
  拆成 min=12/max=3 的矛盾对（8 行）。修法：prompt 明确三条规则 + SQL 把矛盾行
  改成 min=LEAST(min,max)/max=NULL + withRecoveredFields 对 min>max 的列对视为
  无数据（转文本兜底）。
- 正则误伤防御：`(?<!\d)` 防"2021年"当"1年"；"3月以上"缺"个"时必须带"以上/起"
  防三月=March；"一年级"负向断言；"一个月大概有12天不在家"这类无租 cue 的
  不提取。
- Windows 本地跑 eval：package.json 的 `search-eval` 脚本用了 sh 语法的
  NODE_OPTIONS 前缀，PowerShell/cmd 跑不了，要在 Git Bash 里
  `NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/search-eval.ts ...`。

### 4. 基线（2026-08-15，回归对照）

- `--source wanted --limit 181`：181 条 → **PASS 166 / DATA_GAP 15 /
  CODE_BUG 0 / judge-0 13**（盲区构成与上次相同：非租房查询、性别软需求、
  存量标题错位行）。
- 租期覆盖：804 行中 min 251 行 / max 166 行非空。定向不变量全过：
  "长租一年"零 max<12 泄漏；"租期一个月"零 min>1 泄漏；"短租3个月"下
  124 行一年起租房源全部被剔。
- 存量标题错位行仍未清洗（"利马是秘鲁首都"这类标题还会出现在结果里，
  rawText 是对的）——依旧是已知遗留，见 2026-08-14 §3/§8。

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
