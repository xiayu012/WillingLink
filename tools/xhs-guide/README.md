# xhs-guide

小红书网页版油猴工具（多标题识别高亮 + 详情页复制正文指引）。

## 目标

在信息流扫描可见标题并高亮命中项；进入详情页后提供「复制正文」按钮，由用户点击触发复制纯正文；可选把正文 POST 到本仓库 Next 应用写入数据库。

## 目录结构

- `userscript/xhs-guide.user.js`: 油猴脚本
- `geo/generate-geo-index.mjs`: 下载 GeoNames 并生成内嵌地理索引
- `geo/verify-geo-index.mjs`: 地理边界、典型标题与查询耗时验证
- `config/steps.json`: 配置参考
- `docs/selectors.md`: 标题选择器记录
- `db/create_xhs_rental_listing.sql`: **一次性建表**（在 Neon 控制台执行；不再用 Drizzle migration 管这张表）

## 判断流水线

信息流标题按以下顺序处理：

1. GeoNames 离线索引判断地点。明确外地区或无法确认属于核心五县时直接拒绝。
2. 核心五县标题必须同时含住房交易词，否则直接拒绝。
3. 仅剩候选进入单一优先级队列，按批（`judgement.remoteLlm.batchSize`）请求 Vercel 后端，
   由 OpenAI gpt-4o-mini 判断是否确为具体出租、转租或求租交易。队首标题不等凑批，够几条发几条；
   `IntersectionObserver` 会在标题进入视窗前 `prefetchAheadViewport` 屏就把它排进队首。

地理边界是 San Francisco、San Mateo、Santa Clara、Alameda、Contra Costa
五县。运行时不请求地图服务。

更新数据：

```shell
pnpm xhs:generate-geo-index
pnpm xhs:verify-geo-index
```

地名来自 GeoNames `cities15000` 与美国邮编数据，采用 CC BY 4.0 许可。

## 「No. N」计数器（0.16.0 起）

页面最上方居中的蓝色小徽标，统计**点开过多少个被框选的标题**。只在信息流里
点中高亮候选才 +1（挂在 `handleTitleClickDismiss` 里，没被框中的标题根本走不到
那一步）；计数存在 `localStorage` 的 `xhs-guide-highlight-click-count`，属于
xiaohongshu.com 这个源，刷新、重开浏览器都还在，不设上限也不会自动清零。
要归零就在控制台 `localStorage.removeItem("xhs-guide-highlight-click-count")`。

## 详情页复制模式

- URL 命中 `detailCopy.pathKeywords` 时进入详情模式。
- 高亮右下角 `复制正文` 按钮；点击后复制纯正文。
- 若 `ingest.enable` 为 true 且填了 `ingest.baseUrl`，复制成功后会 `POST /api/xhs/rental-ingest`（无鉴权）。Body 至少含 `pageUrl`（或 `sourceUrl`）与 `rawText`；其余租房字段可选，脚本仅**尽力**附带 `title`，其它字段可留空由服务端存 `null`。

## AI 评论回复（`commentReply`，0.14.0 起）

复制正文的同时，正文会并行 `POST /api/xhs/comment-reply`。**这条路由现在是一个
渠道**：它会按帖主身份建/找一条 WillingLink conversation，整轮对话（帖子正文、
AI 回复、"压到 260 字"的指令、压完的版本）都进 `Chat` + `Message_v2`，最后一条
助手消息就是进剪贴板的文字。同一个帖主的第二条帖子会落进同一条会话，以后 ta 从
私信或短信找过来，接的是同一串上下文（见 `lib/chat/README.md`）。

帖主身份从详情页 `.author-wrapper` 抓：`/user/profile/<id>` 里的 id 当
`externalUserId`、`.username` 当 `displayName`，存进 `ChannelIdentity`。抓不到就
退回一次性会话，行为跟以前一样。

服务端把这段正文当成
"用户在聊天页发的一条消息"跑一遍项目 AI（同一套 system prompt + searchRental /
searchWanted 等工具），额外追加一段"输出去评论区"的渠道规则：判断帖子是求租
（找房源）还是招租（找租客）还是经验帖（不调工具、不提房源），输出纯文本、不带
Markdown 和网址、最多 3 条、每条一行。

有内容可列时开头固定是 `看看这些怎么样：`，**没有任何结尾句**（寒暄、点评、
邀请私信一律不写），全文约 260 个 Unicode code points。

长度是这么控的：第一遍 agent **放开写**（每条房源该有的租金、房型、位置、时间、
亮点都写全），超过上限就**在同一条会话里再说一句"压到 260"**，让它自己缩写。
方向很重要——**压缩只做减法，扩写必然编造**：曾让模型拿着素材"扩写到 260 字"，
素材只有 1 条时它直接编出两条不存在的房源。所以草稿本身不长时就原样返回，绝不叫
模型往长里写。缩写偶尔压不到位（实测回过 363 字符），最后还有一道确定性闸门
`trimToBudget()`：按空行**整块**丢尾巴，丢的是整条房源，不会把某条截成半句。

服务端还会删掉聊天页话术（"已放宽关键词""如仍不满意…我再为您调整"，legacy
searchWanted 写在 action 里的）、删掉重复条目、删掉结尾散文。模型一个字没写但
工具查到了条目时，退回按真实字段确定性拼装的兜底。

