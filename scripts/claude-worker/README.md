# Claude worker（并行短会话调度器）

让 Codex 并行调用本机 Claude Code（headless `claude -p`）作为实现工程师。
每个任务独立会话、互不阻塞，避免把超大 session `--resume` 卡死。

## 为什么不用超大 session resume

那条约 47MB 的长期会话用 `claude -p --resume <sessionId>` 续接时经常无响应/挂起。
正确姿势是：**短会话 + 最小上下文**。每个修复任务写一段自包含的 prompt（必要时
指到 `.claude/CODEX_TASK.md` 这种任务文件），worker 并发跑多个，互不污染。

## 用法

1. 写一个 tasks.json：

```json
[
  { "id": "fix-duplicate", "prompt": "读取 .claude/CODEX_TASK.md 并严格执行…" },
  { "id": "fix-verbose",   "prompt": "读取 .claude/CODEX_TASK_2.md 并严格执行…" }
]
```

2. 运行：

```powershell
$env:CW_CONCURRENCY="3"
node scripts/claude-worker/worker.mjs tasks.json
```

3. 看结果：`scripts/claude-worker/out/<id>.json`（含 `parsed` 结构化结果）。

## 环境变量

- `CW_CONCURRENCY`：并发数（默认 3）
- `CW_TIMEOUT_MS`：单任务超时毫秒（默认 10 分钟）
- `CW_MODEL`：模型别名（默认 sonnet）
- `CW_EFFORT`：effort（默认 medium）

## 注意

- 每个任务用 `--permission-mode acceptEdits` + `Read,Edit,Write,Bash`，只对受信目录。
- prompt 会从 stdin 传入，避免 Windows 命令行过长截断。
- 若任务需要恢复某会话，在任务对象里加 `"sessionId"`（小会话才建议恢复）。
