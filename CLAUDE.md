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
- 与用户沟通用中文；用户要求"先讨论再动手"时不要直接改代码。

## 评测脚本：按需跑，别当成每次必做的仪式

这些脚本每个都要几分钟到十几分钟（真实模型调用），**不是每次改动都要跑**。
自己判断值不值得；用户说要跑就跑。默认不跑，改完直接说改了什么。

| 脚本 | 盯的是什么 | 什么时候值得跑 |
|---|---|---|
| `pnpm search-eval -- --source wanted --limit 181` | 硬筛选逻辑错误（CODE_BUG） | 动了 `query-plan` / `query-constraints` / 硬筛选谓词 |
| `pnpm search-recall-eval` | "库里有却说没有"（漏召回） | 同上，且怀疑筛严了 —— search-eval 对这一类**结构性失明**，因为它的 ground truth 和运行时共用同一个谓词 |
| `pnpm comment-reply-eval` | 评论成品：角色、格式、字数、幂等 | 动了 comment-reply 链路或提示词 |
| `pnpm redact-eval` | 出站剔联系方式、分割线、字数上限 | 动了 xhs adapter 的出站处理 |

改一行提示词、修个类型、调个注释——不用跑。真要发布前动过搜索核心逻辑，
再跑对应那一两个。
