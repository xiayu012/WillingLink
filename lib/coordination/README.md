# 协商状态机（Coordination State Machine）

这是把“多人用自然语言协调一件事（比如厨房排班）”从 LLM 手里拿回确定性代码的
**实验性架构**。低耦合、自包含，**可整体删除**（删掉 `lib/coordination/` 即可）。

## 一句话定位

LLM 只做一件事：把住户说的一句话翻译成一个结构化 `Intent`。真正的“协调”由这里
的确定性状态机完成——它记状态、走转移、守不变量、决定下一步该对谁说什么。

## 借自底层系统的四个思想

1. **事件溯源（数据库）**：不“改状态”，只**追加事件**；当前状态由事件日志重放推导。
   谁报了什么时间、谁确认、谁拒绝，都是不可变事件，永远可回放、可审计。
2. **极小状态机（CPU）**：少数状态 + 少数转移，循环执行，从不“思考”。
   聪明不来自大模型，来自状态集和转移集定得恰到好处。
3. **不变量（物理守恒律）**：硬约束由代码强制，不靠 LLM 自觉。
4. **薄意图层（无为）**：LLM 做最少的事，系统靠结构自己流转。

## 状态（State，派生，不落库）

- `gathering` —— 信息还没齐（还有人的可用时间/时长没报）。
- `proposed` —— 已排出一版方案，正在等人确认。
- `settled` —— 全员确认，已定案。
- `renegotiating` —— 有人拒绝/反提/加了新约束，正在重排。

“卡住/部分确认”这类是**派生状态**，不单独存：由事件日志算出来
（谁 pending、谁确认了、谁超时了）。

## 事件（Event，只追加，不可变）

- `availability_reported { person, start, duration, latestStart? }`
  —— `latestStart` 是「最晚必须开始」的分钟数，缺省表示没有上限（「八点太晚 / 不能晚于
  八点开始」的落点）；它与 `start`（最早能开始）合起来把可用起点圈成 `[start, latestStart]`。
- `schedule_proposed { window, assignments[] }`
- `confirmed { person }`
- `rejected { person, reason }`
- `reminded { person }`
- `settled { window, assignments[] }`

## 转移（给定 Intent，状态机产出新事件 + 出站动作）

| Intent | 产出 |
|---|---|
| `report_availability` | 追加事件；若信息齐 → `schedule_proposed` + 给每人发提议 |
| `confirm` | 追加事件；若全员确认 → `settled` + 给每人发定案 |
| `reject` / `counter_propose` / `add_constraint` | 追加事件 → 重算 → `schedule_proposed` |
| `ask_status` | 对 pending 的人补 `reminded`（催一次，不重复问） |
| `other` | 无状态转移 |

## 不变量（Invariants，代码强制）

1. 一人同一窗口只占一段，不重叠。
2. 已确认的段不被静默改变——只有 reject/renegotiate 才会动。
3. 同一件事对同一人不重复发问：有 pending 时只 `remind`，不重发提议。
4. `settled` 必须全员确认，或明确豁免。

## LLM 的唯一职责

```ts
parseIntent(message, context): Intent
```

`Intent ∈ { report_availability, confirm, reject, counter_propose, add_constraint, ask_status, other }`

这一步可以先用**确定性的关键词/stub 解析器**跑通，之后再把 LLM 挂进去做真正的
意图理解——但无论解析器怎么换，状态机这一层不变。

## 持久化（append-only JSONL）

状态是**派生**的、不落库；落盘的只有**追加的事件日志**，用 **JSONL**（每行一个
JSON 事件、行尾换行）存成文件。存储层是自包含的 `store.ts`：只 import node 内置
`fs`/`path` 和 `types.ts` 的 `Event` 类型，不 import 任何项目业务代码、不 import
通用聊天框架或第三方持久化依赖。

- `appendEvents(filePath, events)` —— 把事件**追加**到文件末尾，绝不覆盖已有行；
  目录不存在自动建。空数组不写。
