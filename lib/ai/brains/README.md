# 大脑（brains）模块

多个 AI 产品共用一套「准则组装」机制，各自的准则内容互相隔离。

**一个大脑 = 常驻准则（每轮必带）+ 情境模块（按需加载）+ 路由规则。**

---

## 为什么这样设计

**为什么不用向量检索**：情境模块只有个位数，类别边界清晰。
规则命中率高于 embedding 相似度，而且**可解释、可测试、出错时知道原因**——
`pnpm brain:inspect` 会打印每个模块为什么被加载。
等模块涨到几十份、或需要检索各州法规这类长尾，再引入检索。

**为什么准则用 .md 不是 .ts**：这些准则会被频繁编辑。
改行为 = 改一个 markdown 文件，不用重训、不用改代码——这是本设计的主要优势。
代价是需要 `next.config.ts` 的 `outputFileTracingIncludes`（已配好）。

**为什么常驻放最前**：便于上游做 prompt caching，前缀稳定才能命中缓存。

**为什么常驻是数组而不是一份文件**：`always` 按顺序拼，**顺序即优先级**——
前面是目标与仲裁条款，后面是手法，正文里写明冲突时以前者为准。
起因是一次真实事故：目标（别让住户费脑子）和手法（按周轮换）混在同一份
1.6 万字文件里，没有任何东西说明谁压谁，模型按"具体压抽象"挑了错的那条。
**准则变长时，缺的往往不是内容而是仲裁。** 详见 AGENT_LOG 2026-08-30。

## 目录

```
lib/ai/brains/
  types.ts       Brain / RouteRule / RoutingDecision 类型
  registry.ts    大脑注册表
  router.ts      路由引擎（force / exclusive / 上限）
  loader.ts      doctrine 读取与缓存
  assemble.ts    组装 system prompt
  index.ts       对外入口 + 注册
  coliving/
    index.ts     合租房大脑：清单 + 路由规则
    doctrine/    准则正文（编辑这里就能改行为）
      core.md            常驻 A：目标与仲裁（三道闸、优先次序、禁区）
      craft.md           常驻 B：手法（格式、措辞、轻管理十条）
      conflict.md        室友冲突调解
      complaint-risk.md  主动询问 / 投诉 / 风险升级
      tenancy.md         入住 / 规则 / 退租
      money.md           金钱边界
      records.md         记录 / 转交 / 拒绝不当指令
```

## 用法

```ts
import { assembleSystemPrompt } from "@/lib/ai/brains";

const { system, loadedModuleIds } = assembleSystemPrompt({
  brainId: "coliving",
  routeOn: userMessage,
  runtimeContext: houseAndResidentState, // 可选，状态库落地后接这里
});
```

**只能在服务端调用**（doctrine 走 fs 读取）。

## 路由规则的三种类型

| 类型 | 行为 | 用于 |
|---|---|---|
| 普通 | 命中即加入候选，受 `maxSituational` 上限（默认 2）约束 | 常规情境 |
| `force: true` | 无条件加载，**不占额度** | 安全信号、歧视/报复/非法驱逐——漏加载的代价远高于多占上下文 |
| `exclusive: true` | 命中即只加载本规则模块，短路其余普通规则（force 仍叠加） | 简单事实询问，避免为「垃圾周几倒」拉进整份调解准则 |

## 检查工具

```bash
pnpm brain:inspect                    # 跑路由探针（11 条）
pnpm brain:inspect "房租要晚几天"       # 看单句命中哪些模块、为什么
pnpm brain:inspect --full "..."       # additionally 打印完整 system prompt
pnpm brain:inspect --brains           # 列出已注册的大脑
```

**改了路由规则或准则文件，跑一次 `pnpm brain:inspect`。**
路由错误不会报错，只会悄悄加载错模块。

## 新增一个大脑

1. 建 `lib/ai/brains/<id>/doctrine/`，放常驻 .md（可多份，顺序即优先级）和若干情境 .md
2. 建 `lib/ai/brains/<id>/index.ts`，导出 `Brain`（清单 + 路由规则）
3. 在 `index.ts` 里 `registerBrain(...)`
4. 在 `scripts/brain-inspect.ts` 里加探针

## 与现有租房搜索 prompt 的关系

**目前没有迁移 `lib/ai/prompts.ts`。** 那是搜索链路的核心，
`.claude/AGENT_LOG.md` 里记着大量踩过的坑，动它风险高、收益低。

将来若要迁移，路径是：把 `regularPrompt` 拆成常驻层 +
按工具/意图切分的情境模块，路由按「搜房 / 通勤 / 求租帖 / 闲聊」分。
迁移前先跑 `pnpm search-eval` 建立基线。

## 尚未接入的两层

**运行时状态**（住户档案、房屋规则、未闭环事项）——
目前由调用方自己拼进 `runtimeContext`，等状态库落地后改为从数据库取。
没有这一层，准则只能给通用建议。

**工具**——`log_event` / `notify_manager` / `schedule_checkin` / `lookup_house_rule`。
缺了工具，这套东西只是聊天机器人。
