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

服务端**不对项目 AI 塞任何提示词**，就是替用户把话说了（见 AGENT_LOG 的
「完全替代用户说话」原则）：

1. 帖子正文**原样**发给项目 AI —— 跟真人在聊天页粘一段帖子问"有房源吗"一样，
   同一套 system prompt、同一批工具，没有额外渠道规则。
2. 模型照常输出一大段。
3. 再以用户身份说一句「请缩写至260字符左右」；还是太长（>400 字符）就再用
   用户口吻催一次，且只有更短才采纳。
4. 拿缩写后的文字，**死代码**在最前面拼上「看看以下这些觉得怎么样，感兴趣的话
   私信我：」，进剪贴板。

保留的后处理只有三样，都是格式不是内容：Markdown → 纯文本（含去掉链接和裸
URL，评论区链接点不动）、删结尾那句"如需调整条件…"（用户早就要求过结尾一句
不许有）、以及按**工具返回**判断有没有房源可推。

实测缩写后落在 183-299 字符，偶尔仍会写成一段总结而不是三条房源——这是这条
路线的固有波动，好过回到"提示词 + 代码重写"那一套。

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
- 插入机制**刻意保持最简**（不用 `execCommand`，不合成 paste/Ctrl+V —— 浏览器
  命令和伪造事件都可能被风控认出是自动化）：剪贴板在 pointerdown/click 回调里
  **同步**调 `navigator.clipboard.readText()` 读（await 一次手势就过期），内容要
  跟本地那份对得上才用；写入时 input/textarea 走原型链上的原生 value setter
  （React 劫持了 `element.value`），contenteditable 用 Selection/Range 改 DOM，
  两条路都补**冒泡的 beforeinput/input InputEvent**，否则框里有字而 Vue/React 的
  数据仍是空，点发送等于发空评论。找编辑器只有两级：`document.activeElement`
  （刚点完，焦点在哪就是哪）→ 配置选择器。**没有更多兜底**：全页面搜编辑器既容易
  粘错框（实测粘进过搜索框），也让脚本越来越不像真人。粘不上就手动 Ctrl+V，
  本来也不指望 100% 成功。
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
