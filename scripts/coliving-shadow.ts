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
 * **导出的快照会进 git**，里面是真人说过的话——号码在落库时已经强制脱敏成
 * 槽位号（`lib/chat/coliving/evals/snapshot.ts` 的 `toPortableSnapshot`），
 * 这个脚本导出前还会**再脱敏一遍**（幂等，见该函数注释），双保险；
 * 但姓名和消息正文是原文，导出前自己判断这份内容适不适合进仓库
 * （跟 `snapshots/README.md` 里写的是同一条要求）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  toPortableSnapshot,
  type Snapshot,
} from "../lib/chat/coliving/evals/snapshot";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const sql = postgres(process.env.POSTGRES_URL ?? "", { max: 2, idle_timeout: 20 });

type ShadowRow = {
  id: string;
  household_label: string | null;
  /** 槽位号（`+1555…`），**不是真实号码**——见 shadow.ts 落库前的脱敏 */
  inbound_from: string | null;
  inbound_text: string;
  arrived_at: Date;
  production_reply: string | null;
  production_tools: string[] | null;
  production_model: string | null;
  shadow_reply: string | null;
  shadow_tools: string[] | null;
  shadow_model: string | null;
  shadow_outbound: unknown;
  shadow_error: string | null;
  snapshot: unknown;
  review_status: string;
  review_note: string | null;
  created_at: Date;
};

/**
 * `idPrefix` 直接拼进 SQL 的 `like` 模式，两件事必须挡住：
 * 1. **路径/范围逃逸**：`%`、`_` 是 LIKE 的通配符，用户传一个 `%` 就能
 *    把"精确前缀匹配"变成"任意匹配"，`findOne` 的"多于一条就拒绝"
 *    这道保护会被绕过或者产生意料之外的匹配范围。
 * 2. `id` 是 uuid，合法前缀只可能是十六进制字符和短横线——不是这个
 *    形状的输入直接拒绝，不用等到 SQL 层面才发现不对。
 */
function assertIdPrefix(idPrefix: string): void {
  if (!/^[0-9a-fA-F-]{1,36}$/.test(idPrefix)) {
    console.error("id 前缀只能是十六进制字符和短横线（uuid 前缀），拒绝执行");
    process.exit(1);
  }
}

/**
 * `--name` 会被拼进文件路径（`snapshots/<name>.json`、`scenarios/<name>.json`）。
 * 不校验的话，`--name ../../evil` 这类输入能让 `path.join` 写到仓库以外的
 * 任意位置——这个脚本本来就是要写文件到 git 会追踪的目录，输入校验不能省。
 */
function assertSafeName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || name.includes("..")) {
    console.error(
      "--name 只能是字母数字开头，之后允许字母数字/点/下划线/短横线，" +
        "长度不超过 80，且不能包含 ..（防止路径逃逸），拒绝执行"
    );
    process.exit(1);
  }
}

/** 槽位号长这样（见 captureSnapshot 的生成规则），不是就当成可能是真实号码 */
const SLOT_PATTERN = /^\+1555\d+$/;

/**
 * 展示用：像槽位号就原样显示，不像就只显示后四位。
 *
 * 这张表理论上从这次修复起 `inbound_from` 只会存槽位号，但**这个脚本要
 * 兼容这次修复之前写入的历史行**——那些行的 `inbound_from` 是真实号码。
 * 光凭字段名分不出新旧，所以一律按"像不像槽位号"来决定要不要打码，
 * 而不是假设当前代码写的格式就是库里所有行的格式。
 */
function displaySlotOrMasked(value: string | null): string {
  if (!value) return "（未知发信人）";
  return SLOT_PATTERN.test(value) ? value : `***${value.slice(-4)}`;
}

