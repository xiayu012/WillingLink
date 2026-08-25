# Agent Log — Claude 会话决策记录

> 本文件专供 Claude 阅读（用户明确说不给人看，可写得技术密集）。目的：让后续
> 会话不必重新考古"为什么代码长这样"。每个会话结束时**追加**一节，倒序排列
> （最新在上）。记录格式：做了什么 → 为什么 → 踩过的坑 → 遗留问题。
> 用户（夏宇）沟通用中文；他常要求"只讨论别改代码"——严格遵守，讨论清楚后他会
> 明确说"动手"。

---

## 2026-08-24（一，第二轮）· 加上「距离」这个维度

用户实测反馈：「求租…**靠近 GENERSIS AI**…预算1500」返回的全是 Sunnyvale /
San Jose / Santa Clara 的房源。Genesis AI 在 **Palo Alto**，差了二三十公里。

### 根因不是筛选松紧，是系统里根本没有"距离"

复现出来的计划一看就明白：

    锚点 = GENERSIS AI          ← 理解层不认识这家 2025 年的新公司（还拼错了）
    城市 = San Jose/Santa Clara/Sunnyvale   ← **它猜的**，下游照单全收

两个独立的毛病叠在一起：

1. **理解层不认识就猜城市**。猜错的地点比没有地点更糟——用户会以为系统听懂了。
2. **整套系统只会比城市名字符串**。`lat`/`lng` 1215 行里只有 47 行有值（4%），
   `geocodedAt` 全是 0。人类中介会打开地图，我们不能。

### 数据现实（决定了实现路线）

- 500 行能从 locationText / title / rawText 里抠出邮编（41%），共 89 个不同邮编
- 另有 410 行有 city 列
- → **~75% 的房源能在零 API 成本下拿到坐标**

所以路线是"静态表打底 + 地理编码补漏"，而不是"全量 geocode 一遍"。

### `lib/rental/geo.ts`（新）

- `ZIP_POINTS`：~150 个湾区邮编 → 近似质心。**邮编比城市精确一个数量级**
  （San Jose 横跨 20+ 公里，95132 和 95136 差 15 公里），所以 `listingPoint`
  的优先级是 真坐标 → 邮编 → city 列 → 正文识别的城市。
- `LANDMARKS`：~50 个雇主/校园/商圈/枢纽（Google、Meta、TikTok、Stanford、
  UCB、Valley Fair、River Oaks…）→ 坐标。真实语料里"靠近X"的 X 十有八九是这些。
- `haversineKm`、`staticPlacePoint`（免费瞬时）、`geocodePlace`（Google，
  **没 key 就返回 null**，调用方回落静态表）。
- 精度声明写在文件头：邮编/地标是近似质心，±1–2km。它服务"15 公里通勤圈里外"
  这种判断，不是导航。**别拿它算步行路线。**

### QueryPlan 加 near / radiusKm / nearUnresolved

理解层新出两个字段：`nearPlace`（**写成适合查地图的字符串**，不认识就照抄原文，
**明令禁止编造城市**）和 `nearMode`（walk/bike/transit/drive → 2.5/6/12/25 km）。
`planQuery` 里 `resolveNear` 负责静态表 → 地理编码 → 都落空。

**解析成功时把 `cities` 清空**：距离约束比"在不在市界内"精确得多，而且这种句子
里理解层给的城市往往就是猜的。

### 三条关键取舍

1. **`near` 生效时，定不出位置的房源是剔除不是放行。** 这看起来违反"沉默不算
   违反"，其实不是：用户问的就是位置，一条不说自己在哪的帖子无法成为"靠近X"的
   答案；这和 `rowInAnyCity` 对未知城市行的处理是同一条规则。**实测过放行版本，
   后果是半张结果表被"沙城95832雅房分租"这种无坐标行占满**（顺手把
   沙加缅度/Davis/Fresno 加进了 `NON_BAY_LISTING_RE`）。
2. **距离分档不按公里连续排序**（1.5/3/6/10/15km 五档，`DISTANCE_WEIGHT=10`
   压过其它排序信号）。档内保留语义 rerank 的顺序——人也是这么想的，"走路能到"
   和"骑车能到"是两回事，档内差几百米无所谓。
3. **定位不到就反问，绝不假装。** 新 action `LOCATION_UNKNOWN`（prompts.ts 有
   对应段落）：如实说"「X」我定位不到，这批结果的距离没法保证"，然后问用户 X 在
   哪个城市 / 给个地址邮编。这是这次事故最直接的教训——**假装知道的代价是
   用户拿到一堆二三十公里外的房源还以为系统听懂了。**

### 实测（用户原查询）

    改前：Sunnyvale / San Jose / Santa Clara（离 Palo Alto 20-40km）
    改后：0.0km MenloPark → 1.9km 94303 → 1.9km 紧挨palo alto → 1.9km 东帕洛
          → 3.6km Menlo Park → 6.6km Mountain View → 8.1km ×2

其它三条：`公司在94583附近` → San Ramon 0.0km / Dublin 9.4km（库里就这么多）；
`步行到meta`（2.5km）→ NO_MATCH 并给出"放宽「距离」→ 155 个"；
`靠近某个没人听过的XYZ公司` → LOCATION_UNKNOWN，带结果 + 反问。

### 事后补丁：地标匹配的子串碰撞（**已上线过的真缺陷**）

用户配好 GOOGLE_MAPS_API_KEY 之后拿真实公寓名一测，第一条就炸了：

    "Rincon Green apartments San Francisco"  →  Cisco (San Jose)
                              ↑↑↑↑↑  San Fran|cisco|

第一版 `landmarkPointIn` 用的是**裸 `includes()`**。后果：**任何提到
San Francisco 的"靠近…"查询都会被定位到 70 公里外的南湾 Cisco 园区**。
同类地雷：`AI intel|ligent|`→Intel、`re|scu|e`→SCU、`meta`/`amd`/`sfo` 全都是。

修法：地标别名改走 `aliasPattern`（从 cities.ts 导出，ASCII 加词边界、CJK 不加），
和城市表共用同一条规则，两边永不漂移。回归用例：San Francisco→城市而非 Cisco、
AI intelligent→无匹配、rescue→无匹配，同时 meta / apple / TikTok / UCB 照常命中。

**教训：这个 bug 上一轮通过了 181 条门禁**——因为门禁的语料里恰好没有"靠近某处
+ 提到 San Francisco"的组合。地名匹配这类东西必须单独写碰撞用例，别指望端到端
评测覆盖到。cities.ts 当初就是因为同样的理由才做的最长别名优先 + 词边界，
geo.ts 第一版没有沿用，是纯粹的疏忽。

顺带把 Google 的配置错误改成**打日志**：它对 `REQUEST_DENIED` 回的是
HTTP 200 + status 字段，静默 null 会让"key 配错了"和"这个地方查不到"长得一模一样。
实测就是靠打印原始响应才发现是项目没开 Billing。

### 门禁

`search-eval --source wanted --limit 181`（地标修复后重跑）：
**PASS 153 / DATA_GAP 21 / VERIFIER_CUT 7 / CODE_BUG 0 / judge-0 2**
（修复前 154/20/7/0/5——judge-0 从 5 降到 2，正是碰撞修掉的语义跑偏。）

上一轮（加距离层、修复前）：
**PASS 154 / DATA_GAP 20 / VERIFIER_CUT 7 / CODE_BUG 0**（本轮改动前 155/19/7/0，
持平）。`search-recall-eval`：**recall 71.1% → 77.2%，precision 27.0% → 34.4%，
falseEmpty 1**。

两个方向同时变好是有原因的，不是巧合：`near` 解析成功时会**清空 cities**，
理解层猜的那串城市不再参与硬筛（召回上升）；同时距离半径比城市集合精确，
筛掉的都是真的远（精确率上升）。

### 遗留 / 需要用户配合

- **`GOOGLE_MAPS_API_KEY` 已配置，但项目没开 Billing**，所以 geocoding 仍然
  全线 `REQUEST_DENIED`（Google 即使只用每月免费 $200 额度也要求先绑卡）。
  在用户开通结算之前，静态表覆盖不到的地点（新公司、小众楼盘）走
  LOCATION_UNKNOWN 反问用户。开通后 `geocodePlace` 自动生效，无需改代码。
  **判断是否通了：打日志的那行会打出 status，`OK` 即通。**
  **"Genesis AI → Palo Alto" 是我手工加进 LANDMARKS 的，那是针对这一个 case
  的补丁，不是通解。** 拿到 key 之后 `geocodePlace` 自动生效，无需改代码。
- 房源侧的 `lat`/`lng` 仍然只有 4%。有了 key 之后值得写个 backfill 把
  locationText 批量 geocode 进列里，静态表就只剩兜底作用。
- 邮编表是手工整理的近似值，没有对过官方数据。如果将来发现某个邮编的距离判断
  离谱，第一嫌疑是 `ZIP_POINTS` 里那一行。

---

## 2026-08-24（一）· 查询理解层 QueryPlan + 召回评测（伤筋动骨那次）

用户原话："自然语言还是太出乎意料了，但是也要做到像人一样的聪明去搜索出符合
的。允许伤筋动骨的大改。"于是这次动的是**架构**，不是补正则。

### 0. 先量，再改（这一节比结论重要）

改代码之前先拿 `XhsRentalWanted` 的 216 条真实求租帖跑了一次统计，结果直接
决定了后面所有取舍：

- **109 条（50%）`detectCities` 一个城市都认不出来**——它们不是没说地点，是
  说了 Dublin / San Ramon / Emeryville / Pleasanton / 94583 / "公司在
  noe valley" / "步行到meta"，而旧的 18 城表里没有。
- **51 条（24%）说了多个城市**，旧代码的应对是**整条城市约束直接丢弃**。
- 于是**四分之三的查询在完全没有地点约束的情况下搜索**，Dublin 的需求可以拿
  San Jose 的房源来答。这不是"偏严格"，这是聋。
