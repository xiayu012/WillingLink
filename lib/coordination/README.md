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

## 目录结构（自包含）

```
lib/coordination/
  README.md       本文件
  types.ts        State / Event / Intent / OutboundAction 类型
  machine.ts      reduce（事件日志→状态）、step（状态+Intent→新事件+动作）、不变量
  intent.ts       parseIntent 接口 + 一个确定性 stub
  machine.test.ts 纯函数单测（不调 LLM）
```

## 设计目标

- **纯函数**：输入（事件日志 + 当前消息的 Intent）→ 输出（新事件 + 要发出的动作），
  无副作用、可单测、可回放。
- **零耦合**：不 import 项目里任何 coliving 代码，便于整体删除或替换。
- **可渐进落地**：先在旁边跑通，验证思路后，再决定是否把现有
  `pickSchedule`/`contactPerson`/确认逻辑逐步迁移进来。
