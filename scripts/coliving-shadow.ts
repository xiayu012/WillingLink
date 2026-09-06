/**
 * 影子跑的复核台 —— 把真实流量沉淀下来的快照，挑出值得进语料的那些。
 *
 * 用法：
 *   pnpm coliving-shadow                          # 待复核队列
 *   pnpm coliving-shadow -- --show <id>           # 看某一条的完整对比
 *   pnpm coliving-shadow -- --export <id> --name <场景名>   # 导出成 eval 场景
 *   pnpm coliving-shadow -- --reject <id> --note "理由"     # 标记为没价值
 *   pnpm coliving-shadow -- --stats               # 统计
 *
 * ## 这个脚本在整条链路里的位置
 *
 * ```
 *   真人短信 → 生产版本正常回复（真发）
 *            → 影子跑：冻快照 + 候选版本在副本上跑（不发）
 *            → coliving.shadow_run          ← 自动沉淀，无人值守
 *            → 【这个脚本】人来复核、挑选     ← 唯一需要人的一步
 *            → lib/chat/coliving/evals/snapshots/*.json + scenarios/*.json
 *            → pnpm coliving-eval 每次跑批自动重放
 * ```
 *
 * **为什么导出这一步必须有人**：不是所有真实对话都值得进 corpus。
 * 语料的价值在于覆盖**不同的失败模式**，一百条"住户说谢谢、AI 回不客气"
 * 只会让跑批变慢、不会提高覆盖率。人要判断的是"这一条揭示了新东西吗"。
 *
 * **导出的快照会进 git**，里面是真人说过的话——号码在抓取时已经强制换成
 * 槽位号，但姓名和消息正文是原文。导出前自己判断这份内容适不适合进仓库
 * （跟 `snapshots/README.md` 里写的是同一条要求）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const sql = postgres(process.env.POSTGRES_URL ?? "", { max: 2, idle_timeout: 20 });

type ShadowRow = {
  id: string;
  household_label: string | null;
  inbound_from: string;
  inbound_text: string;
  arrived_at: Date;
  production_reply: string | null;
  production_tools: string[] | null;
  shadow_reply: string | null;
  shadow_tools: string[] | null;
  shadow_outbound: unknown;
  shadow_error: string | null;
  snapshot: unknown;
  review_status: string;
  review_note: string | null;
  created_at: Date;
};

/** 号码只显示后四位——这个脚本的输出可能被贴进别处，别让它变成通讯录 */
const maskPhone = (p: string) => `***${p.slice(-4)}`;

async function queue() {
  const rows = await sql<ShadowRow[]>`
    select id, household_label, inbound_from, inbound_text, arrived_at,
           production_reply, shadow_reply, shadow_error, review_status, created_at
    from coliving.shadow_run
    where review_status = 'pending'
    order by created_at desc
    limit 40`;
  if (rows.length === 0) {
    console.log("待复核队列是空的。");
    console.log("影子跑要 COLIVING_SHADOW=1 才会记录（见 lib/chat/coliving/shadow.ts）。");
    return;
  }
  console.log(`待复核 ${rows.length} 条（最新在前）：\n`);
  for (const r of rows) {
    const flag = r.shadow_error ? "✗跑挂了" : "  ";
    console.log(
      `${flag} ${r.id.slice(0, 8)}  ${r.created_at.toISOString().slice(0, 16)}  ` +
        `${r.household_label ?? "（房子已删）"}  ${maskPhone(r.inbound_from)}`
    );
    console.log(`     住户：${r.inbound_text.slice(0, 60)}`);
    if (r.shadow_error) {
      console.log(`     错误：${r.shadow_error.slice(0, 80)}`);
    } else {
      console.log(`     影子：${(r.shadow_reply ?? "").slice(0, 60)}`);
    }
    console.log();
  }
  console.log("看详情：pnpm coliving-shadow -- --show <id 前8位就行>");
}

async function findOne(idPrefix: string): Promise<ShadowRow | null> {
  const rows = await sql<ShadowRow[]>`
    select * from coliving.shadow_run
    where id::text like ${idPrefix + "%"}
    limit 2`;
  if (rows.length === 0) {
    console.error(`找不到 id 以 ${idPrefix} 开头的记录`);
    return null;
  }
  if (rows.length > 1) {
    console.error(`${idPrefix} 匹配到多条，写长一点`);
    return null;
  }
  return rows[0];
}

