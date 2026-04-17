# selectors 记录

用于记录“标题识别”相关选择器的主备方案与排障结果。

## titleScan.selectorCandidates（当前默认）

- `a[href*="/explore/"] [class*="title"]`
- `section .title span`
- `a[href*="/explore/"] h3`

## 失效症状

- 控制台日志中 `scanned` 长期为 0。
- 页面有帖子但没有任何高亮。
- 仅个别卡片命中，且命中不稳定。

## 排障流程

1. 在 DevTools 控制台执行：`document.querySelectorAll("<selector>").length`。
2. 逐个检查命中节点的 `innerText` 是否真的是帖子标题。
3. 若命中节点不可见，改为更贴近卡片标题文本的层级选择器。
4. 在本文件记录“页面路径 + 日期 + 生效选择器”。

## 标题选择器稳定性记录

- 2026-04-13
  - 页面: 小红书网页版信息流
  - 可用候选: `a[href*="/explore/"] [class*="title"]`, `section .title span`
  - 备注: class 命名可能频繁变化，建议始终保留多候选。