- 另外：1049 行房源里 rentNumeric 只有 137 行（13%），文本兜底能再救 333 行，
  仍有 **579 行（55%）根本没有可比的租金**，预算筛选对一半语料没有牙齿。

**教训：这些数字用读代码是读不出来的，全部来自拿真实语料跑一遍统计。**
下次再有"搜索不够聪明"的模糊反馈，第一步还是这个。

### 1. `lib/rental/query-plan.ts`（新）——唯一的查询理解入口

`planQuery(query, params) → QueryPlan`。一次便宜的 LLM 调用（gpt-4.1-mini，
`getQueryPlannerModel`）把自然语言翻成结构化计划，正则计划 `planFromRegex`
是它的地基兼 fail-open 兜底，聊天模型传的参数最后覆盖（它看得见完整对话）。

**两个根本改变：**

1. **约束是集合，不是单值**。`cities: string[]`、`bedroomsAnyOf: number[]`，
   列了备选 = OR 集合，而不是"放弃过滤"。这是本次召回提升的主要来源。
2. **理解层只有一处**。以前生产路径靠聊天模型传参、评测路径直连工具只剩正则
   ——**门禁测的根本不是线上跑的那套**（2026-08-14 §7 说的"评测固有盲区"就是
   它）。现在运行时和评测都调 `planQuery`，`buildStrictPredicate(plan)` 变成
   纯同步函数，两边共用，永不漂移。

计划里还有 `anchors`（小区/公寓/地标原文，**只加权排序不参与筛选**）和
`prefers`（软性期望，进 `rerankQueryFor` 的查询文本）。偏好必须影响排序，
否则"最好有独卫"等于没说。

回退开关：`SEARCH_PLANNER_OFF=1` → 只用正则计划，一次 LLM 都不调。

### 2. `lib/rental/cities.ts` 重写：城市变成数据

18 城 → 70+ 城，每城带 `aliases` 和 `regions`，**所有正则都由 aliases 生成**
（以前是手写正则再反推别名，两边会漂）。新增 `detectRegions` /
`citiesInRegions`，"南湾/东湾/半岛/三谷"展开成城市集合。

- 扫描是**最长别名优先**：这是 "South San Francisco" 不被吃成 "San Francisco"、
  "East Palo Alto" 不被吃成 "Palo Alto" 的原因。别改成短的优先。
- 同名陷阱写进注释了：Pittsburg（无 h，湾区）vs Pittsburgh/匹兹堡大学（宾州）；
  Richmond CA vs 列治文（温哥华）。**正则处理不了这两个，靠 planner 读上下文**
  ——实测它确实把 "🇨🇦Richmond 列治文天车站" 和 "科州Frisco" 都判成了 outOfScope。
- 效果：房源侧无法确定城市的行从 319 降到 **93（8%）**，城市硬筛的误杀面大幅缩小。

### 3. `scripts/search-recall-eval.ts`（新）——补上唯一看不见的那个失败

`search-eval` 的 ground truth 和运行时**共用同一个谓词**，所以它对"筛选过严"
**结构性失明**：谓词误杀时 ground truth 同步误杀，仍记 PASS。2026-08-15 那节
已经写了"别指望评测数字变红"，这次把它补上。

方法：ground truth **不经过我们任何筛选代码**——向量检索取 top-N 候选，逐条
问 LLM"满足租客说出口的硬性要求吗"，yes 的集合当作事实，再看谓词留下了多少。

    recall      过严探针（认可但被筛掉 = 误杀）
    precision   过松探针
    falseEmpty  "库里有却返回空"，最痛的那种失败

**判官必须和产品契约用同一把尺**：第一版判官把邻市、不同户型、略超预算都算
"满足"，量出来的是"判官比我们宽松多少"而不是"我们过严多少"。加了三条不许通融
之后数字才有意义。报告里同时列"误杀明细"和"返回了却不合格"，两个方向都能查。

**注意：这个指标有噪声**（判官是 LLM，同样代码两次跑 recall 62.8% / 73.1%）。
它适合读明细、抓方向，不适合盯小数点。

### 4. 召回评测第一次跑就抓出四个真 bug（都已修）

1. **布尔需求在"沉默"时剔除**。旧 `satisfiesBooleanPrefs`：列没确认且正文没
   肯定就剔。可绝大多数帖子根本不会专门写"允许养宠物/有车位"——"养猫人…有
   停车位"那条查询库里有 5 个 LLM 认可的房源，谓词一个不剩。**沉默不是矛盾**，
   这既是 CLAUDE.md 的"只剔可证明违反的"，也和终审 prompt 里"帖子对某需求沉默
   不算矛盾"一致，之前两处标准是打架的。改成只在**明确否定**（列 false 或正文
   写"不可养宠/无车位"）时剔，代价用 `preferConfirmed` 在**排序**上补：确认满足
   的排前面，沉默的排后面，而不是把沉默的藏起来。
2. **rentMin 当硬下限**。租客说"预算1500-1900"，1500 是自我定位不是要求——
   1300 的房源没有违反任何东西。现在只有 rentMax 进硬筛，下限只影响排序。
3. **入住日方向搞反**。"8/24即可入住"是**起始日**不是截止日，旧逻辑拿它当硬
   截止，把 8/25 起租的房源全杀了。现在 planner 明确只填"**最晚**能接受的入住
   日"，只给起始日就填 null。⚠️ `coercePlan` 里 moveIn **不能**回退到正则基线
   （`?? base.moveIn`），否则正则又把起始日塞回来——这一行是钉子。
4. **"湾区"被展开成七个区域**。模型偶尔把"湾区找房"填满 regions，展开成全表
   城市，唯一效果是把 city 列缺失的房源全部排除。加了 `BAY_WIDE_RATIO=0.6`
   守卫：区域展开覆盖超过六成城市表 → 视为"整个收录范围"，不构成约束。

另外三个小的，都是评测跑出来的：planner 曾把 "800+sqft" 读成预算 800
（prompt 加了"只有钱才是钱"）；模型不勾 outOfScope 而是把 "Pittsburgh" 老实填进
cities（`coercePlan` 加了守卫：点名的城市全在收录范围外 = outOfScope）；
一条"🏙️匹兹堡转租|The Julian 2b2b"混进东湾结果里（`NON_BAY_LISTING_RE` 补了
匹兹堡/pittsburgh/温哥华，湾区的 Pittsburg 无 h 不受影响）。

评测脚本自己也修了一处：判官的 fetch 没有重试，OpenAI 偶发 headers timeout
直接把整轮炸掉（实测两次）。现在重试 2 次、失败整批记 unsure 并在汇总里报数。

### 5. 门禁数据（回归时对照）

`pnpm search-eval -- --source wanted --limit 181`：
**PASS 155 / DATA_GAP 19 / VERIFIER_CUT 7 / CODE_BUG 0 / judge-0 6**
（上次基线 2026-08-16：153 / 15 / 13 / 0 / 4。）

- **CODE_BUG 0，可发布。**
- VERIFIER_CUT 13 → 7：候选质量变好，终审需要整批剔光的次数少了一半。
- DATA_GAP 15 → 19 是**预期的**：以前四分之三的查询根本没有地点约束，什么都
  能"匹配"；现在 Dublin 的需求真的只看 Dublin，库里没有就如实说没有。
  DATA_GAP 变多在这个产品里是变准，不是变差。

`pnpm search-recall-eval --limit 24 --candidates 32`（新基线）：
**recall 71–75% / precision 27–29% / falseEmpty 0–1**（连续四轮的区间）。

- ⚠️ **recall 不会到 100%，也不该追**。判官比我们的契约宽松（它认"邻市也算
  满足"），而且它是 LLM，抖动几个百分点是常态——同一份代码曾跑出 62.8% 和
  73.1%。门禁线设在 0.65，盯的是"掉到 50%"这种事故。
- ⚠️ **precision 低（~28%）不等于返回了垃圾**。抽查被判 no 的理由，绝大多数是
  我们的列**看不见**的事实：`$12XX` 这种故意打码的价格、藏在散文里的租期窗口、
  比城市更细的片区（"North SJSU"）。真要提升，方向是入库端的字段提取，不是
  放宽/收紧筛选——**改筛选去追这个数字是走错路**。
- 真正该读的是报告里的两份明细：「谓词误杀明细」和「返回了却不合格」。数字只
  用来发现"我是不是搞砸了"。

### 6. 有意没做

- **没有加任何新列**（offeredScope/capacity/roomType 之类）。用户 2026-08-15
  拍板路线 A/B 彻底不做，这次严格遵守：整租 vs 合租一间这类需求走 `prefers`
  → rerank + 终审，不落库。
- 城市硬筛**不做邻市扩散**（严格模式的既有契约）。但"公司在X附近"这类
  **地标推断**的地点，由 planner 直接把通勤可达的城市一起列进 `cities`——
  该扩散的地方在理解层扩散，而不是在筛选层放水。
- `app/api/gpt/search`（GPT Actions）和 legacy 级联**没接** planner，范围控制。
  `rowViolates` 的语义一个字没动（GPT 路由还在用），strict 谓词是把 city /
  bedrooms / 布尔 / rentMin 都从它手里接管过来自己判的。

### 7. 兼容性

工具 schema 新增 `cities` / `bedroomsAnyOf` 数组参数，旧的 `city` /
`bedroomsNum` 保留为 deprecated 单值形式并合并进数组——聊天模型不会因为
prompt 缓存或历史消息里的旧形状而调用失败。`prompts.ts` 的 STRICT 段同步改了，
并写明"列了几个备选不是不填的理由"。

---

## 2026-08-25（二）· comment-reply 架构级重做：三种作用域分开

用户报了 6 个 case（A–F），要求**架构级**解决，"感觉肯定是链路安排问题"。
他判断对了：**6 个里有 5 个是同一个架构错误。**

### 根因：把「单帖动作」建在「对话模型」上