async function show(idPrefix: string) {
  const r = await findOne(idPrefix);
  if (!r) return;

  console.log(`影子跑 ${r.id}`);
  console.log(`房子：${r.household_label ?? "（已删）"}`);
  console.log(`时间：${r.arrived_at.toISOString()}`);
  console.log(`状态：${r.review_status}${r.review_note ? `（${r.review_note}）` : ""}`);
  console.log(`\n── 住户说 ──────────────────────────────────────`);
  console.log(r.inbound_text);
  console.log(`\n── 生产版本回复（真的发出去了）────────────────`);
  console.log(r.production_reply ?? "（无）");
  console.log(`工具：${(r.production_tools ?? []).join("、") || "无"}`);

  if (r.shadow_error) {
    console.log(`\n── 候选版本 ────────────────────────────────────`);
    console.log(`跑挂了：${r.shadow_error}`);
  } else {
    console.log(`\n── 候选版本回复（一个字都没发出去）────────────`);
    console.log(r.shadow_reply ?? "（无）");
    console.log(`工具：${(r.shadow_tools ?? []).join("、") || "无"}`);
    const outbound = (r.shadow_outbound ?? []) as Array<{
      text: string;
      blocked: boolean;
    }>;
    if (outbound.length > 0) {
      console.log(`\n候选版本还想主动发给别人（同样没发）：`);
      for (const o of outbound) {
        console.log(`  ${o.blocked ? "[审稿拦下]" : "[会发出]"} ${o.text}`);
      }
    }
  }

  const snap = r.snapshot as { tables?: Record<string, unknown[]> } | null;
  if (snap?.tables) {
    const counts = Object.entries(snap.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([t, rows]) => `${t}:${rows.length}`)
      .join(" ");
    console.log(`\n快照内容：${counts}`);
  }
  console.log(`\n值得进语料：pnpm coliving-shadow -- --export ${r.id.slice(0, 8)} --name <场景名>`);
  console.log(`没价值：    pnpm coliving-shadow -- --reject ${r.id.slice(0, 8)} --note "理由"`);
}

async function exportOne(idPrefix: string, name: string) {
  const r = await findOne(idPrefix);
  if (!r) return;
  if (!r.snapshot) {
    console.error("这条没有快照（多半是影子跑挂在抓快照之前），导不出来");
    return;
  }

  const snapDir = path.join(process.cwd(), "lib/chat/coliving/evals/snapshots");
  const scenarioDir = path.join(process.cwd(), "lib/chat/coliving/evals/scenarios");
  mkdirSync(snapDir, { recursive: true });

  const snapFile = path.join(snapDir, `${name}.json`);
  writeFileSync(snapFile, JSON.stringify(r.snapshot, null, 2), "utf8");

  // 场景引用快照，只重放"这一条消息"——这正是快照重放相对
  // "从零演一遍"的价值：没有中间轮次，不会分叉
  const snap = r.snapshot as { phoneMap: Record<string, string> };
  const slot = snap.phoneMap[r.inbound_from];
  if (!slot) {
    console.error(
      `快照的 phoneMap 里没有 ${maskPhone(r.inbound_from)}，` +
        "场景没法引用（这条快照可能被 asOf 截掉了联系方式）"
    );
    return;
  }

  const scenario = {
    id: name,
    source:
      `影子跑自动沉淀的真实流量（${r.arrived_at.toISOString().slice(0, 10)}）。` +
      `快照冻的是这条消息进来之前的完整世界状态，只重放这一条消息，` +
      `问"新版本会怎么处理这一步"。生产版本当时的回复：${r.production_reply ?? "（无）"}` +
      `\n【导出时请把这句换成：这条为什么值得进语料、要防的是哪种回归】`,
    snapshot: name,
    turns: [{ from: slot, text: r.inbound_text }],
    expect: {
      // 留空让人按这条对话真正要防的东西填——自动生成的断言多半是错的
    },
  };
  const scenarioFile = path.join(scenarioDir, `${name}.json`);
  writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), "utf8");

  await sql`
    update coliving.shadow_run
    set review_status = 'exported', review_note = ${`导出为 ${name}`}
    where id = ${r.id}`;

  console.log(`✓ 快照：${snapFile}`);
  console.log(`✓ 场景：${scenarioFile}`);
  console.log(`\n**还要你手动做两件事**：`);
  console.log(`  1. 把场景里的 source 改成"这条为什么值得进语料"`);
  console.log(`  2. 填 expect（要防的是哪种回归），空的 expect 等于只跑不判`);
  console.log(`\n然后：pnpm coliving-eval -- --scenario ${name}`);
}

async function reject(idPrefix: string, note: string) {
  const r = await findOne(idPrefix);
  if (!r) return;
  await sql`
    update coliving.shadow_run
    set review_status = 'rejected', review_note = ${note}
    where id = ${r.id}`;
  console.log(`✓ ${r.id.slice(0, 8)} 标记为不进语料：${note}`);
}

async function stats() {
  const rows = await sql<{ review_status: string; n: string }[]>`
    select review_status, count(*) as n
    from coliving.shadow_run group by review_status order by review_status`;
  const errs = await sql<{ n: string }[]>`
    select count(*) as n from coliving.shadow_run where shadow_error is not null`;
  console.log("影子跑累计：");
  for (const r of rows) console.log(`  ${r.review_status.padEnd(10)} ${r.n}`);
  console.log(`  其中跑挂了   ${errs[0].n}`);
}

async function main() {
  const show_ = argValue("show");
  const export_ = argValue("export");
  const reject_ = argValue("reject");

  if (hasFlag("stats")) await stats();
  else if (show_) await show(show_);
  else if (export_) {
    const name = argValue("name");
    if (!name) {
      console.error("--export 要配 --name <场景名>（会用作文件名，建议 YYYY-MM-DD-简述）");
      process.exit(1);
    }
    await exportOne(export_, name);
  } else if (reject_) {
    await reject(reject_, argValue("note") ?? "（没写理由）");
  } else await queue();

  await sql.end();
}

main().catch((e) => {
  console.error("失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