素材不够就短（只查到一个求租者时就一行），**短了没关系，编造不行**；经验帖和
无匹配没有条目，原样返回模型那一两句如实回答，也不加固定开场白。

响应里的 `hasListings` 告诉脚本这条回复到底有没有房源可推——**没有就整段跳过
评论**（不占剪贴板、不框评论框和发送键，直接进分享那一步）。

写手模型是项目默认的 `openai/gpt-4.1-mini`（`XHS_COMMENT_REPLY_MODEL` 可覆盖）。

**先分岔再干活**：复制正文后先问 `POST /api/xhs/post-intent`（复用入库那套
`classifyRentalPostIntent`，模型换成全项目最便宜的 gpt-4o-mini，且多数帖子走正则
快路径**一次模型都不用调**）。只有判定为**租客求租**才继续跑评论生成；招租帖和
经验帖直接跳到分享那一步，省掉一整轮带搜索的 agent。判不出来（网络/服务端出错）
时按求租帖继续——宁可多花一次也不因一次抖动静默关掉功能。

脚本侧的框选是**一条单线程流水线，一次只亮一个，点过就换下一个**：

    复制正文 →（等待遮罩）→ 评论输入框 → 发送按钮 → 分享按钮 → 弹层里的「复制链接」

非求租帖、或回复里没有房源时，中间两步整段跳过，直接走到分享按钮。最后一步不靠
记状态：分享弹层里的 `.xhs-note-share-popup-action-item`（认「复制链接」标签或
`#link_b` 图标）**只有点开弹层才存在且可见**，找得到就说明分享按钮已经点过了。
点完「复制链接」红框立即收起（链接已进剪贴板，写库是后台的事，不该继续杵个框）。

- 请求期间/就绪后**框选评论输入框**（`.inner-when-not-active`），气泡分别提示
  「AI 正在写评论回复…」「点这里，自动粘贴 AI 回复」。
- 等服务器返回期间盖一层全屏遮罩（正中巨大的 `WAIT`）：点不穿、拦滚轮/触摸/
  翻页键、html+body `overflow:hidden`。这是通用轮子 `createScreenBlocker()`
  （`show(text)` / `hide()` / `isVisible()`），任何"这段时间别让用户碰页面"的场景
  都能直接用。它**不放在 `#xhs-guide-overlay-root` 里**：那层每次重绘都
  `replaceChildren()`，而且是 `pointer-events:none`（让框选不挡点击），跟这层要
  接住一切输入正相反。
- 回复到手就写进剪贴板（这时分享步骤还没轮到，不抢剪贴板）。
- 人工点一下评论框 → 该框选立刻消失，开始插入。找编辑器的顺序是
  `document.activeElement`（刚点完，光标就在里面）→ 配置选择器 → **限定在评论
  容器内**的兜底，最长等 3.2s。自动插入失败也不影响——文字已在剪贴板，Ctrl+V 即可。
- 插入机制（**不模拟 paste / Ctrl+V**，合成的 ClipboardEvent 是 untrusted，
  页面可以直接忽略）：剪贴板在 pointerdown/click 回调里**同步**调
  `navigator.clipboard.readText()` 读（await 一次手势就过期了），读到的内容要跟
  本地那份对得上才用；写入时 input/textarea 走原型链上的原生 value setter（React
  劫持了 `element.value`），contenteditable 用 Selection/Range 真改 DOM（文本节点
  + `<br>`）；两条路都补发**冒泡的 beforeinput/input InputEvent**，否则框里看着
  有字、Vue/React 的数据仍是空，点发送等于发了条空评论。
- 粘完后框选发送按钮（`button.btn.submit`）；**发送键始终由人工按**，脚本不自动
  提交。点过发送键之后，才轮到分享按钮的框选。
- 回复没写完就点了评论框：记下来，写完立刻粘（占位框那时已经消失，等不到第二次
  点击）。
- 评论链路没开、还没请求或请求失败时，分享按钮的框选照旧立即出现——AI 出问题
  不会把入库/分享这条老链路堵死。
- 剪贴板里的 AI 回复被显式排除在"分享链接捕获"之外，否则回复里万一带小红书链接
  会把本条房源的 `sourceUrl` 写成别的帖子。

服务端设了 `XHS_API_TOKEN` 时，把同一个值填进脚本 `commentReply.token`（以
`X-Xhs-Token` 头发送）。这个路由每次调用都会跑一轮带搜索的 agent，比
`rental-ingest` 贵得多，公开部署建议设上。

## 数据库（服务端）

1. 在 Neon 执行一次 `db/create_xhs_rental_listing.sql`。
2. Next 部署需配置 `POSTGRES_URL`（与现有应用一致）。
3. API 路径：`POST /api/xhs/rental-ingest`，无 `Authorization` 头。

## 使用方式

1. Tampermonkey 粘贴并保存 `userscript/xhs-guide.user.js`。
2. 按需调整 `titleScan.selectorCandidates`、`detailCopy.contentSelectorCandidates`。
3. 上报：`ingest.baseUrl` 改为你的站点根地址（如 `https://xxx.vercel.app`），本地开发可用 `http://localhost:3000`。

## LLM 配置（仅标题复核）

见脚本 `judgement.remoteLlm`；浏览器不保存 OpenAI 密钥，服务端通过 AI Gateway 调用
`openai/gpt-4o-mini`。

## 调试

控制台搜索 `[xhs-guide]` 日志。