comment-reply 是**无状态的单帖动作**（给这一篇帖子起草评论），却整条链路都跑在
**有状态的对话模型**上（`resolveChatIdForUser` 给帖主一条长期会话，`runChatTurn`
读全部历史 + 全套工具）。这两种语义天然冲突，一个错误长出五个症状：

| Case | 症状 | 来自 |
|---|---|---|
| A | 凭空冒出"情侣入住"约束 | 压缩轮=完整对话轮，模型在"重新生成"而非压缩，顺手编了个 `couplesOk` |
| B | 压缩后换成完全不相干的帖 | 压缩轮带着工具，又调了一次 searchWanted（实测耗时 5.3s） |
| C | 第二次进来丢掉 Dublin/San Ramon | 同一帖主复用会话，上一轮的房源列表污染了新 QueryPlan |
| D | 同帖多次执行，答案越跑越偏 | 同上，历史累积 |
| E | 压缩把**帖主自己的原帖**总结了一遍 | "请缩写"在一段完整对话里有歧义，模型挑了上一条用户消息（实测 1.5s，没调工具） |

### 改法：`lib/chat/engine.ts` 明确分三种语义

| 函数 | 读历史 | 有工具 | 写库 | 用在哪 |
|---|---|---|---|---|
| `runChatTurn` | ✅ 最近20条 | ✅ | ✅ | **对话**：私信/短信/企微 |
| `runPostScopedTurn` | ❌ | ✅ | ✅ | **单帖**：评论草稿 |
| `transformText` | ❌ | ❌ | ❌ | **纯变换**：压缩/改写 |

判断标准写在文件头上：**这次动作的输入应该是什么**。起草的输入是那篇帖子，
压缩的输入是那段草稿，都不是"这个人说过的所有话"。

顺带修了一个**潜伏 bug**：`buildTurnSetup` 算了 `activeTools` 但 `runChatTurn`
从没传给 `generateText`，所以"推理模型不给工具"这条既定行为一直是失效的。

### 另外两个独立 bug

- **Case E 第二个 bug（自帖回流）**：油猴复制正文时先入库，几秒后 comment-reply
  拿同一段正文去搜，搜出来第一条就是帖主自己刚发的那篇（`pending:` 前缀是铁证）。
  修法是复用既有的"已看过"机制：起草前按 rawText 找出自帖
  （`findXhsRecordIdsByRawText`）标成已看过，搜索工具自然跳过。**不新增排除逻辑**。
- **Case F（意图闸太粗）**：只分 seeker/其它，看房体验帖里全是租房关键词就被当
  求租帖。新建 `lib/xhs/post-kind.ts` 六分类
  （seeker/lister/roommate/review/advice/other），只有前三类起草评论。
  正则快路径拆进 `post-kind-rules.ts`（**零 import**，门禁能直接引，不用拖
  `server-only` 和模型层进来）。

### 实测（用户给的 6 个 chatId 的原帖）

    Case A: roommate (ai)   评论 | 自帖排除 1 条
    Case B: roommate (rule) 评论 | 自帖排除 1 条
    Case C: seeker   (ai)   评论 | 自帖排除 1 条
    Case D: roommate (ai)   评论 | 自帖排除 1 条
    Case E: roommate (ai)   评论 | 自帖排除 1 条
    Case F: review   (ai)   跳过 | 自帖排除 0 条
      F 的理由："帖主在更新看房体验，并讨论各个公寓的优缺点，并没有在求租或招租"

**六个全判对**，F 正是用户报的那个。「自帖排除 1 条」那一列同时实证了 Case E
的自帖回流修复——A–E 每篇帖子都在库里被找到并标成已看过了。

### 踩的坑：为了过测试放宽正则，反而踩坏了一个真实 case

正则 `/找室友/` 要求连续字符，真实帖子写的是"找**一位合拍女生**室友"，一条都
命中不了。改成 `[找招募求寻][^。！？!?\n]{0,12}室友`（限同一句内）之后门禁过了，
**但 Case C 从 `seeker` 退化成了 `roommate`** —— 那是一篇"求租一个房间…希望室友
不抽烟"的求租帖，模型本来判对，被放宽后的正则抢走判错。

对比两次真实数据跑批才发现的（放宽前 `seeker (ai)` → 放宽后 `roommate (rule)`）。
功能上没坏（两者都 actionable），但标签是错的，而且**是我为了让测试通过改出来的
退化**。

修法跟 review 那条一致：**有 seeker 信号就别抢，让给模型**
（`roommate > 0 && review === 0 && seeker === 0` 才命中）。求租帖顺带写室友要求
太常见了，正则在这种模糊地带必须让路。门禁里加了一条**专门钉这个的用例**
（"求租帖带室友要求→正则让路给模型"，断言的是**正则不命中**，不是判成什么）。

教训：**改正则去迁就一条测试用例之前，先拿真实语料对比前后**——门禁全绿不等于
没退化，门禁只覆盖它自己写下的那几条。

### 还没做

**post-level 幂等/去重**：同一帖重复调用现在不会再互相污染（单帖作用域已经
隔离了），但仍会重跑一整轮 agent。真要省这笔钱得加一张缓存表，涉及 migration，
这次没做。

### 顺带

`pnpm search-eval` / `search-recall-eval` 加 `cross-env`——`NODE_OPTIONS=` 前缀
在 Windows cmd 下报"不是内部或外部命令"，之前只能绕开 pnpm 手动跑。

---

## 2026-08-25（二）· 根治「不像人」：加判断闸 + 私信换 sonnet

用户举了一个具体例子：他贴回两条之前给过的房源，问"请问这两套还在嘛"，
项目却重新搜了一遍、甩出两张房源卡片（其中一条根本不是他问的那两条）、
末尾还加了"如需调整条件…"。他的原话是"这显然不像人那么聪明…请你在根本层面
试图解决，即使要换贵的llm我也同意"。

### 根因：不是模型笨，是提示词只给了一条路

`STRICT_RENTAL_SECTION` 第一句就是 **ALWAYS call searchRental whenever the user
is looking for housing**，`SHOW_LISTINGS` 又强制"每条房源都渲染成卡片 + 追加
如需调整条件…"，身份段还写着 *just search and show results*。
**整份提示词里没有任何分支处理「用户在问已经给过的房源」**——"这两套还在吗"
是个是非问句，但模型看到房源词就只剩"搜索并展示"这一条路可走。它没做错。

### 改法：调工具之前先分三种

在 `STRICT_RENTAL_SECTION` 最前面加了判断闸：要新房源 / 问已给过的房源 /
闲聊，只有第一种调 searchRental。判断依据写死成**「用户这句话在问什么」，
不是「这句话里有没有房源相关的词」**，并把用户这个例子原样写进提示词当反例。

**「还在吗」是能查的，不许推给房东**：已确认出租的帖子会被
`clean-xhs-rented-listings` 从库里**删掉**（不是打标记），所以"库里还查得到"
≈ "还没租出去"。提示词里明确要求用 queryListings 查，再一句话回答。

### 模型：私信这条链路换 `anthropic/claude-sonnet-4.5`

`XHS_DM_MODEL` 环境变量可覆盖，网页那条不动（仍是 gpt-4.1-mini）。
意图分辨这件事小模型做不好——**提示词是根治，模型是让那道闸真正被执行的前提**，
少一个都不行。实测（同一句话、同一份提示词）：

- 只改提示词、仍用 mini 之前 → 搜索 + 甩卡片
- 改提示词 + sonnet → **2 步，调 queryListings 真去查了**，答：
  "第一套：已经租出去了。第二套：还在。最终建议你联系房东确认一下具体情况。"

### 另外两件

- **分割线首尾也加**：改判定为「非字段行 + 下一个非空行是字段行」＝标题，
  再单独找出最后一条房源的最后一个字段行收尾。旧的"只在中间插"判定
  （上下都要是字段行）作废，门禁里那几条用例跟着改了。
- **1000 字上限**（`formatForDm`）：**整条整条丢，不切半截房源**。排版后每条
  房源都被一对分割线夹着，丢最后一条＝删掉倒数第二条线到最后一条线之间那段。
  顺序不能反：先排版再压缩，压缩靠分割线找边界。

### 测试脚本的坑（不是产品 bug）

写探针脚本时 queryListings 连着 5 次 SQL 报错、错误信息还是空的。原因是
ES import 被提升到读 `.env.local` 之前执行，而 `query-listings.ts` 在**模块顶层**
就 `postgres(process.env.POSTGRES_URL!)`，拿到 undefined。改成先塞环境变量再
`await import()` 就好了。**以后写这类脚本一律先加载环境变量再动态 import。**

---

## 2026-08-23（日）· 提示词收敛 + 房源之间加分割线

1. **提示词改版**（用户给的新文案，照抄）。两处实质变化：删掉"我这样做是因为
   小红书平台不让私聊发送房东的联系方式"整句；FAQ 改成**只在对方问了才回答**，
   免得模型一上来就报价。
   **连带改了识别器的注释**——原来那段注释举的反例正是被删掉的那句话。FAQ 里
   "可获得多个房东的联系方式"还在，所以 `redact-eval` 那两条负例依然成立，
   只是注释要指向还存在的那句。**提示词一改就回来看识别器**，这是 `xhs-dm.ts`
   把两者放同一文件的原因。

2. **`insertListingSeparators`**：房源之间插一行 15 个 em dash。

### 怎么判「这行是新房源的标题」

先拉真实回复看结构，不是凭空猜。模型输出形状固定：一行标题（不带 `-`）+ 若干
`- 字段: 值`，循环，前面常有引导语、后面常有总结句。所以判定是**上一行是字段行
且下一行也是字段行**的非字段行：

- 只看上一行 → 结尾的总结句会被误当标题（它上面就是字段行）
- 只看下一行 → 开头的引导语会被误判（它下面就是标题…不，是标题的上一行）

两头都要，缺一误插。实测两条真实回复：房源之间都插了，引导语和总结句前都没插。