/**
 * 从一行 shadow_run 记录里解析出发信人对应的**槽位号**，兼容两种格式：
 *
 * - **新版**（这次修复之后写入的）：`inbound_from` 落库时就已经是槽位号，
 *   `snapshot.phoneMap` 是"槽位号 → 自身"的恒等映射（见
 *   `toPortableSnapshot`）。
 * - **旧版**（这次修复之前写入的历史数据）：`inbound_from` 是**真实手机号**，
 *   `snapshot.phoneMap` 是"真实号码 → 槽位号"。
 *
 * 这个函数**只在内存里查一次表**，返回值只可能是槽位号，绝不是真实号码——
 * 调用方后续的打印/落盘只准用这个函数的返回值，不能再碰
 * `row.inbound_from` 这个原始字段。解析不出来就返回 `null`，
 * 调用方必须拒绝导出，不能猜、不能把原始字段直接当槽位号用。
 */
function resolveInboundSlot(row: ShadowRow): string | null {
  const inbound = row.inbound_from;
  if (!inbound) return null;
  const phoneMap = (row.snapshot as { phoneMap?: Record<string, string> } | null)
    ?.phoneMap;
  if (!phoneMap) return null;

  // 新版：inbound_from 本身就是槽位号，phoneMap 是恒等映射
  if (phoneMap[inbound] === inbound) return inbound;

  // 旧版：inbound_from 是真实号码，phoneMap 是 真实号码 → 槽位号
  const mapped = phoneMap[inbound];
  if (mapped) return mapped;

  // inbound_from 本身可能已经是槽位号，只是因为 asOf 截断等原因没有
  // 出现在 phoneMap 的 key 位置——退一步看它是不是出现在 value 位置
  // （槽位号只会出现在 value 里，不管新旧格式）
  if (Object.values(phoneMap).includes(inbound)) return inbound;

  return null;
}

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
        `${r.household_label ?? "（房子已删）"}  ${displaySlotOrMasked(r.inbound_from)}`
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
  assertIdPrefix(idPrefix);
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
  console.log(`模型：${r.production_model ?? "（未记录，老数据）"}`);

  if (r.shadow_error) {
    console.log(`\n── 候选版本 ────────────────────────────────────`);
    console.log(`跑挂了：${r.shadow_error}`);
  } else {
    console.log(`\n── 候选版本回复（一个字都没发出去）────────────`);
    console.log(r.shadow_reply ?? "（无）");
    console.log(`工具：${(r.shadow_tools ?? []).join("、") || "无"}`);
    console.log(
      `模型：${r.shadow_model ?? "（未记录，老数据）"}` +
        (r.shadow_model && r.production_model && r.shadow_model !== r.production_model
          ? "  ← 跟生产版本不同，这是真正的模型 A/B"
          : "  ← 跟生产版本相同，这次没有模型层面的差异")
    );
    const outbound = (r.shadow_outbound ?? []) as Array<{
      text: string;
      blocked: boolean;
      blockReason?: string | null;
    }>;
    if (outbound.length > 0) {
      console.log(`\n候选版本还想主动发给别人（同样没发）：`);
      for (const o of outbound) {
        console.log(`  ${o.blocked ? "[审稿拦下]" : "[会发出]"} ${o.text}`);
        if (o.blocked && o.blockReason) {
          console.log(`    拦下原因：${o.blockReason}`);
        }
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

/**
 * 导出成 eval 场景。**先把所有能验证的都验证完，一个字都别落盘，
 * 再一次性写两个文件**，而且写文件这一步本身也不准覆盖、不能删除
 * 既有文件：
 *
 * 1. **目标文件已存在就直接拒绝，什么都不做**——这个脚本的产出是进 git
 *    的语料，同名文件多半是用户已经导出、可能已经手改过的东西
 *    （`show()` 提示的下一步就是"把 source 改成……"），`writeFileSync`
 *    默认会**静默覆盖**，等于把人已经编辑过的语料冲掉。
 * 2. **失败清理只删"这次运行自己创建的文件"**——`createdFiles` 只在
 *    写成功之后才 push 进去，所以回滚时不可能删到本来就存在的文件
 *    （那种情况在第 1 步就已经被拒绝，根本走不到这里）。
 * 3. **用 `wx`（独占创建）而不是普通写入**，作为第 1 步 exists 检查和
 *    真正写入之间的竞态兜底——万一这段时间内文件被别的进程创建了，
 *    `wx` 会直接报错而不是覆盖，Windows/POSIX 都认这个标志。
 */
async function exportOne(idPrefix: string, name: string) {
  assertSafeName(name);
  const r = await findOne(idPrefix);
  if (!r) return;
  if (!r.snapshot) {
    console.error("这条没有快照（多半是影子跑挂在抓快照之前），导不出来");
    return;
  }

  // 兼容旧数据：这次修复之前写入的行，inbound_from 是真实号码、
  // snapshot.phoneMap 是"真实号码→槽位号"。这个函数只在内存里查一次表，
  // 返回值只可能是槽位号——下面的所有打印/落盘都只用它的返回值，
  // 绝不碰 r.inbound_from 原始字段。解析不出来就拒绝导出，不能猜。
  const slot = resolveInboundSlot(r);
  if (!slot) {
    console.error(
      "解析不出发信人对应的槽位号，拒绝导出（可能是影子跑挂在能确定发信人" +
        "之前，或者是这次修复之前写入的历史行、格式没法安全兼容）"
    );
    return;
  }

  // 落库时已经脱敏过一遍（`toPortableSnapshot` 是幂等的），这里再过一遍
  // 纯粹是双保险——万一有旧数据或别的写入路径漏了那一步，这里兜住，
  // 绝不能让带真实号码的快照写进会进 git 的文件。脱敏失败就直接拒绝导出。
  let portable: Snapshot;
  try {
    portable = toPortableSnapshot(r.snapshot as Snapshot);
  } catch (e) {
    console.error(
      `快照脱敏失败，拒绝导出（这份快照可能带着未映射的真实号码）：` +
        `${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  // 场景引用快照，只重放"这一条消息"——这正是快照重放相对
  // "从零演一遍"的价值：没有中间轮次，不会分叉。这里只需要确认解析出来
  // 的槽位号确实出现在这份（脱敏后的）快照里（防止数据不一致：比如这条
  // 快照被 asOf 截掉了联系方式）。
  if (!portable.phoneMap[slot]) {
    console.error(
      `快照里找不到解析出的槽位号对应的联系方式，` +
        "场景没法引用（这条快照可能被 asOf 截掉了联系方式）"
    );
    return;
  }

  const snapDir = path.join(process.cwd(), "lib/chat/coliving/evals/snapshots");
  const scenarioDir = path.join(process.cwd(), "lib/chat/coliving/evals/scenarios");
  mkdirSync(snapDir, { recursive: true });
  mkdirSync(scenarioDir, { recursive: true });

  const snapFile = path.join(snapDir, `${name}.json`);
  const scenarioFile = path.join(scenarioDir, `${name}.json`);

  // 目标已存在就整个拒绝——**在写任何东西之前**，两个都要查。
  // 只要有一个已经存在，就有可能是用户之前导出、手改过的语料，
  // 绝不覆盖，也就不需要走到"写坏了怎么回滚"那一步。
  const existing = [snapFile, scenarioFile].filter((f) => existsSync(f));
  if (existing.length > 0) {
    console.error(
      `以下文件已存在，拒绝覆盖（换一个 --name，或者先处理掉已有文件）：\n` +
        existing.map((f) => `  ${f}`).join("\n")
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

  // **只往 createdFiles 记"这次运行真的写成功的文件"**——回滚只删这些，
  // 绝不可能删到已存在的文件（那种情况上面已经整体拒绝，走不到这里）。
  const createdFiles: string[] = [];
  try {
    // `wx`：文件已存在就报错，不覆盖。上面的 existsSync 已经检查过一遍，
    // 这里是检查和写入之间那段时间的竞态兜底，双保险不吃亏。
    writeFileSync(snapFile, JSON.stringify(portable, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    createdFiles.push(snapFile);

    writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    createdFiles.push(scenarioFile);
  } catch (e) {
    for (const f of createdFiles) {
      try {
        unlinkSync(f);
      } catch {
        // 清理失败也不掩盖原始错误，往下继续抛
      }
    }
    throw e;
  }

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
