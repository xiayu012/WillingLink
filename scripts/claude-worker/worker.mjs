import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Claude worker：让 Codex 并行调用本机 Claude Code（headless 短会话）作为
// 实现工程师。每个任务独立 `claude -p`，互不阻塞；结果落成 JSON 文件。
//
// 用法：
//   node scripts/claude-worker/worker.mjs tasks.json
// tasks.json 形如：
//   [
//     { "id": "fix-a", "prompt": "……", "sessionId": "可选恢复的会话", "workdir": "D:\\WillingLink" }
//   ]
// 环境变量：
//   CW_CONCURRENCY=3   并发数
//   CW_TIMEOUT_MS=600000  单任务超时（毫秒）
//   CW_MODEL=sonnet    模型别名
//   CW_EFFORT=medium   effort
// 输出：scripts/claude-worker/out/<id>.json
// ──────────────────────────────────────────────────────────────────────────

const CONCURRENCY = Number(process.env.CW_CONCURRENCY ?? 3);
const TIMEOUT_MS = Number(process.env.CW_TIMEOUT_MS ?? 10 * 60 * 1000);
const MODEL = process.env.CW_MODEL ?? "sonnet";
const EFFORT = process.env.CW_EFFORT ?? "medium";
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

function readTasks(p) {
  const file = path.resolve(p);
  if (!existsSync(file)) throw new Error("tasks 文件不存在: " + file);
  const tasks = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks 必须是数组且非空");
  return tasks;
}

function runOne(task) {
  return new Promise((resolve) => {
    const id = task.id ?? "task";
    const workdir = task.workdir ?? process.cwd();
    const args = [
      "-p",
      "--model", MODEL,
      "--effort", EFFORT,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,Bash",
      "--output-format", "json",
    ];
    if (task.sessionId) args.push("--resume", task.sessionId);

    const child = spawn("claude", args, { cwd: workdir, shell: true });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill();
        finish({ ok: false, error: "timeout", stdout, stderr });
      }
    }, TIMEOUT_MS);

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(result, null, 2), "utf8");
      resolve({ id, ...result });
    }

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({ ok: false, error: e.message, stdout, stderr }));
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch { /* 保留原始输出 */ }
      finish({ ok: code === 0, code, parsed, stdout, stderr });
    });

    child.stdin.write(task.prompt ?? "");
    child.stdin.end();
  });
}

async function main() {
  const tasksFile = process.argv[2];
  if (!tasksFile) {
    console.error("用法: node worker.mjs tasks.json");
    process.exit(1);
  }
  const tasks = readTasks(tasksFile);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      results.push(await runOne(tasks[i]));
    }
  }
  const pool = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker);
  await Promise.all(pool);
  const ok = results.filter((r) => r.ok).length;
  console.log(`完成 ${results.length} 个任务，成功 ${ok}，失败 ${results.length - ok}`);
  console.log("输出目录:", OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