### 踩的坑：幂等

`neighborKind` 会跳过已有分割线去找真正的邻居，所以对已插过的文本再跑一遍，
标题仍判 true，会叠第二条。修法是插之前看 `out.at(-1)` 是不是已经是分割线。
门禁里"重复跑不叠加"那条就是钉这个的——**第一版没过，是这条测出来的**。

### 顺序

route 里三步不能乱：`wantsContactCollection`（看原文）→ `redactContactInfo`
→ `insertListingSeparators`。剔除会整行删字段、合并空行，先插分割线的话行结构
会被它改掉。

---

## 2026-08-22（六）· 小红书私信加渠道提示词 + `collect_contact` 字段

用户要三件事，串起来是一条：**让模型在合适的时候引导对方留联系方式，并把这个
状态告诉集简云**，好让那边挂留资组件。

1. **`lib/chat/xhs-dm.ts`（新）** —— 渠道提示词 `XHS_DM_EXTRA_SYSTEM` 和识别器
   `wantsContactCollection` **放同一个文件**。识别器认的就是这段提示词引导出来
   的话，拆开放迟早漂移，而漂移的表现是 `collect_contact` 恒为 false、不报错、
   不留日志，属于最难查的一类。提示词内容是用户口述原话，**没有改写**——那是
   运营策略（几时要联系方式、6.88/0.99 定价、为什么不能直接给房东电话）。
2. **`extraSystem` 打通到渠道**：`InboundMessage` 加了这个可选字段，
   `handleInboundMessage` 透传给 `runChatTurn`。渠道话术只对小红书生效，网页那条
   不该看到"叫对方填联系方式"这种规则。
3. **`collect_contact` 进 body**：`JijyunDelivery.collectContact`（驼峰）在
   `deliverToJijyun` 里转成集简云要的 snake_case，**默认 false 且每次都带**——
   不能指望下游"取不到字段就当 false"。失败投递那条也带，走默认值。

### 识别为什么用正则不用模型

文本是**我们自己的提示词**引导出来的，措辞高度可预期；上一轮刚因为多绕一跳吃过
延迟的亏，不值得为一个布尔值再加一次模型调用。真兜不住了再换最便宜的模型。

**最容易踩的坑：把「解释为什么给不了房东联系方式」误判成「在要对方的联系方式」**
——提示词里恰好写了"平台不让私聊发送房东的联系方式"，模型大概率原样复述。
所以动词和名词之间只放行「你的/您的/一下/个」，中间插进「房东的」就匹配不上。
`redact-eval` 里这两条负例（解释平台限制、说明付费获得）是钉子，别删。

### 判定时机

`wantsContactCollection` 吃的是**剔除之前的原文**：`redactContactInfo` 会按标点
切碎重组，判完再剔才不会误伤。route 里两行的先后顺序不能调换。

### 实测

本地假 webhook 收到的真实 body（三种情况都带字段）：

    {"ok":true,"id":"u1","text":"普通房源回复","chatId":"c1","collect_contact":false}
    {"ok":true,"id":"u2","text":"方便留个联系方式吗","chatId":"c2","collect_contact":true}
    {"ok":false,"id":"u3","text":"","error":"TimeoutError","collect_contact":false}

### 遗留

集简云那边还没配「收到 `collect_contact: true` 就挂留资组件」的分支——本次只动
我们这一侧，那边是用户自己的流程。

---

## 2026-08-21（五）· 出站剔除补上 URL/外链，加 `pnpm redact-eval` 门禁

用户反馈私信发出去的内容还带着联系方式和 `([原帖](url))` 链接。查小红书私信
风控规则确认：**站外链接是硬红线**（只放行站内笔记/商品链接），联系方式、
"微信/淘宝/京东"这类第三方平台字眼同样管控，处罚是警告 → 禁言 7 天 → 30 天 →
封号。

### 方法：拿真实语料跑，人眼读剔后文本

不是对着正则空想，是从 `Message_v2` 拉 `role='assistant'` 的真实回复，逐条过
`redactContactInfo`，再用红线正则去搜剔后文本。**这套方法比读代码有效得多**，
下面四个漏洞全是这么抓出来的，凭想象一个都想不到：

1. **URL 完全没管**。以前的实现只有 email/labeled-account/phone/long-digits
   四条，**一条 URL 规则都没有**，每条房源后面的 `([原帖](…))` 全量泄漏，
   `bay123.com` 这种站外链接直接踩红线。
2. **`(415)一254-0960`** —— 号码中间夹汉字「一」，纯数字正则认不出。房源原文
   里这种手写混淆很常见。
3. **`- **联系:** WeChat ID: chunheunwong`** —— 两处都没覆盖：标签被 markdown
   `**` 包着，且平台名和账号之间隔着一个 `ID`。
4. **`参考Apartments.com`** —— 域名前面是中文字符，原来的「行首或空白」起始
   条件匹配不上。改成否定环视 `(?<![\w@./-])`。

### 自己踩的坑

替换时统一写了 `"$1"`，但整段删的那条规则**没有捕获组**，`$1` 被当字面量插进
去，每个标题后面多出一个 `$1`。改成每条规则各带 `replacement` 字段。
**教训：`String.replace` 的 `$1` 在没有捕获组时不报错，只是静默变成字面量。**

### 有意不删的

`靠近SJSU/NEU/UCSC/抖音 $850` 里的「抖音」**保留**——指的是 TikTok 圣何塞办公室
这个地标，是正当位置信息（用户自己也发过"求TikTok附近房源"）。检测器一开始把它
当第三方平台字眼报警，是误报。删了会破坏房源含义。

### 门禁

`pnpm redact-eval`（`scripts/redact-eval.ts`，仿 `search-eval` 的惯例）20 条
case，**两个方向都钉住**：该删的（4 类链接 + 6 类联系方式）和该留的（租金
`$1250`、带逗号租金 `$1，300`、日期 `8/29-11/30`、邮编 `94541`、路口
`10th Ave`、高速 `92. 101`、网速 `500M`）。全库 200 条真实回复扫过零泄漏。
**改这层正则前后都要跑，只加 case 不删 case。**

### 遗留

- 只改了 `redact-contact.ts` 这一层（用户明确限定范围）。回复本身仍是 1000+ 字
  的房源列表，长度是否触发风控没有验证过。
- `redact-contact.ts` 里还有 2 个 lint 警告（`useTopLevelRegex`、
  `useSingleJsDocAsterisk`），在本次没碰的旧代码里，改动前就有。

---

## 2026-08-16（二） · 油猴：复制正文 → 项目 AI 写评论 → 点评论框自动粘贴

用户要求：点「复制正文」后把正文发给 Vercel，"像用户使用项目一样"交给项目 AI，
拿回文字放进剪贴板；油猴框选评论输入框，人工点一下就自动粘贴。

### 1. 服务端 `app/api/xhs/comment-reply/route.ts`（新）

`generateText` + 与聊天页**同一套** `systemPrompt` 和同一批工具
（searchRental/searchWanted/queryListings/两个 transit），`stopWhen: stepCountIs(5)`。
每次请求 `randomUUID()` 当 chatId —— searchRental 的批次缓存按它分区，帖子之间
不串批，也不污染真实用户会话。挂在 `/api/xhs/` 下是因为 `proxy.ts` 只放行这个
前缀（免 guest-auth 重定向）。输出 `stripMemoryFromDisplay` 去掉 `<memory>` 块。

**踩过的两个坑（改 prompt 前必读）**：

1. **帖子不是第一人称消息**。直接把正文当 user message 发过去，聊天 prompt 的
   房东/租客推断会失灵：一条"主卧带独卫出租 2000/月"的**招租帖**被当成对方的
   找房需求去调 searchRental，回出"很遗憾没有符合的房源"——完全说反。
2. **经验帖会凭空编房源**。正文不是请求时，模型自己脑补了一个查询并输出了
   数据库里不存在的房源。

修法都在追加的 `COMMENT_CHANNEL_SECTION` 里：先声明"这段文字是一条帖子的正文，
不是有人在跟你说话"，再给三分支（求租→searchRental / 招租→searchWanted /
经验帖→**不调工具、一条房源都不许提**）。修后实测三类各自正确，经验帖
`toolsUsed: []`。另有渠道排版规则（纯文本、无网址、最多 3 条、400 字内），并显式
写明"覆盖上面的显示每一条"，否则模型会照聊天页规则一次贴 5-8 条。
`toPlainComment` 再兜一层 Markdown 清理（`**`、`*斜体*`、`_斜体_`、`[]()`、
`![]()`、`#`、列表符号）——模型仍会零星漏出，尤其 searchWanted 那条 legacy 的
`*已放宽关键词*` 提示。

鉴权：默认无鉴权（与其它 /api/xhs 一致），设了 `XHS_API_TOKEN` 才校验
`X-Xhs-Token`。这条路由每次调用跑一整轮带搜索的 agent，比 rental-ingest 贵得多。

### 2. 油猴 0.14.0

复制正文后 `void requestAiCommentReply(config, plainText)` —— **与入库/分享同步
并行**，不进原有 await 链（AI 要 15-20s）。回复就绪后 `renderDetailHighlight`
框选 `.inner-when-not-active`；document 级 capture 监听到点它就
`pasteAiReplyIntoComment`：先写剪贴板（保底 Ctrl+V），再按
`editorWaitMs` 节奏等 contenteditable 挂载，`execCommand("insertText")` 插入
（Vue 的 input 监听收得到），失败退 paste 事件、再退硬写 textContent。
**发送键始终人工按。**

- 回复没到就点了评论框：置 `aiReplyPasteRequested`，就绪后立刻粘。**必须有这条**
  ——点击后占位框就消失了，等不到第二次点击。
- **剪贴板互斥**：`isAiReplyClipboardText` 在 `handleCapturedClipboardText` 和
  `tryAutoUpdateSourceUrl` 两处拦一道。否则 AI 回复里万一带小红书链接，分享捕获
  会把它当本帖的 sourceUrl 写库（写成别的帖子，且 shareUrlDone 提前置真）。

