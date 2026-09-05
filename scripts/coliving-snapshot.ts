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
 * `--as-of` 是"当时的数据库状态"里的那个"当时"：想复现某条消息进来
 * 之前的世界，就填那条消息的时间，快照里不会带进它之后发生的任何事。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

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

  const asOfRaw = argValue("as-of");
  const asOf = asOfRaw ? new Date(asOfRaw) : null;
  if (asOfRaw && Number.isNaN(asOf!.getTime())) {
    console.error(`--as-of 不是合法时间：${asOfRaw}`);
    process.exit(1);
  }

  const { captureSnapshot } = await import(
    "../lib/chat/coliving/evals/snapshot"
  );
  const snap = await captureSnapshot({
    householdId,
    asOf,
    dropEmbeddings: hasFlag("drop-embeddings"),
  });

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `${out}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");

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
