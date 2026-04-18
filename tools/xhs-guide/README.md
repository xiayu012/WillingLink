# xhs-guide

小红书网页版油猴工具（多标题识别高亮 + 详情页复制正文指引）。

## 目标

在信息流扫描可见标题并高亮命中项；进入详情页后提供“复制正文”按钮，由用户点击触发复制纯正文。

## 目录结构

- `userscript/xhs-guide.user.js`: 油猴脚本主文件（执行层 + 判断流水线）
- `config/steps.json`: 配置模板（标题扫描、规则词表、LLM参数）
- `docs/selectors.md`: 标题选择器与排障说明

## 判断流水线

脚本中的 `runTitleJudgementPipeline()` 是核心可扩展环节，当前包含 3 个 stage：

1. `ruleScreenStage`: 城市词 + 租房词组合初筛
2. `llmReviewStage`: 对初筛命中项做模型复核（可开关）
3. `postProcessStage`: 合并置信度并产出最终高亮决策

后续业务变更可在该流水线中新增 stage（例如黑名单词、账号标签、时间策略）。

## 详情页复制模式

- 当 URL 路径包含 `/explore/` 时，脚本自动切换到详情模式。
- 脚本会高亮右下角的 `复制正文` 按钮，提示你点击。
- 点击按钮后复制的是纯正文文本（不做结构化包装）。

## 使用方式

1. 打开 Tampermonkey，新建脚本。
2. 粘贴 `userscript/xhs-guide.user.js` 全部内容并保存。
3. 修改脚本中的 `DEFAULT_CONFIG.titleScan.selectorCandidates` 以匹配当前页面标题节点。
4. 若开启 LLM 复核，填写 `DEFAULT_CONFIG.judgement.llm.apiKey`。
5. 在信息流页查看命中标题高亮；点开帖子详情后使用右下角 `复制正文` 按钮。

## LLM配置说明（直连模式）

- `enableLlmReview`: 是否开启模型复核。默认 `false`（先仅规则判断，可直接运行）。
- `endpoint`: OpenAI兼容接口地址。
- `model`: 模型名。
- `apiKey`: 直连密钥。

注意：直连模式会把密钥放在脚本中，存在泄露风险。生产长期使用建议迁移到后端中转。

## 调试建议

- 打开浏览器开发者工具查看 `[xhs-guide]` 前缀日志。
- 若标题无法识别，优先调 `titleScan.selectorCandidates`。
- 若 LLM 请求失败，脚本会自动降级为规则模式并继续运行。
- 若详情页未定位到正文，优先调 `detailCopy.contentSelectorCandidates`。
