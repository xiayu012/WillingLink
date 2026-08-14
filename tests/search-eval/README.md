# 搜索质量评测

用**真实用户措辞**持续检验 `searchRental`，并自动区分「代码没写好」和「数据库没数据」。

> **严格模式（当前默认）**：searchRental 一次最多返回 5 条、且每条都必须严格满足
> 用户说出的全部要求；没有就返回空并如实说"没有"。旧的「单条 + 换一个」级联已
> 废弃但代码保留，`SEARCH_LEGACY_PICK_ONE=1` 可切回。评测的 ground truth 与运
> 行时共用同一个 `buildStrictPredicate`，判定标准不会漂移。

## 怎么跑

```bash
pnpm search-eval                       # 默认：auto 源，50 条
pnpm search-eval -- --source wanted    # 强制用求租帖原文
pnpm search-eval -- --source log       # 强制用真实搜索留档
pnpm search-eval -- --limit 30
pnpm search-eval -- --notify           # 有问题时发 Telegram（CI 用）
pnpm search-eval -- --no-judge         # 跳过 LLM 判分
```

报告输出到 `tests/search-eval/reports/<日期>.md`（gitignored）。

## 查询从哪来（无需人工维护）

1. **SearchQueryLog**：每次真实用户搜索自动留档（`lib/db/queries.ts` 的
   `logSearchQuery`，在 searchRental 里 fail-open 调用）。积累够了自动优先用它。
2. **XhsRentalWanted**：真实租客的求租帖原文，冷启动兜底。

评测自身的查询以 `eval-` chatId 前缀写入留档，抽样时自动排除，不会自我污染。

## 怎么读结论（三类）

| 标记 | 含义 | 要不要管 |
|---|---|---|
| ✗ CODE_BUG | 库里**存在**满足全部要求的房源却没返回 / 返回了不满足的 / 超过 5 条 | **要修** |
| ⚠ 判 0 分 | 严格条件都过，但 LLM 认为语义不相关 | 人工看一眼 |
| ◌ DATA_GAP | 库里**不存在**满足的房源（含湾区外需求），正确回答了"没有" | 不用管，等数据 |

判定原理：每条查询先在全量房源上用 `buildStrictPredicate`（与运行时同一份代码）
算 ground truth；返回的每一条房源也用同一谓词核验，任何一条不满足即 CODE_BUG。

## 循环

```
改代码 → pnpm search-eval → CODE_BUG=0 即可发布
每周 CI 自动跑（.github/workflows/search-eval.yml）→ 有问题才 Telegram 报警
```

确定性：严格模式本身无随机性（严格过滤 + rerank 排序），同一代码 + 同一数据下
结果可复现。`SEARCH_DETERMINISTIC=1` 仍会设置，仅在切回 legacy 模式时有意义。
