/**
 * 抓一栋房子某个时刻的完整状态，存成可重放的快照。
 *
 * 用法：
 *   pnpm coliving-snapshot -- --list
 *   pnpm coliving-snapshot -- --household <uuid> --out kitchen-2026-09-04
 *   pnpm coliving-snapshot -- --household <uuid> --as-of 2026-09-04T18:30:00Z --out xxx
 *   pnpm coliving-snapshot -- --household <uuid> --out xxx --drop-embeddings
 *
 * **抓取全程只读**，可以直接对着真实住户的房子跑（那正是它的用途）。
 * 恢复时永远是一栋新的测试屋、手机号强制换成测试号段——见
 * `lib/chat/coliving/evals/snapshot.ts` 开头那三条安全性质。
 *
 * **落盘前会脱敏**：`captureSnapshot` 的直接返回值仍带着真实号码
 * （这是有意的，见 `snapshot.ts` 的说明），写进 `--out` 指定的文件之前
 * 一律先过 `toPortableSnapshot`——这个目录会被提交进 git，真实号码
 * 一次都不该落进这里。
 *
 * **不会覆盖已有文件**：`--out` 指到一个已经存在的快照，直接拒绝——
 * 这个目录里的东西是人工挑过、可能已经手改过的语料（跟
 * `scripts/coliving-shadow.ts` 导出场景是同一类数据安全要求），
 * `writeFileSync` 默认静默覆盖，会把已有语料冲掉。
 *
 * `--as-of` 是"当时的数据库状态"里的那个"当时"：想复现某条消息进来
 * 之前的世界，就填那条消息的时间，快照里不会带进它之后发生的任何事。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/**
 * `--out` 会被拼进文件路径（`snapshots/<out>.json`）。校验规则跟
 * `scripts/coliving-shadow.ts` 的 `--name` 一致——防路径逃逸。
 */
function assertSafeName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || name.includes("..")) {
    console.error(
      "--out 只能是字母数字开头，之后允许字母数字/点/下划线/短横线，" +
        "长度不超过 80，且不能包含 ..（防止路径逃逸），拒绝执行"
    );
    process.exit(1);
  }
}

const SNAPSHOT_DIR = path.join(
  process.cwd(),
  "lib/chat/coliving/evals/snapshots"
);

async function main() {
  const repo = await import("../lib/chat/coliving/repo");

  if (hasFlag("list")) {
    const rows = await repo.listHouseholds();
    console.log("现有房子：");
    for (const h of rows) console.log(`  ${h.id}  ${h.label}`);
    console.log(
      "\n抓其中一栋：pnpm coliving-snapshot -- --household <id> --out <名字>"
    );
    return;
  }

  const householdId = argValue("household");
  const out = argValue("out");
  if (!householdId || !out) {
    console.error(
      "用法：pnpm coliving-snapshot -- --household <uuid> --out <名字>\n" +
        "     先看有哪些房子：pnpm coliving-snapshot -- --list"
    );
    process.exit(1);
  }
  assertSafeName(out);

  // 目标已存在就拒绝——**在做任何抓取工作之前**先查一遍，省得抓了一整份
  // 快照最后才发现写不进去。真正写入时还会用独占创建再兜一次竞态。
  const file = path.join(SNAPSHOT_DIR, `${out}.json`);
  if (existsSync(file)) {
    console.error(`已存在，拒绝覆盖：${file}\n换一个 --out，或者先处理掉已有文件`);
    process.exit(1);
  }

  const asOfRaw = argValue("as-of");
  const asOf = asOfRaw ? new Date(asOfRaw) : null;
  if (asOfRaw && Number.isNaN(asOf!.getTime())) {
    console.error(`--as-of 不是合法时间：${asOfRaw}`);
    process.exit(1);
  }

  const { captureSnapshot, toPortableSnapshot } = await import(
    "../lib/chat/coliving/evals/snapshot"
  );
  const snap = await captureSnapshot({
    householdId,
    asOf,
    dropEmbeddings: hasFlag("drop-embeddings"),
  });

  // 校验（脱敏）先做完，落盘的必须是脱敏后的版本——这个目录进 git，
  // 一个真实号码都不能留下来。脱敏失败就直接报错退出，不写文件。
  let portable: typeof snap;
  try {
    portable = toPortableSnapshot(snap);
  } catch (e) {
    console.error(
      `快照脱敏失败，拒绝写文件：${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // `wx`：文件已存在就报错、不覆盖。上面的 existsSync 已经查过一遍，
  // 这里是检查和写入之间那段时间的竞态兜底，双保险不吃亏。
  try {
    writeFileSync(file, JSON.stringify(portable, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (e) {
    console.error(
      `写文件失败，可能是刚好被别的进程创建了同名文件：${file}\n` +
        `${e instanceof Error ? e.message : String(e)}`
    );
    process.exit(1);
  }

  console.log(`快照已存：${file}`);
  console.log(`  来源：${snap.sourceLabel}（${snap.sourceHouseholdId}）`);
  console.log(`  截止：${snap.asOf ?? "不截断，抓的是当前全量"}`);
  console.log("  各表行数：");
  for (const [t, rows] of Object.entries(snap.tables)) {
    if (rows.length) console.log(`    ${t.padEnd(18)} ${rows.length}`);
  }
  console.log("  号码映射（重放时用右边这些发消息）：");
  for (const [real, test] of Object.entries(snap.phoneMap)) {
    // 真实号码只显示后四位，避免快照日志本身变成一份通讯录
    console.log(`    ***${real.slice(-4)} → ${test}`);
  }
}

main().catch((e) => {
  console.error("抓快照失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