### 3. 验证

- 路由：本地 dev + 真实 gateway 打了四类正文。求租帖 15-19s、走 searchRental、
  3 条纯文本；招租帖走 searchWanted；经验帖零工具零房源。
- 油猴：Playwright 起真 Chromium，`page.route` 伪造
  `xiaohongshu.com/explore/*` 页面（含题述的 `.inner-when-not-active` 结构）与
  两个 API，全链路 PASS：正文+title 正确送达 → 评论框出现框选 → 点一下
  → contenteditable 收到文字且 `input` 事件触发 → 剪贴板同步。脚本在
  `scratchpad/xhs-flow-test.mjs`（临时文件，未入库；要重跑就照这个思路重写，
  注意 `require("@playwright/test")`，仓库里没有 `playwright` 这个包）。
- **Windows 上别用 `curl -d '中文'` 测**：Git Bash → 原生 exe 的 argv 转码会把
  UTF-8 弄乱，模型收到乱码后会胡答，看起来像 prompt 出问题。用
  `--data-binary @file.json`。
- `pnpm search-eval` 门禁**没跑**：本次没碰 `buildStrictPredicate` 与搜索链路的
  任何代码，新路由只是复用工具。

### 4. 遗留

- searchWanted 仍是 legacy「换一个」逻辑（见 2026-08-14 §8），所以招租帖的评论
  里会带"已放宽关键词"这类措辞。要治本得照 searchRental 抄 strict 模式。
- 评论回复质量没有自动评测；线上看 Vercel log 里的 `[comment-reply]`（含 model /
  toolsUsed / chars / elapsedMs）。
- `tsc --noEmit -p tsconfig.json` 在这台 Windows 机上 OOM（约 700MB 就崩，与本次
  改动无关）；单文件 program（临时 tsconfig 只 include 新路由）通过。

### 5. 第二轮（同日，用户实机试用后的反馈）→ 油猴 0.14.1

用户实机反馈三条：①框选中了输入框但点下去没粘上；②输入框和分享按钮**同时**
被框选，顺序乱了；③回复的开头寒暄和结尾推销全删掉，只留固定开场白，字数压到
260 code points 左右。

**框选变成一条单线程流水线**（`commentStage(config)`）：
`输入框 → 发送按钮 → 分享按钮`，一次只亮一个，点过就换下一个。分享按钮的高亮
现在被 `stage === "none"` 挡着，只有点过发送键（`state.commentSent`）才轮到它。
**故意留的口子**：评论链路没开、还没请求、或请求失败时 stage 直接是 `none`，
分享按钮照旧亮——AI 挂了不能把入库/分享这条老链路一起堵死。发送键
（`button.btn.submit`）的点击由原来那个 document capture 监听顺带认，没有新增监听器。

**"点一下就粘"的两个真因**：

1. 编辑器找不到或找错。原来只按选择器全局找 `[contenteditable="true"]`，详情页
   别处也有可编辑元素，兜底会把评论粘到别的框里。现在顺序是
   `document.activeElement`（用户刚点完，光标就在里面，这是最准的一手信息）→
   配置选择器 → **限定在评论容器内**的兜底（`resolveCommentScope` 在点击当下就
   把容器记下来，因为占位框马上会被编辑器替换掉）。
2. 等待窗口太短。`editorWaitMs` 加到 3.2s。

另外按用户"点一次就消失"的要求，点击当下就把 status 置 `pasted` 并立刻重绘
（框选马上跳到发送键），**不等插入结果**；插入失败只弹 toast 提示 Ctrl+V，
文字早已在剪贴板里，链路不断。

**文案**（`COMMENT_CHANNEL_SECTION` + 落地兜底）：固定开场白
`看看这些怎么样：`，禁止任何结尾句，260 code points 左右，每条压成一行。
**光靠 prompt 压不住**：searchWanted（legacy「换一个」）把
"已放宽关键词…先给你看一条""如仍不满意…我再为您调整"写进 action 字段，模型
两条指令打架时听工具的，实测连着两轮照抄。所以加了确定性兜底：
`stripChatPageBoilerplate`（删"放宽/先给你看一条"开头行 + 含
"如仍不满意/如需换一个/我再重新筛选/再为您调整/如需调整条件"的行 + **一模一样的
重复行**，库里有重复入库的近似帖，模型会把同一条房源写两遍）与
`ensureFixedOpening`（真的在列条目——正文含「｜」——就保证开头是那句）。
注意 `RELAXED_LEAD_RE` 只删"放宽/先给你看一条"，**不能连"目前没有完全符合的
房源"一起删**，那是要保留的如实回答。

实测（本地 dev + 真 gateway）：求租帖 176/199/241/271 code points、三条互不重复、
零结尾；招租帖 95、开场白已被兜底补上、legacy 话术已清干净；经验帖 56、
`toolsUsed: []`。Playwright 全链路重跑 PASS，新增断言覆盖顺序（评论阶段分享
按钮不许亮 / 点完输入框它自己消失 / 发送后才亮分享）与"没粘到别的可编辑元素上"。

### 6. 第三轮 → 油猴 0.14.2：条目区改成确定性拼装 + 按要求换插入机制

用户四条：①结尾那句"这些房源符合您对……的需求。可继续告诉我是否调整条件。"
彻底删掉；②AI 明明查到很多房源信息，拿去**扩充**到 260 code points；③别用
sonnet，就用项目默认的 gpt-4.1-mini；④粘贴不许模拟 paste/Ctrl+V，要在真实
click/pointerdown 里调 `navigator.clipboard.readText()`，分别处理 input/textarea
与 contenteditable，并 dispatch 冒泡 InputEvent，禁止只改 value/innerText。

**结尾句**（`stripTrailingProse`）：这种话千变万化，穷举关键词是打地鼠。改判
**结构**——条目行一定含「｜」，从末尾往前，出现过条目行之后的无「｜」行一律是
散文收尾，删掉。只从尾部删，中间不动。

**凑字数：两次都被现实打脸，最后落在"条目区一律确定性拼装"**（重要，别再往回改）：

1. 先做的是"再过一遍 gpt-4.1-mini，拿着素材改写到 260 字"。素材只有 1 条时它
   **直接编出两条不存在的房源**，连租金和"社区配备游泳池、烧烤区"都编了。
   凑字数的压力必然压过"不许编造"，这条路彻底堵死。
2. 改成"只在字数越界时才由服务端接管"也不行：模型自己写的行里混着
   `rent unknown`、`月租面议`、`month-to-month`、`｜yes` 这种从脏列直译的垃圾，
   长度**恰好达标时就原样发出去了**。
3. 现行：`collectMaterial` 从 `result.steps[].toolResults[].output.listings/wanted`
   摘真实字段 → `pickRows`（草稿挑中的优先，不够 3 条按工具相关度补齐）→
   `buildToTargetLength` 按 `SEGMENT_BUILDERS` 优先级**轮流**给每条加一段，加到
   逼近 285 就停。模型只负责判断帖子类型、调对工具、挑哪几条；**排版和取值归
   代码**。素材不够就短（招租帖只有 1 条求租者时 79 字）——短了没关系，编造不行。
   经验帖/无匹配没有 material，原样返回模型那两句。

脏数据是这一步的主要敌人（AGENT_LOG 2026-08-14 §3 早有记录）：`JUNK_VALUES`
挡掉 yes/no/null/rent/wanted/面议/未知 这类值；金额字段必须含数字（`money()`）；
押金还要有货币符号，否则 `1-month security deposit` 会印成"押金1-month…"；
`propertyName` 整列不进评论（存的多是 `Center`、`single family house`、
`for rent in Sunnyvale 94087` 这种碎片）；求租行的钱写"预算"不写"租金"。

**模型**：写手一直就是 `DEFAULT_CHAT_MODEL`（openai/gpt-4.1-mini），没有任何
sonnet 覆盖，`XHS_COMMENT_REPLY_MODEL` 也没设。链路里唯一的 sonnet 是
searchRental 终审的 `getVerifierModel()`——那是主产品搜索共用的，换掉会砸搜索
质量（见调试史 §1），**没动**，已在回话里跟用户说明。

**插入机制**（按用户指定重写 `insertTextIntoEditor`）：不再有 `execCommand`、
不再合成 ClipboardEvent（untrusted，小红书可以直接忽略）。input/textarea 走
原型链原生 value setter（React 劫持了 element.value，直接赋值它认不出来）；
contenteditable 用 Selection/Range 真改 DOM（文本节点 + `<br>`，光标置末尾）。
两条路都补发**冒泡的 beforeinput/input InputEvent**。剪贴板读取
`readClipboardInGesture()` 在 pointerdown/click 回调**第一行同步调起**（await
一次手势就过期了），只把 Promise 传下去等；读回来的内容必须过
`isAiReplyClipboardText` 才用——剪贴板上一秒还是帖子正文，读串了会把整篇正文
粘进评论区。回复到手时就 `GM_setClipboard` 写进剪贴板（此时分享步骤还没轮到，
不抢剪贴板），readText 才读得到。监听同时挂 pointerdown 和 click，靠
`aiReplyPasting` 互斥。

**另一个真实故障**：模型偶尔调完 searchWanted 就收工、一个字不写，之前直接
502。现在只要 material 有行就照样拼一条回去，只有"既没文字又没条目"才 502。

实测：求租帖 249/270、三条互不重复、无脏字段、无结尾句；招租帖 79（素材只有
1 条）；经验帖 48、`toolsUsed: []`、不加固定开场白。Playwright 重跑 PASS，
新增断言：编辑器收到**冒泡的 InputEvent(insertText)**、全程**没有 paste 事件**、
innerText 里换行没丢（否则三条房源会挤成一行）。

### 7. 第四轮 → 油猴 0.15.0：终审换模型 + 没房源就跳过 + 改压缩 + 等待遮罩

