# Twilio 短信渠道

**唯一入口是 `/api/twilio/messages`。** 曾短暂存在过 `/api/twilio/coliving`，已合并，
不要再开第二条。

```
用户短信 ──> Twilio ──POST──> /api/twilio/messages   立刻回空 TwiML
                                    │
                                    ├─ TWILIO_BRAIN=coliving（默认）
                                    │    after()：runColivingTurn → 工具 → sendSms
                                    │
                                    └─ TWILIO_BRAIN=rental
                                         handleInboundMessage → Chat Engine（需 DB 表）
```

合租房这条的事实全部落在 `coliving` schema 的世界模型里（人、房子、成员关系、
事件、Case、Decision、Communication）。建表与播种见 `pnpm coliving:db`。

## 为什么不同步回 TwiML 正文

Twilio 对 webhook 只等约 15 秒，而一轮带 1–2 万字符准则的对话可能压线。
所以**立刻回空 TwiML，回复走出站 API**——跟 `/api/xhs/messages` 踩过的是同一个坑
（见 `lib/chat/README.md` 与 AGENT_LOG 里 60 秒被硬杀那次）。

## 两种大脑

| | `coliving`（默认） | `rental` |
|---|---|---|
| 准则 | `lib/ai/brains` 的 coliving | `lib/ai/prompts.ts` |
| 会话存储 | 进程内存 | Neon（需 channel-identity 表） |
| 跨渠道上下文 | 无 | 有 |
| 工具 | logEvent / notifyManager | 搜索那一套 |
| 返回方式 | 空 TwiML + 出站 API | 同步 JSON |

用 `TWILIO_BRAIN` 切换。验签、TwiML、分段、出站发送都在 `lib/chat/twilio.ts`，两者共用。

## 环境变量

| 变量 | 用途 | 必需 |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | 出站 API 路径 | ✓ |
| `TWILIO_API_KEY_SID` | 出站 HTTP Basic 用户名 | ✓ |
| `TWILIO_API_KEY_SECRET` | 出站 HTTP Basic 密码 | ✓ |
| `TWILIO_MESSAGING_SERVICE_SID` | 出站走哪个 Messaging Service | ✓ |
| `TWILIO_AUTH_TOKEN` | **验签**（与出站认证是两回事） | ✓ |
| `CHANNEL_ADAPTERS_ENABLED=1` | 渠道总开关，默认关 | ✓ |
| `TWILIO_WEBHOOK_URL` | 验签用的 URL；代理后面 `request.url` 不准时显式指定 | 视情况 |
| `TWILIO_WEBHOOK_INSECURE=1` | 无 Auth Token 时跳过验签，**仅联调** | 否 |

**为什么 Auth Token 和 API Key 都要**：出站用 API Key（可单独吊销，泄露不用换整号）；
但 `X-Twilio-Signature` 是 Twilio 用**账号 Auth Token** 算的 HMAC-SHA1，
API Key Secret 算不出来。所以验签只能用 Auth Token，它不参与发送。

## 自检

```bash
pnpm twilio:selftest                    # 环境变量 + 验签算法 + 大脑组装
pnpm twilio:selftest --send +1650XXXXXXX  # 真发一条（会计费）
```

## 住户身份从哪来

**数据库**，不再是环境变量。手机号 → `coliving.person_contact` → `person` →
当前生效的 `membership`（`valid_to is null`）→ `household`。

**认不出的号码不会落任何记录**，只回一句"请问你是哪一位"。这是有意的：
陌生号码往任何一栋房子里写事件，等于给任何人开了污染事实账本的口子。

首次建库与播种：

```
pnpm coliving:db --apply      # 建表（幂等，两份 SQL 都会跑）
pnpm coliving:db --seed       # 用 COLIVING_ROSTER 建出第一个 household
pnpm coliving:db --status     # 看每张表多少行
pnpm coliving:db --wipe       # 清事件/判断/沟通，保留人与房子
```

换人（**历史不覆盖**，两边都会滚新的 household_epoch）：

```
pnpm coliving:db --move-out 小王 --reason "租约到期"
pnpm coliving:db --move-in 小陈 --phone +1555... --note "厨师，晚上十点下班"
```

主动发起（回访冷掉的事 · 问完没问全的共同规则 · 新住户头两周接触）：

```
pnpm coliving:outreach          # 干跑，只打印会发什么
pnpm coliving:outreach --send   # 真发
```

线上是 `vercel.json` 的 cron，每天两次（太平洋时间正午与晚八点，
避开早晚高峰）。**频率闸门不在 cron 上**，在 `outreach.ts` 里：
同一个人两天内不主动找第二次、同一件事最多回访三次、
`person.proactive_ok=false` 直接跳过。急停：`COLIVING_OUTREACH_OFF=1`。

判例与资料（Knowledge 域，只放证据不放规则）：

```
pnpm coliving:ingest <文件或目录> --kind case_precedent --jurisdiction CA
pnpm coliving:ingest --list
pnpm coliving:db --embed        # 给已了结的 Case 补算向量
```

