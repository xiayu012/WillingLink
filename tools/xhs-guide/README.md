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
3. 仅剩候选逐条交给本地 Ollama，判断是否确为具体出租、转租或求租交易。

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

## 数据库（服务端）

1. 在 Neon 执行一次 `db/create_xhs_rental_listing.sql`。
2. Next 部署需配置 `POSTGRES_URL`（与现有应用一致）。
3. API 路径：`POST /api/xhs/rental-ingest`，无 `Authorization` 头。

## 使用方式

1. Tampermonkey 粘贴并保存 `userscript/xhs-guide.user.js`。
2. 按需调整 `titleScan.selectorCandidates`、`detailCopy.contentSelectorCandidates`。
3. 上报：`ingest.baseUrl` 改为你的站点根地址（如 `https://xxx.vercel.app`），本地开发可用 `http://localhost:3000`。

## LLM 配置（仅标题复核）

见脚本 `judgement.localLlm`；信息流标题只使用本地 Ollama，不回退远端。

## 调试

控制台搜索 `[xhs-guide]` 日志。
