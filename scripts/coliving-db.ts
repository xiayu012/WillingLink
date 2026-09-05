/**
 * 合租房世界模型的建表 / 体检 / 播种。
 *
 *   pnpm coliving:db --status   看 coliving schema 现在有什么
 *   pnpm coliving:db --apply    执行 migrations/manual/coliving-world.sql（幂等）
 *   pnpm coliving:db --purge            彻底清空（知识库保留）
 *   pnpm coliving:watch                 监听本地 csv，房东号码入库（另一个脚本）
 *
 * 为什么不走 drizzle-kit：与 ChannelIdentity 同样的理由——
 * 手写 SQL 一次性建表，不进 drizzle journal，drizzle-kit 也不扫 coliving schema，
 * 这样 public 下租房搜索那 17 张表完全不受影响。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local" });

const url = process.env.POSTGRES_URL;
if (!url) {
  console.log("✗ .env.local 里没有 POSTGRES_URL");
  process.exit(1);
}

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);

const sql = postgres(url, { max: 1 });

async function status() {
  const tables = await sql<{ table_name: string; n: number }[]>`
    select c.relname as table_name, c.reltuples::bigint as n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'coliving' and c.relkind = 'r'
    order by c.relname
  `;
  if (tables.length === 0) {
    console.log("coliving schema 还不存在或没有表。先跑 --apply");
    return;
  }
  console.log(`coliving schema：${tables.length} 张表`);
  for (const t of tables) {
    const [{ n }] = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from coliving.${t.table_name}`
    );
    console.log(`  ${t.table_name.padEnd(20)} ${n} 行`);
  }

  const ext = await sql<{ extname: string }[]>`
    select extname from pg_extension
    where extname in ('postgis','vector','pg_trgm') order by extname
  `;
  console.log("扩展：", ext.map((e) => e.extname).join(", ") || "（无）");
}

/** 按文件名顺序全部执行。每份都写成幂等的，重复跑不会出事。 */
const MIGRATIONS = [
  "coliving-world.sql",
  "coliving-world-02.sql",
  "coliving-world-03.sql",
  "coliving-world-04.sql",
  "coliving-world-05.sql",
  "coliving-world-06.sql",
  "coliving-world-07.sql",
  "coliving-world-08.sql",
  "coliving-world-09.sql",
  "coliving-world-10.sql",
  "coliving-world-11.sql",
  "coliving-world-12.sql",
  "coliving-world-13.sql",
  "coliving-world-14.sql",
];

async function apply() {
  for (const name of MIGRATIONS) {
    const path = join(process.cwd(), "lib/db/migrations/manual", name);
    const text = readFileSync(path, "utf8");
    console.log(`执行 ${name}（${text.length} 字符）…`);
    // simple 协议才能一次跑多条语句
    await sql.unsafe(text).simple();
  }
  console.log("✓ 建表完成");
}

/**
 * **彻底清空**：人、房子、成员关系、所有事件与消息，一个不留。
 * 保留 knowledge_doc / knowledge_chunk —— 那是治理资料语料，跟身份无关，
 * 重新灌一次要花钱。
 */
async function purge() {
  await sql.unsafe(`
    truncate
      coliving.outcome, coliving.communication, coliving.message,
      coliving.conversation, coliving.decision, coliving.event,
      coliving.case_file, coliving.obligation, coliving.rule,
      coliving.memory, coliving.observation, coliving.outreach_run,
      coliving.membership, coliving.household_epoch, coliving.household,
      coliving.room, coliving.dwelling, coliving.place,
      coliving.person_contact, coliving.person
    cascade
  `);
  console.log("✓ 已彻底清空（知识库保留）");
}

/**
 * 清掉运行时产生的记录，保留人/房子/成员关系。
 * 用于模拟器跑脏了之后重来——**不碰 person / household / membership**，
 * 那些是真实世界的事实，重新播种代价高。
 */
async function wipe() {
  await sql.begin(async (tx) => {
    await tx`delete from coliving.outcome`;
    await tx`delete from coliving.communication`;
    await tx`delete from coliving.message`;
    await tx`delete from coliving.conversation`;
    await tx`delete from coliving.decision`;
    await tx`delete from coliving.event`;
    await tx`delete from coliving.case_file`;
    await tx`delete from coliving.obligation`;
    await tx`delete from coliving.rule`;
    await tx`delete from coliving.memory where kind <> 'schedule'`;
  });
  console.log("✓ 已清空事件/判断/沟通/规则，人与房子保留");
}

function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

/**
 * 换人。**不覆盖历史**：搬出是给 membership 填 valid_to，搬入是插新行，
 * 两者都会滚一个新的 household_epoch，用来分辨
 * 「这栋房子长期如此」还是「某一批人凑在一起才出问题」。
 */
