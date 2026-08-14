# WillingLink — Claude 工作须知

**开始任何搜索/入库/AI 相关改动前，先读 `.claude/AGENT_LOG.md`** —— 那是历次
Claude 会话的决策记录（为什么代码长这样、哪些坑已经踩过、哪些代码看似废弃实则
是保留的回退路径）。改动这些区域前不读它，大概率会重复已解决的问题或破坏有意
的设计。

速查：
- 产品方向：LLM-native。查询理解交给 LLM（聊天模型传结构化参数），正则只做兜
  底，硬筛选"偏严格"（只剔除可证明违反的），排序交给语义 rerank。
- `searchRental` 严格模式是默认；旧"换一个"级联**保留勿删**，
  `SEARCH_LEGACY_PICK_ONE=1` 回退。
- 搜索回归门禁：`pnpm search-eval -- --source wanted --limit 181`，
  CODE_BUG=0 才能发布。评测与运行时共用 `buildStrictPredicate`。
- 与用户沟通用中文；用户要求"先讨论再动手"时不要直接改代码。