`COLIVING_ROSTER` **只在 `--seed` 时读一次**，之后运行时不再用它。
往房子里加人、换人，改数据库（成员变化是给旧行填 `valid_to` 再插新行，
不覆盖历史），不要再改那个环境变量。

Vercel 上需要 `POSTGRES_URL`（本来就有）。

## 工具

| 工具 | 作用 |
|---|---|
| `logEvent` | 留痕。**判定「无需处理」时也要调**——准则要求不作为同样可被复核 |
| `notifyManager` | 转交管理方，真的发短信过去 |

`notifyManager` 有一条硬逻辑：**收件人里排除发起人本人**。
管理方自己下达不当指令时，「通知管理方」等于通知那个下命令的人；
此时改为完整留痕 + 提示 AI 如实告知不执行、且不隐瞒外部申诉渠道
（见 `情境_05`「涉及管理方本身的投诉不得在内部闭环」）。

## 本地测试（不发短信、不花钱）

```bash
pnpm coliving:sim --scenario list      # 列出剧本
pnpm coliving:sim --scenario lockout   # 跑一个
pnpm coliving:sim                      # 交互模式，@名字 切换说话人
```

剧本对应 `合租房AI大脑/测试用/测试方法.md` 里那十个探针。

## 排查

```bash
pnpm twilio:inspect          # 号码 / Messaging Service / webhook 现状
pnpm twilio:inspect --logs   # 最近 20 条消息，含错误码
pnpm twilio:inspect --set-webhook https://…/api/twilio/messages
```

常见错误码：
- **11200 HTTP retrieval failure** —— Twilio 打不通我们的 webhook。八成是没部署，
  或路径写错，或返回了非 2xx。
- **30032 Toll-Free Number Has Not Been Verified** —— toll-free 没过验证，发不出去。
- **21211 Invalid To phone number** —— 号码格式不对（少了 +1）。

## 当前账号状态（2026-08-30 查得）

- Messaging Service `Low Volume Mixed A2P`（MGa8…d855），Sender Pool 里只有 Long Code
- **`use_inbound_webhook_on_number = true`** —— 所以生效的是**号码级** webhook，
  Messaging Service 自己的入站配置是空的
- 两个号码的入站 webhook 都已指向 `https://willinglink.com/api/twilio/messages`
  - **+1 (669) 669-0693** Long Code —— 出站实测可用
  - **+1 (855) 490-8718** Toll-free —— 出站曾报 `30032`（未通过验证）；
    若已完成 toll-free 验证则可用，否则只能用 Long Code 发
- 2026-08-30 22:55 有一条真实入站测试报 `11200`，原因是当时代码尚未部署。

## ⚠️ webhook 必须写 www，不能写裸域

`willinglink.com` 会 **308 跳转**到 `www.willinglink.com`。
Twilio 打裸域会吃到跳转，而 **`X-Twilio-Signature` 是按原始 URL 算的**——
跳转之后 URL 变了，验签必然失败。表现是 403，且看不出原因。

所以：
- Twilio 号码的入站 webhook 必须填 `https://www.willinglink.com/api/twilio/messages`
- 同时把 `TWILIO_WEBHOOK_URL` 设成同一个值。代理后面 `request.url` 未必等于
  Twilio 实际请求的地址，显式指定才可靠。

## 线上环境变量（Vercel · Production）

已配好：`TWILIO_AUTH_TOKEN`（验签）、`TWILIO_ACCOUNT_SID`、
`TWILIO_MESSAGING_SERVICE_SID`、`TWILIO_WEBHOOK_URL`、`POSTGRES_URL`、
`CHANNEL_ADAPTERS_ENABLED=1`。

`COLIVING_ROSTER` 线上**不再需要**（身份走数据库了），留着也无害。
可选：`COLIVING_MODEL` 覆盖模型，默认 `anthropic/claude-sonnet-4.5`。

**线上没有配 API Key**，出站走 `AccountSid:AuthToken` 回落路径（见 `sendSms`）。
日志里会打 `[twilio] 出站认证方式：auth-token` 便于确认。

`TWILIO_BRAIN` 没配，代码默认 `coliving`。

**改了环境变量必须重新部署才生效**——Vercel 不会自动把新变量注入已有部署。

## 已知局限

- **进程内存的会话**：serverless 上每实例一份，扩容/冷启动就丢，同一个人两条消息
  可能落到不同实例。**只存对话轮次，不存住户档案**——而准则真正要的是档案
  （「有人投诉噪音时系统已经知道谁在睡」靠的是档案不是历史）。
- **没有工具**：不能真的记录事件、通知管理方、安排回访。目前只会说话。
- **没有去重**：Twilio 重试会重复触发一轮模型调用。
- **没有限流**：无鉴权入口（验签之外没有额度控制），靠 `CHANNEL_ADAPTERS_ENABLED` 兜底。
- **禁区只在提示词里**：不谈驱逐、不给法律建议、不碰钱——这些**应当在应用层拦截**。