用户四条：①`getVerifierModel()` 换成 gpt-4.1-mini；②回复说"没搜到符合房源"时
不要进剪贴板、不要框评论框和发送键，直接进分享那一步；③上一轮拼出来的
`Santa Clara｜1室1卫｜有车位` 信息太少，要用 gpt-4.1-mini 把项目 AI 那一大段
**缩写**成 260 字符；④等服务器返回期间盖满全屏、点不穿、拦滚动、正中巨大
"WAIT"，并做成长期可复用的轮子。

**终审模型**（providers.ts）：sonnet-4.5 → `DEFAULT_CHAT_MODEL`。历史结论是
"haiku 会臆造用户属性所以必须 sonnet 级"，这次是用户明确要求换（成本 + 与聊天层
统一），已在函数注释里写清风险与回滚方式。**如果线上开始出现"剔除理由臆造用户
属性"，第一嫌疑就是这里。**

门禁（181 条，2026-08-17）：**PASS 158 / DATA_GAP 15 / VERIFIER_CUT 8 /
CODE_BUG 0 / judge-0 11**，对比 sonnet 基线 153/15/13/0/**4**。读法很清楚——
4.1-mini **剔得比 sonnet 松**：终审剔空从 13 降到 8、PASS 升到 158（用户看到
空结果的概率下降），代价是语义跑偏的 judge-0 从 4 涨到 11（放行了更多边缘房源）。
CODE_BUG=0 所以门禁过，但**这是"宽松换召回"的交易，不是纯赚**；哪天用户抱怨
"推的房源不对路"，把这里换回 sonnet 是第一手段。另有 3 次
`[verifyListings] fail-open`（输出解析不了 → 整批放行），sonnet 时代也有，
量级相当，暂不处理。

**"扩充"改成"缩写"（第三次调整，方向反过来了，别再折腾）**：上一轮为了防编造
把条目区改成确定性拼装，结果信息量太少——库里的结构化列本来就稀疏，拼出来只有
城市/房型/车位几个词。现在改成：第一遍 agent **放开写**（channel section 明说
"这一步不用担心太长，后面有专门一步压长度，你写得越全压完留下的越多"），超过
285 code points 才过一遍 `condenseComment`（gpt-4.1-mini，不带工具）压到 260。
**关键区别**：压缩只做减法，不会编造；上一轮失败的是**扩写**，压力一上来必然
无中生有。所以 `condenseComment` 在草稿本来就短于上限时**直接返回，绝不叫模型
往长里写**。确定性拼装 `buildToTargetLength` 保留，降级为"模型一个字没写但条目
在手上"时的兜底。实测信息量回来了（"走路1分钟到Apple Park""包水电家具""押金
1个月"这类细节进了评论）。

**没房源就跳过**：服务端返回 `hasListings`，判据是最终文本的形状——固定开场白
+ 含「｜」的条目行都在才算有货（不能只看 material 有没有行：模型可能查到了却
判定不合适，如实说"没有"）。油猴收到 `hasListings === false` 就置
`aiReplyStatus = "skipped"`，不写剪贴板、不挂评论阶段，`commentStage` 直接
返回 none → 分享按钮立刻亮。

**等待遮罩 `createScreenBlocker()`**（userscript，通用轮子）：`show(text)` /
`hide()` / `isVisible()`，自己持有 DOM，**不放进 `#xhs-guide-overlay-root`**
——那层每次 `renderDetailHighlight` 都 `replaceChildren()`，放进去会被抹掉，而且
它是 `pointer-events:none`（为了让框选不挡点击），跟这层要"接住一切输入"正相反。
拦截四件事：指针事件自己吃掉（点不穿）、window 上 `passive:false` 拦 wheel/
touchmove（落在遮罩上浏览器仍会滚祖先容器）、翻页类按键、html/body 双 overflow
hidden。字号 `clamp(96px, 26vw, 520px)`。`requestAiCommentReply` 开头 show，
finally 里 hide（成功/失败/没房源都收），teardown 也 hide。

实测：求职帖草稿够全时不触发压缩（208/105 字符），过长时压到 295→260 段。
Playwright 两个场景全 PASS：①happy path 增加遮罩断言（盖满、
`elementFromPoint` 命中遮罩、body overflow=hidden、字号 >90px、回复到手后自动
消失并还原 overflow）；②新场景 `hasListings:false` —— 剪贴板仍是帖子正文、
评论框和发送键都不框、分享按钮直接亮。

### 8. 第五轮 → 油猴 0.16.0：分享弹层「复制链接」+ 按钮减半 + No. 计数器

**先说一件事故**：这一轮开工时发现工作区里 `providers.ts`、`README.md`、
userscript 三个文件被**整体退回到了旧版本**（userscript 退到 0.13.4，终审又变回
sonnet），而 HEAD 上是新版。跟 2026-08-16 那次"旧文件被一次性写回磁盘"是同一种
现象（见本文件更早的记录与用户的排查）。commit 都在 main 上，`git checkout --`
三个文件即可恢复。**以后每轮开工先 `git status`**：工作区被退回时若直接在旧文件
上改，等于把几轮工作悄悄抹掉。

三件事都在 userscript 里：

- **分享弹层的「复制链接」**（`findShareCopyLinkElement`）：接在分享按钮之后。
  不记"点没点过分享"的状态——`.xhs-note-share-popup-action-item` 这个元素
  **只有弹层打开后才存在且可见**，找得到就说明分享按钮点过了。弹层里还有
  下载图片等同类项，所以按标签文字「复制链接」或 `#link_b` 图标认准这一个。
- **右下角复制正文按钮减半**：padding 30/42→15/21、字号 42→21、圆角 30→15、
  阴影同比。
- **No. N 计数器**：顶部居中蓝色小徽标，`localStorage` 键
  `xhs-guide-highlight-click-count`。只在 `handleTitleClickDismiss` 里 +1
  ——那个函数遍历的是 `state.matchedById` 里未 dismiss 的候选，也就是**当前被
  框选的标题**，没框中的根本进不到那一行。这正是用户强调的"一定得是被框选的
  才算数"。

Playwright 新增两处：详情页测试补"点分享→框选转到复制链接、分享那一框消失"；
新写信息流场景（真跑地理门控 + mock title-judge）——点**没被框选**的标题计数不动、
点**被框选**的 +1 并写进 localStorage、刷新后仍在，另外校验徽标颜色
`rgb(37,99,235)`、字号 15px、贴顶、居中。

### 9. 第六轮 → 油猴 0.17.0：复制链接点完收框 + 求租帖才跑评论

用户两条：①点了「复制链接」红框要消失；②复制正文后**用最便宜的 llm 判断正文**，
不是租客求租就跳过评论、直接从分享按钮那步开始框选。

**收框**：`state.shareCopyLinkClicked` 一置，分享阶段（复制链接框 + 分享按钮框）
全部不画。监听**单独挂**（`ensureShareCopyLinkListener`，在 `refreshDetailMode`
里确保）而不是并进 `shareDocClickHandler`——后者只在 `listingId && !shareUrlDone`
时才挂，而复制链接的框在 `bodyCopied` 阶段（listingId 还没回来）就可能画出来了，
并进去会漏点。链接已进剪贴板，写库是后台的事，不该继续杵个红框。

**求租岔路口** `app/api/xhs/post-intent`（新路由）：**复用入库那套
`classifyRentalPostIntent`**，只是给它加了个可选 `options.model`，这条路由传
`getFeedTitleModel()`（gpt-4o-mini，全项目最便宜）。入库路径的默认模型没动。
选它而不是新写一个分类器，是因为它自带正则快路径——实测求租帖 **source: rule、
4ms、一次模型都没调**；招租帖/经验帖才落到 gpt-4o-mini（1.3-1.6s）。

油猴在 `requestAiCommentReply` 开头分叉：非 seeker 就 `aiReplyStatus = "skipped"`、
收遮罩、直接渲染成分享阶段，**comment-reply 一次都不调**（省的是大头：那条路由
每次跑一整轮带搜索的 agent）。**判不出来时按求租帖继续**——宁可多花一次，也不要
因为一次网络抖动把功能静默关掉；何况 comment-reply 自己也按帖子类型分支，最后
还有 `hasListings` 兜一道。

实测三类帖子分类全对（seeker/lister/other）。Playwright 三个场景：happy path 补
"点复制链接后框消失、分享阶段不再有任何框"；新写招租帖场景断言
**comment-reply 调用次数为 0** 且直接框分享按钮；no-listings 场景照旧。

---

## 2026-08-18（二）· 长期原则：完全替代用户说话，不要求用户亲自使用项目 AI

**这是用户定的产品/工程总方针，以后所有渠道开发都按它来，别再走回头路。**

要做的事情如果用户自己坐在聊天页前面能做到，那就**由代码扮演用户去做**：把话
原样发给项目 AI、看它回答、不满意就再说一句、拿最后那条回答去用。**不要为了
某个渠道往 system prompt 里塞规则，也不要在代码里替模型重写内容。**

`/api/xhs/comment-reply` 就是照这个重写的（2026-08-18），流程只有四步：

1. 复制来的帖子正文**原样**发给项目 AI —— 跟真人在聊天页粘一段帖子问"有房源
   吗"完全一样：同一套 systemPrompt、同一批工具、**零额外提示词**。
2. 模型照常输出一大段。
3. 再以用户身份说一句 **「请缩写至260字符左右」**。
4. 拿它缩写后的文字，**死代码**在最前面拼上
   「看看以下这些觉得怎么样，感兴趣的话私信我：」，进剪贴板。

### 因此删掉了什么（别再加回来）

`COMMENT_CHANNEL_SECTION`（整段渠道 system prompt）、`ensureFixedOpening`、
`stripChatPageBoilerplate` 里的整套判重/散文裁剪、`collectMaterial` +
`SEGMENT_BUILDERS` + `buildToTargetLength`（按结构化列确定性拼装条目）、
`JUNK_VALUES`/`money()`/`trimToBudget`、`CONDENSE_SYSTEM`。路由从 680 行降到
约 260 行。这些东西都是在**跟模型较劲**：往提示词里加规则 → 模型不听 → 再写
代码把输出改回来。正确做法是像用户一样直接跟它说。

### 保留的极少数后处理（都是"格式"不是"内容"）

- `toPlainComment`：Markdown → 纯文本（评论框会把 `**` 原样显示），顺带去掉
  链接与裸 URL（评论区链接点不动，贴出来只是噪音），以及"原帖/详情"这类被剥掉
  链接后剩下的锚文本残渣。
- `dropChatPageTail`：删结尾那句"如需调整条件…我再重新筛选"。用户很早就明确
  要求过"结尾一句都不许有"，评论区也确实没有下一轮。**只此一条，别再往上加。**
- `hasListingResults`：判断有没有房源可推**看工具返回的数组，不看文字形状**。
  以前靠正文有没有固定开场白/含不含「｜」来猜，模型排版一走样就误判成"没房源"，
  把油猴后面的评论步骤整段跳过。工具结果是事实，措辞变了它也不变。

### 实测（gpt-4.1-mini，同一条求租帖跑了 9 次）

- 第一句「请缩写至260字符左右」**经常不听**：回过 549、739、472 字符。
- 所以加了一次**用户口吻**的追催（>400 字符才催，且只有更短才采纳）：
  「还是太长了。只保留最多3条，每条压成一行，全文260字符以内，不要分点小标题，
  也不要最后那句让我调整条件的话。」——这仍然是以用户身份说话，不是塞提示词。
- 追催后落在 **183 / 206 / 220 / 247 / 299** 字符，可用；偶尔仍会写成一段总结
  而不是三条房源。**这是这条路线的固有波动**，用户知情并接受：宁可波动，也不要
  回到"提示词 + 代码重写"那套。
- 经验帖：`hasListings=false` → 不拼开场白、油猴整段跳过评论，正确。

### 粘贴回归（0.19.0 修）

用户实机报"点评论框一个字都没粘进去，但剪贴板里有"。根因在
`findCommentEditorElement`：`document.activeElement` 那一级当初加了
"必须在 scope 里"的条件，而 scope 是**点击那一刻**记下的容器；小红书把占位框
整个换掉之后它成了游离节点，`scope.contains(active)` 恒假，**真编辑器反而被自己
的保险丝挡掉**。改成 activeElement 无条件采纳（用户刚点完，焦点在哪就是哪）。

插入本身**保持最简**（0.20.0 定稿，别再加兜底）：contenteditable 走
Selection/Range 改 DOM，input/textarea 走原型链上的原生 value setter，都补一对
冒泡的 beforeinput/input，完事。找编辑器也只有两级：activeElement → 配置选择器。

我一度加过多策略 + 事后验证 + `execCommand("insertText")`，**用户明确否决**：
`execCommand` 是浏览器命令，小红书风控可能认得出是自动化；而且兜底越堆越冗余。
用户的原则是"**简单能成就行，手动试一次能成就行，长期也不指望 100% 成功率**"。
粘不上时文字还在剪贴板，Ctrl+V 一次即可。**以后不要再往这里加策略。**

修的过程中踩了一个坑值得记：兜底找编辑器时我一度放开成"全页面找
contenteditable，挑离点击处最近的"，结果**把评论粘进了详情页的搜索框**
（Playwright 立刻抓到）。这也是"少即是多"的佐证——现在整套容器兜底
（`COMMENT_SCOPE_SELECTOR` / `resolveCommentScope`）连同那段逻辑一起删干净了。

另：缩写那句现在是「请缩写至260字符左右，**不要带联系方式**」（追催那句同步
加了"微信/电话/邮箱都不要"）。实测两轮 223/167 字符，均无联系方式泄漏。

### 占位框按文案认（0.20.1）

用户贴来实机 DOM：`<div data-v-c6e6457a class="inner"><img class="icon"><span>说点什么...</span></div>`
——**外面那层 `not-active inner-when-not-active` 没了**，`data-v-` 哈希也换了。
类名写死在配置里迟早会这样。所以加了一级按文案兜底：类名选择器全落空时，扫
div/span/p 找**只包含「说点什么」这一句**（文本长度不超过它 +8 字符）且可见、
尺寸够大的元素，多个命中取最外层那个（span 的父 div 才是整条可点的框）。
点击判定 `closestCommentInput` 同样两级：先类名，再沿祖先链往上 4 层找那句话。

配置项 `commentReply.inputPlaceholderText = "说点什么"`。真要再变，改这一个字符串
就行，不用碰代码。Playwright 加了一个场景专门跑用户这份 DOM（连容器类名
`.comment-input` 也换成 `.reds-comment-box`，确保走的是文案那条路）。

### 会话与身份

两轮（有时三轮）对话全部落在帖主那条 conversation 里，网页打开看得到完整记录。
帖主身份由油猴从 `.author-wrapper` 抓 `/user/profile/<id>` + `.username`，经
`ChannelIdentity` 映射到内部 user，所以同一个帖主的多条帖子进同一条会话。


---

## 2026-08-18（四）· /api/xhs/messages 改成两次单向消息 + 出站投递集简云

用户说调用方集简云**超时只有 30 秒**，而一轮带搜索的对话要 15-30 秒，同步返回
必然压线。所以拆开：

```
集简云 --POST {id,text}--> /api/xhs/messages   立刻 202，不带正文（实测 26ms）
我们   --POST {id,text}--> JIJYUN_WEBHOOK_URL  算完再发
```

- AI 那段放进 `next/server` 的 `after()`：响应发出之后才跑，仍算在
  maxDuration=60 的预算里。**注意 `after()` 在请求作用域外会抛**（AGENT_LOG
  更早那次评测脚本事故就是这个），这里在 route handler 内没问题。
- 失败也投递一条 `{ok:false,error}`——不然集简云那头永远在等，不知道这条黄了。
- `lib/chat/jijyun.ts`（新）。**webhook URL 必须走环境变量**：这个仓库
  `xiayu012/willinglink` 是**公开**的（用 GitHub API 确认过），而该 webhook
  无鉴权，写死在代码里等于谁都能往用户的自动化流程灌消息。没配就跳过投递并
  在日志里说明。

### 两个踩到的坑

1. **`.env.local` 没有结尾换行**，我 `>>` 追加时把新变量粘到了上一行末尾，
   写出 `CHANNEL_ADAPTERS_ENABLED=1JIJYUN_WEBHOOK_URL=...`——既毁了原变量的值，
   新变量也不生效。已修好。**以后往 .env 追加前先确认结尾有换行。**
2. **用户给的集简云 webhook 现在返回 401** `{"message":"Invalid authentication
   credentials"}`——不是我们的代码：直接 `curl -X POST <URL> -H
   "Content-Type: application/json"` 一样 401。用户说"没有鉴权"，实际那头要么
   流程没发布、要么 URL 里的 token 换过、要么确实需要某个头。代码这边已经就绪，
   URL 一改就能通（只是个环境变量，不用动代码）。

本地用一个假 webhook（node http server）验过全链路：ack 26-33ms、
`Content-Type: application/json`、body 是 `{ok,id,text,chatId}`、内容已剔联系方式。

---

## 2026-08-18（三）· 半成品用起来了：/api/xhs/messages MVP + 出站剔联系方式

用户要求把之前那套骨架接上：`/api/xhs/messages` **只收 `{id, text}`**，text 交给
项目 AI，**在 XHS adapter 里把每条 AI 回复的联系方式剔掉再返回**，要优雅。

- 路由本身很薄（约 90 行，绝大多数是注释）：校验两个字段 →
  `handleInboundMessage({channel:"xhs", externalUserId:id, text})` →
  `redactContactInfo()` → 返回。聊天逻辑一行都没有，全在公共链路里。
- **去掉了 `adaptersEnabled()` 开关**：那是它还是空壳时的保险，现在要真用，
  鉴权交给 `XHS_API_TOKEN`（与其它 /api/xhs 一致）。twilio/wecom 两个骨架仍然
  带开关。
- `lib/chat/redact-contact.ts`（新）：先吃"标签+号码"整段（`微信：abc123`），
  再兜裸号码，最后 `dropOrphanFragments` 把"短信 或""或邮箱"这类只剩引导词的
  碎片整段丢掉。**顺序不能反**，反了标签会留在原地变成半句。取舍是**宁可多删**
  ——少一个微信号只是让对方多问一句，漏一个就发出去了。
  假阳性专门验过：邮编 94086、租金 1700、`$1,700`、日期 2026-08-27 全不动。
- 剔除只作用于**发出去的那份**；`Message_v2` 里存的仍是完整原文，网页上照常看到。
  这是渠道策略，不是 Engine 的事——所以放在 adapter 里，别往 `runChatTurn` 里塞。

**实测最能说明架构价值的一点**：用之前 comment-reply 存下的帖主 id
（5d22ab08…e661，Edward）发私信，落到的是**同一个 chatId a673939a**——评论区
来过的人再发私信，接的是同一串上下文。第二条只说"预算改成1500，还有吗"，
模型直接按新预算重搜，说明历史确实共用。

遗留：回复目前只是同步返回，**没有真正投递回小红书**（由调用方负责）；
webhook 重投去重和限流都还没写；回复仍是聊天页那套 Markdown（私信是纯文本框，
要不要转换等接上游时再定）。

---

## 2026-08-18 · 多渠道聊天骨架：抽出 Chat Engine + 外部身份映射（半成品）

用户给了一份跟别的 AI 讨论出的架构方案，要求"中等程度看着办"：项目还是小型创业
起步阶段，**现在只要显而易见的半成品**，以后基于它再开发细节。核心诉求：网页、
小红书私信、Twilio 短信、企业微信共用**同一套**聊天记录与上下文。

### 1. 做了什么

- `lib/chat/engine.ts`：`buildTurnSetup()`（模型/系统提示词/工具的**唯一**来源）
  + `runChatTurn()`（非流式整轮，给 webhook 型渠道用）。
- `lib/chat/identity.ts`：外部身份 → 内部 user，没见过就建 guest 绑上去；
  `linkIdentity()` 留给以后的身份合并。
- `lib/chat/conversation.ts`：内部 user → chatId（取最近一条，没有就建）。
  **跨渠道上下文就靠这里**：没有"某渠道的会话"这个概念。
- `lib/chat/adapter.ts`：`handleInboundMessage()`（身份→会话→引擎）+ 总开关
  + 错误翻译。三个 adapter 路由（xhs/messages、twilio/messages、wecom/messages）
  各自只做字段翻译，聊天逻辑一行都没有。
- `lib/db/schema-channels.ts` + `lib/db/migrations/manual/channel-identity.sql`。

### 2. 关键的克制（改这块前先想清楚再动）

- **网页 `/api/chat` 没有搬进 Chat Engine 跑**，只改成从 `buildTurnSetup()` 拿
  配置。SSE、resumable stream、标题生成、工具审批续跑都还在原地——搬过去收益小
  风险大。**收敛配置才是这次的重点**：以后换模型/加工具改一处，网页和所有渠道
  同时生效，不会再出现 `/api/chat` 与 `comment-reply` 各写一份然后慢慢漂移。
- **ChannelIdentity 故意不并进 `lib/db/schema.ts`**。drizzle 的
  `db.select().from(x)` 按 schema 定义查列，**库里没表/没列会直接报错**——并进去
  又没跑 SQL，等于把现有聊天打挂。同理 `Message_v2` 的 channel/externalMessageId
  两列只写在 SQL 注释里，跑完 SQL 才准补进 schema。顺序反了就是生产事故。
- **adapter 默认关闭**（`CHANNEL_ADAPTERS_ENABLED`）：这些都是无鉴权入口，每次
  调用跑一轮带搜索的 agent，没上线前不该被扫到就烧钱。表没建时返回 501 并直接
  写明要跑哪个 SQL 文件。
- `/api/xhs/comment-reply` **保留不动**：它是一次性的帖子评论生成，无状态、不进
  聊天记录，跟私信不是一回事（用户方案里也是这么定的）。

### 3. 验证

- 网页聊天**行为不变**：起 dev、拿 guest cookie、真打 `/api/chat`——SSE 正常、
  标题生成正常、searchRental 被调用、257 个 text-delta。
- Chat Engine 直连跑了两轮：轮1 走 `channel: "xhs"` 说"我想在 Sunnyvale 找个
  单间"，轮2 走 `channel: "sms"` 只说"预算 2000 以内"，引擎发出的检索词是
  **"Sunnyvale 单间 预算2000以内"**（historyCount=2）——跨渠道上下文成立。
  库里 4 条消息，user/assistant 交替正确。
- adapter 两个门禁都验过：开关关闭 → 503；开关打开但表没建 → 501 + 迁移提示。

### 4. 下一步（README 里有同一份清单）

建表 SQL → 打开开关 → 接第一个真实渠道（小红书私信，字段名对齐 + 回发消息）→
消息打 channel 标签（先跑 SQL 第 2 段再补 schema）→ Twilio/企微 补验签与
回复格式（企微被动回复只有 5 秒，必须改成异步推送）。去重（externalMessageId
判重）和 webhook 渠道的限流**都还没写**，接真实渠道前必须补。

### 5. 同日续：comment-reply 变成第一个真渠道 + 帖主身份入库（油猴 0.18.0）

用户确认已建表并打开开关（我核过：ChannelIdentity 在、三个索引都在、
Message_v2 第 2 段没跑，符合预期；**但 `.env.local` 里没有
CHANNEL_ADAPTERS_ENABLED**，多半只设在 Vercel，本地联调要自己带）。
然后要求把 `/api/xhs/comment-reply` 也当成一个渠道：建 chat、全程进聊天记录、
**缩写动作改成在同一条会话里跟项目 AI 说"压到 260"**，拿最后那条回复进剪贴板。

- 帖主身份：油猴从 `.author-wrapper` 里抓 `/user/profile/<id>` 和 `.username`，
  随请求送到服务端 → `ChannelIdentity(xhs, <id>, displayName)` → 内部 user →
  `resolveChatIdForUser`。**同一个帖主的第二条、第三条帖子会落进同一条会话**
  （实测三次调用 chatId 都是 a673939a），以后 ta 从私信/短信找过来接的是同一串
  上下文。给 ChannelIdentity 加了 `displayName` 列（SQL 文件同步更新，已 ALTER
  到线上；表当时是空的，零风险）。
- 抓不到帖主（老版本油猴）→ 建一次性 guest 会话，行为与以前一致，不阻塞。
- 缩写变成第二轮对话：`condenseInstruction()` 是一条**用户消息**，不再是第二个
  system prompt。实测库里就是四条：帖子正文 → 长草稿 → "刚才那条 464 字符，
  压到 260" → 压完的版本。
- `CONDENSE_SYSTEM` / `condenseComment()` 删除；`collectMaterial` 改吃
  `TurnResult.toolOutputs`（engine 新增的字段，adapter 想知道工具查到什么时不用
  再调一次工具）。

**两个实测踩到的坑**：

1. `hasListings` 曾要求正文含「｜」。模型某次没用分隔符写了三条真房源 →
   判成 false → 油猴把整个评论步骤跳过了。**排版走样不等于没有房源**，改成只看
   "固定开场白 + 后面有内容"。
2. 缩写那一轮压不到位（回过 363 字符，也回过 105 字符）。指令里补了"235-285
   才算合格，太短一样不行"，再加确定性闸门 `trimToBudget()`：按空行整块丢尾巴，
   丢的是整条房源，不会把某条截成半句。修完实测 243-265。

（另：`.env.local` 里有个 `XHSXHS_API_TOKEN`，代码里没人读，看着像
`XHS_API_TOKEN` 打错了 —— 也就是说共享密钥现在其实没生效。已在回话里提醒。）


---

## 2026-08-16 · 每批 8 条 + "继续/换一批"瞬间出下一批

用户要求：单批上限 5 → **8**；用户说"继续/换一批"要**瞬间**出下一批，且
"从一开始就从数据库调出 top k，这样不至于跟上一批重复"。技术路线由我定。

### 1. 架构（选型理由写清，别改回按批重搜）

一次检索就把结果准备好，之后纯切片：
`谓词过滤全表 → rerank 取 top-K（K = 8×3 = 24）→ **整批终审** → 存会话缓存
→ 本轮返回前 8`；"继续" 从缓存 offset 往后切 8，**零 DB、零 LLM、0ms**，
且与已展示的天然不重复（同一份有序列表往后走，不是重新搜一次）。

- 为什么不"每批重搜 + offset"：重搜要再跑一次 DB + rerank + 终审（约 10s），
  达不到"瞬间"；而且新行入库会让排序漂移，批次间可能重复或漏掉。
- 为什么终审要**整批**做：只审第一批的话，第二批要么未经终审（质量不一致），
  要么临时调 LLM（又不瞬间了）。
- `lib/rental/result-batches.ts`（新）：Redis + 进程内 Map 兜底（与
  seen-listings 同款分层），TTL 2h，存 { fingerprint, query, listings, offset,
  totalMatched }。JSON 往返会把 createdAt 变字符串，读回时 reviveDates 还原。

### 2. 关键细节

- **需求指纹守卫** `batchFingerprint(query, params, blockTerms)`：只有查询与
  全部条件都没变才允许续用缓存。用户改了预算但模型仍传 `more: true` 时指纹
  不符 → 自动退回完整搜索（实测 12.7s 走了重搜，没有误用旧结果）。
- **终审分块并行**（verify-listings.ts，VERIFY_CHUNK_SIZE=8）：24 条串行要
  14s，分 3 块 Promise.all 后 7.0s（单块 8 条本身就要 6.4s，所以 3 倍量只多
  0.6s）。总 token 不变。分块顺序即原顺序，flatMap 后相关度排序不变。
- 工具新增入参 `more`，返回新增 `remainingInBatchCache`；缓存耗尽返回新
  action **NO_MORE**（prompts.ts 已加对应段落）。NO_MORE 文案区分"库里就这些"
  与"还有 N 个但相关度较低，建议补充条件"——不谎称没有了。
- 评测：单批上限校验 5 → 8。评测每条用独立 chatId，缓存不会串场。

### 3. 实测

- 首搜 8 条 ≈ 11-13s（拆解：本地→Neon 取 820 行 1.9s、谓词 17ms、rerank
  0.5s、终审 7s。**线上 Vercel 与 Neon 同区，DB 那段会小得多**）。
- 批 2「继续」：**0-1ms**，零重复；批 3 起缓存耗尽 → NO_MORE。
- 一次检索备 3 批；若终审剔得多（24 → 13~16 是常态），实际就是 2 批。
  这是有意的：宁可少给也不给不合格的。
- 门禁（181 条）：**PASS 153 / DATA_GAP 15 / VERIFIER_CUT 13 / CODE_BUG 0 /
  judge-0 4**。对比上一节的 122/15/44/0/2 有个**意外的质量收益**：候选从 5 条
  扩到 24 条后，"终审把整批剔光"从 44 次降到 13 次——以前只送 5 条进终审，
  全被剔就只能回"没有"；现在后面还有备选顶上，用户看到空结果的概率大幅下降。
  **这条经验可复用：终审剔除率高时，扩大候选池比放宽终审标准更划算。**

### 4. 成本提醒

终审从每次审 5 条变成审 24 条（sonnet），单次搜索成本约升到 $0.05-0.09。
用户已明确表示价钱可接受；若将来要压，第一刀是把 STRICT_BATCH_POOL 从 24
降到 16（少一批）。

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