async function membership() {
  const repo = await import("../lib/chat/coliving/repo");
  const [house] = await repo.listHouseholds();
  if (!house) {
    console.log("✗ 库里没有 household");
    return;
  }

  const out = argOf("--move-out");
  if (out) {
    const m = await repo.findPersonByName(house.id, out);
    if (!m) {
      console.log(`✗ ${house.label} 里没有「${out}」`);
      return;
    }
    await repo.moveOut({
      householdId: house.id,
      personId: m.personId,
      reason: argOf("--reason") ?? null,
    });
    console.log(`✓ ${m.name} 已搬出（历史保留，开了新 epoch）`);
  }

  const inName = argOf("--move-in");
  if (inName) {
    const phone = argOf("--phone");
    if (!phone) {
      console.log("✗ --move-in 需要配 --phone");
      return;
    }
    await repo.moveIn({
      householdId: house.id,
      name: inName,
      phone,
      role: (argOf("--role") as "tenant" | "landlord") ?? "tenant",
      resides: !args.includes("--not-resident"),
      note: argOf("--note") ?? null,
    });
    console.log(`✓ ${inName} 已搬入（onboarded_at 已设，头两周会主动接触）`);
  }

  // 给某个人在某个渠道登记地址：同一个人可以有手机号 + 企业微信 UserID，
  // person 只有一个 —— 身份不因换渠道而改变。
  const contactFor = argOf("--contact");
  if (contactFor) {
    const kind = argOf("--kind") ?? "wecom";
    const value = argOf("--value");
    if (!value) {
      console.log("✗ --contact 需要配 --value（该渠道里的地址）");
      return;
    }
    const m = await repo.findPersonByName(house.id, contactFor);
    if (!m) {
      console.log(`✗ ${house.label} 里没有「${contactFor}」`);
      return;
    }
    await repo.addContact({ personId: m.personId, kind, value });
    console.log(`✓ ${m.name} 的 ${kind} 地址已登记`);
  }

  // 「住不住在这里」是可以随时改的事实，不是角色的推论
  const resides = argOf("--set-resides");
  if (resides) {
    const m = await repo.findPersonByName(house.id, resides);
    if (!m) {
      console.log(`✗ ${house.label} 里没有「${resides}」`);
      return;
    }
    const value = !args.includes("--no");
    await repo.setResides({
      householdId: house.id,
      personId: m.personId,
      resides: value,
    });
    console.log(`✓ ${m.name} ${value ? "住在" : "不住在"}这栋房子`);
  }

  const members = await repo.getMembers(house.id);
  console.log(`\n${house.label} 当前成员：`);
  for (const m of members) {
    console.log(
      `  ${m.name.padEnd(8)} ${m.role.padEnd(9)} ${m.resides ? "同住" : "不同住"}  ${m.address ?? ""}`
    );
  }
}

/** 给还没算过向量的 Case 补算，供 findSimilarCases 用 */
async function embedBackfill() {
  const repo = await import("../lib/chat/coliving/repo");
  const { embedBatch } = await import("../lib/chat/coliving/embedding");
  const pending = await repo.casesMissingEmbedding(100);
  if (pending.length === 0) {
    console.log("没有需要补算向量的 Case");
    return;
  }
  console.log(`补算 ${pending.length} 条 Case 的向量…`);
  const texts = pending.map(
    (c) => `${c.kind}｜${c.title}｜${c.resolution ?? ""}`
  );
  const vectors = await embedBatch(texts);
  for (const [i, c] of pending.entries()) {
    await repo.setCaseEmbedding(c.id, vectors[i]);
  }
  console.log(`✓ 已写入 ${pending.length} 条`);
}

async function main() {
  if (has("--apply")) {
    await apply();
  }
  if (has("--wipe")) {
    await wipe();
  }
  if (has("--move-in") || has("--move-out") || has("--set-resides") || has("--contact")) {
    await membership();
  }
  if (has("--embed")) {
    await embedBackfill();
  }
  if (has("--purge")) {
    await purge();
  }
  if (has("--test-house")) {
    const repo = await import("../lib/chat/coliving/repo");
    const { householdId } = await repo.createTestHousehold(
      argOf("--test-house") ?? "测试屋"
    );
    console.log(`✓ 测试屋已建 ${householdId}`);
    console.log("  本地脚本只能写这一种房子（见 lib/chat/coliving/guard.ts）");
    console.log("  跑对话时带上 COLIVING_LOCAL_WRITE=1");
  }
  if (
    has("--status") ||
    args.length === 0 ||
    !args.some((a) =>
      ["--apply","--wipe","--purge","--test-house","--move-in","--move-out","--set-resides","--contact","--embed"].includes(a)
    )
  ) {
    await status();
  }
  await sql.end();
}

main().catch(async (e) => {
  console.error("失败：", e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
