# WillingLink — Claude 工作须知

**开始任何搜索/入库/AI 相关改动前，先读 `.claude/AGENT_LOG.md`** —— 那是历次
Claude 会话的决策记录（为什么代码长这样、哪些坑已经踩过、哪些代码看似废弃实则
是保留的回退路径）。改动这些区域前不读它，大概率会重复已解决的问题或破坏有意
的设计。

速查：
- 产品方向：LLM-native。查询理解集中在 `lib/rental/query-plan.ts` 的
  `planQuery`（运行时与评测共用的唯一入口），正则只做兜底，硬筛选"偏严格"
  （只剔除可证明违反的，**沉默不算违反**），排序交给语义 rerank + 偏好。
- 约束是**集合**不是单值：`cities` / `bedroomsAnyOf` 列了备选就全部列出，
  按 OR 处理。"列了多个所以整条不筛"是已经修掉的老 bug，别改回去。
- `searchRental` 严格模式是默认；旧"换一个"级联**保留勿删**，
  `SEARCH_LEGACY_PICK_ONE=1` 回退。理解层回退：`SEARCH_PLANNER_OFF=1`。
- 搜索回归门禁（两个都要跑）：
  `pnpm search-eval -- --source wanted --limit 181` → CODE_BUG=0 才能发布；
  `pnpm search-recall-eval` → 盯"库里有却说没有"（前者对筛选过严**结构性
  失明**，因为它的 ground truth 和运行时共用同一个谓词）。
- 与用户沟通用中文；用户要求"先讨论再动手"时不要直接改代码。
