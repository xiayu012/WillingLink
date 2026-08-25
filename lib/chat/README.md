# 多渠道聊天（半成品骨架）

一句话原则：**WillingLink 的 conversation 才是聊天本体**，网页、小红书、短信、
企业微信只是同一个 conversation 的不同窗口。

```
网页    /api/chat            → （直接用 buildTurnSetup，保留 SSE）
小红书  /api/xhs/messages    → XHS adapter    ┐
Twilio  /api/twilio/messages → Twilio adapter ├→ handleInboundMessage → Chat Engine
企微    /api/wecom/messages  → WeCom adapter  ┘
```

## 现在有什么

| 文件 | 作用 | 成熟度 |
| --- | --- | --- |
| `types.ts` | `ChannelId`、`InboundTurn`、`TurnResult` | 可用 |
| `engine.ts` | `buildTurnSetup()`（模型/提示词/工具唯一来源）、`runChatTurn()`（非流式整轮） | 可用 |
| `identity.ts` | 外部身份 → 内部 user，没见过就建 guest 并绑定 | 可用，需先建表 |
| `conversation.ts` | 内部 user → chatId（取最近一条，没有就新建） | 可用，策略以后可换 |
| `adapter.ts` | adapter 公共骨架 + 总开关 + 错误翻译 | 可用 |
| `redact-contact.ts` | 出站剔除联系方式与外链（渠道自选，Engine 不管） | 可用，`pnpm redact-eval` 守着 |
| `xhs-dm.ts` | 私信渠道的提示词 / 模型 / 收联系方式识别 / 出站排版（分割线+1000字） | 可用，提示词与识别器必须同步改 |
| `app/api/xhs/messages` | 小红书私信 adapter，**已接通** | MVP：收 `{id, text}`，异步投递 |
| `jijyun.ts` | 出站投递到集简云 webhook | 可用，URL 走环境变量 |
| `app/api/twilio/messages` | 短信 adapter | 骨架，缺验签与 TwiML |
| `app/api/wecom/messages` | 企微 adapter | 骨架，缺验签/解密/异步推送 |

## 跨渠道上下文是怎么成立的

`handleInboundMessage` 里没有"某渠道的会话"这一步：

1. `resolveInternalUserId({ channel, externalUserId })` → 内部 userId
2. `resolveChatIdForUser({ userId })` → 该用户**唯一**的那条 conversation
3. `runChatTurn()` 按 chatId 读**全部**历史，不管当初从哪个渠道进来

所以：小红书说"想找 Sunnyvale"→ 短信说"预算 1300"→ 网页说"最好独卫"，模型看到的
是同一串对话；网页打开这条 conversation 也能看到另外两条渠道的消息。

## 上线顺序（按这个来，每步都可单独回滚）

1. **建表**：Neon 控制台执行 `lib/db/migrations/manual/channel-identity.sql`
   第 1 段。不跑这步，adapter 会返回 501 并明确告诉你差什么。
2. **打开开关**：`CHANNEL_ADAPTERS_ENABLED=1`（默认关闭，因为这些是无鉴权入口，
   每次调用都会跑一轮带搜索的 agent）。
3. ~~接第一个真实渠道（小红书私信）~~ **已接通**（2026-08-18）：
   **两次单向消息**，不是一问一答——集简云调我们只等 30 秒，而一轮带搜索的对话
   要 15-30 秒，同步返回必然压线。

   ```
   集简云 --POST {id,text}--> /api/xhs/messages   立刻 202（不带正文，实测 26ms）
   我们   --POST {id,text}--> JIJYUN_WEBHOOK_URL  想好了再发
   ```

   AI 那段活在 `after()` 里跑（响应发出之后继续，仍算在 maxDuration=60 内）。
   出站过一遍 `redactContactInfo`。失败也会投递一条 `ok:false`，免得那头空等。
   还缺：webhook 去重、限流。
4. **消息打渠道标签**：跑 SQL 第 2 段，然后把 `channel` / `externalMessageId`
   两列补进 `lib/db/schema.ts` 的 `message` 定义，`runChatTurn` 里存消息时带上。
   顺序不能反：drizzle 会按 schema 定义查列，库里没列会直接报错。
5. **接 Twilio / 企微**：照 xhs 那个 adapter 抄，各自补验签与回复格式。

## 有意没做的事

- **网页那条没有搬进 Chat Engine 跑**。SSE、resumable stream、标题生成、工具审批
  续跑都在 `/api/chat` 里，搬过来收益小风险大。它只是改成从 `buildTurnSetup()`
  拿模型/提示词/工具——**这一处收敛才是重点**，以后换模型两边同时生效，不会再
  出现 `/api/chat` 与 `/api/xhs/comment-reply` 各写一份然后慢慢漂移。
- **`/api/xhs/comment-reply` 保持独立**。它是一次性的"帖子评论生成"，无状态、
  不进聊天记录，跟私信不是一回事。它的渠道规则（纯文本、固定开场白、260 字）
  以后可以通过 `buildTurnSetup({ extraSystem })` 收编，但没必要现在动。
- **身份合并**只写了做法（SQL 注释里），没写流程。等真有两个渠道的同一个人再定
  谁并谁、冲突怎么办。
- **去重与限流**：`externalMessageId` 已经在链路里传，判重没写；webhook 渠道也
  还没有 entitlements 那样的额度控制。接真实渠道前必须补。
