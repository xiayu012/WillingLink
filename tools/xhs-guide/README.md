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

## 详情页复制模式

- URL 命中 `detailCopy.pathKeywords` 时进入详情模式。
- 高亮右下角 `复制正文` 按钮；点击后复制纯正文。
- 若 `ingest.enable` 为 true 且填了 `ingest.baseUrl`，复制成功后会 `POST /api/xhs/rental-ingest`（无鉴权）。Body 至少含 `pageUrl`（或 `sourceUrl`）与 `rawText`；其余租房字段可选，脚本仅**尽力**附带 `title`，其它字段可留空由服务端存 `null`。

## AI 评论回复（`commentReply`，0.14.0 起）

复制正文的同时，正文会并行 `POST /api/xhs/comment-reply`。服务端把这段正文当成
"用户在聊天页发的一条消息"跑一遍项目 AI（同一套 system prompt + searchRental /
searchWanted 等工具），额外追加一段"输出去评论区"的渠道规则：判断帖子是求租
（找房源）还是招租（找租客）还是经验帖（不调工具、不提房源），输出纯文本、不带
Markdown 和网址、最多 3 条房源、400 字以内。

脚本侧：

- 请求期间/就绪后**框选评论输入框**（`.inner-when-not-active`），气泡分别提示
  「AI 正在写评论回复…」「点这里，自动粘贴 AI 回复」。
- 人工点一下评论框 → 回复写进剪贴板，并等编辑器（`#content-textarea` 等
  contenteditable）挂载后自动插入；插入走 `execCommand("insertText")`，Vue 的
  `input` 监听收得到。自动插入失败也不影响——文字已在剪贴板，Ctrl+V 即可。
- 回复没写完就点了评论框：记下来，写完立刻粘（占位框那时已经消失，等不到第二次
  点击）。
- **发送键始终由人工按**，脚本不自动提交。
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