- `loadEvents(filePath)` —— 读整个 JSONL，按行解析成 `Event[]`；文件不存在返回
  `[]`，单行解析失败**跳过该行**，不让一条坏行毁掉整次重放。取回的日志直接喂给
  `projectState`（`reduce`/`fold`）重放，得到当前状态——**状态 = 日志重放出的
  物化投影**，磁盘上不另存一份"当前状态"。
- `readLatest(filePath, limit)` —— 读最后 `limit` 条事件（正序）并返回事件总数。
  这是「最近窗口」的底层：把尾部事件喂 `projectState`，就在有限窗口里恢复最近
  事实，不必每次整段重放。
- `saveCheckpoint(filePath, snap, offset)` / `loadCheckpoint(filePath)` —— 把派生
  快照 `Snap` 摊平成 JSON（`machine.ts` 的 `snapToJson`）连同「已重放到的 offset」
  **覆盖写**到 checkpoint 文件；读回时 `snapFromJson` 还原成 `Snap`。文件不存在或
  解析失败时 `loadCheckpoint` 返回 `null`。
- `resume(eventsFile, checkpointFile)` —— 读 checkpoint（没有就 `emptySnap()` +
  offset 0），`loadEvents` 后取 `slice(offset)` 的增量事件，用 `foldFrom` 从快照
  续放，返回最新 snap 和新的 offset（= 当前事件总数）。**等价性保证**：
  `resume(...).snap` 与 `fold(loadEvents(...))` 完全等价（有测试锁死）。

**checkpoint 与事件日志性质不同，不混为一谈**：事件日志仍是 append-only JSONL，
只追加、从不覆盖；checkpoint 是**覆盖写**的派生物化快照，保存「已重放到的
offset + 当时完整 Snapshot」，丢了或坏了随时可从事件日志全量重放重建，不是事实
的原始记录。

设计不是自创，是**偷思想、不搬依赖**：

1. **事件溯源（数据库）**——只追加不可变事件、从不改状态；当前状态永远可回放。
2. **sqlite 物化投影 / 流式系统 checkpoint**——把"状态 = 对日志的物化投影"搬下来，
   落盘格式是纯文本 JSONL，不是 SQLite；等日志变大时用「物化快照 + 从快照续放」
   让重放只从最近的位置续起，不必每次整读整解析。`fold` / `foldFrom` 用同一套
   循环（`fold` 只是 `foldFrom(emptySnap(), events, 0)` 的薄封装），续放把事件
   下标看成 `baseIndex + 局部下标`，保证 `lastProposalIndex` / `lastDisruptIndex`
   仍记绝对位置、`renegotiating` 判定不被增量续放破坏。

## 目录结构（自包含）

```
lib/coordination/
  README.md       本文件
  types.ts        State / Event / Intent / OutboundAction 类型
  machine.ts      fold/foldFrom（事件日志→派生快照）、reduce、step、allocateSlots、
                  不变量；snapToJson/snapFromJson（快照 ⇄ JSON）
  intent.ts       parseIntent 接口 + 一个确定性 stub
  store.ts        append-only JSONL 持久化 + checkpoint 物化快照（appendEvents /
                  loadEvents / readLatest / saveCheckpoint / loadCheckpoint / resume）
  machine.test.ts 纯函数单测（不调 LLM）
  store.test.ts   持久化层纯 IO 单测（node 临时目录，不连库）
```

## 设计目标

- **纯函数**：输入（事件日志 + 当前消息的 Intent）→ 输出（新事件 + 要发出的动作），
  无副作用、可单测、可回放。
- **零耦合**：不 import 项目里任何 coliving 代码，便于整体删除或替换。
- **可渐进落地**：先在旁边跑通，验证思路后，再决定是否把现有
  `pickSchedule`/`contactPerson`/确认逻辑逐步迁移进来。
