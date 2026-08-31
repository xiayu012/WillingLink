/**
 * 合租房世界模型的建表 / 体检 / 播种。
 *
 *   pnpm coliving:db --status   看 coliving schema 现在有什么
 *   pnpm coliving:db --apply    执行 migrations/manual/coliving-world.sql（幂等）
 *   pnpm coliving:db --seed     用 COLIVING_ROSTER 建出第一个 Household
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

async function apply() {
  const path = join(
    process.cwd(),
    "lib/db/migrations/manual/coliving-world.sql"
  );
  const text = readFileSync(path, "utf8");
  console.log(`执行 ${path}（${text.length} 字符）…`);
  // simple 协议才能一次跑多条语句
  await sql.unsafe(text).simple();
  console.log("✓ 建表完成");
}

type RosterEntry = { phone: string; name: string; role: string; note?: string };

/**
 * 用 COLIVING_ROSTER 建出第一个真实 Household。
 *
 * 幂等：按手机号找人，找不到才建；household 按 label 找。
 * 这是「从环境变量名册」过渡到「数据库世界模型」的那一步，
 * 跑完之后 roster.ts 就不再是唯一事实来源。
 */
async function seed() {
  const raw = process.env.COLIVING_ROSTER?.trim();
  if (!raw) {
    console.log("✗ 没有 COLIVING_ROSTER，无从播种");
    return;
  }
  const roster = JSON.parse(raw) as RosterEntry[];
  const label = process.env.COLIVING_HOUSE_LABEL?.trim() || "第一栋房子";

  await sql.begin(async (tx) => {
    // ── 地点与房子 ──
    let [place] = await tx<{ id: string }[]>`
      select id from coliving.place where label = ${label} limit 1
    `;
    if (!place) {
      [place] = await tx<{ id: string }[]>`
        insert into coliving.place (kind, label, city, region, country)
        values ('dwelling', ${label},
                ${process.env.COLIVING_HOUSE_CITY ?? null},
                ${process.env.COLIVING_HOUSE_REGION ?? "CA"}, 'US')
        returning id
      `;
      console.log(`  + place ${label}`);
    }

    let [dwelling] = await tx<{ id: string }[]>`
      select id from coliving.dwelling where place_id = ${place.id} limit 1
    `;
    if (!dwelling) {
      [dwelling] = await tx<{ id: string }[]>`
        insert into coliving.dwelling (place_id, label) values (${place.id}, ${label})
        returning id
      `;
      console.log(`  + dwelling ${label}`);
    }

    let [household] = await tx<{ id: string }[]>`
      select id from coliving.household where dwelling_id = ${dwelling.id} limit 1
    `;
    if (!household) {
      [household] = await tx<{ id: string }[]>`
        insert into coliving.household (dwelling_id, label) values (${dwelling.id}, ${label})
        returning id
      `;
      await tx`
        insert into coliving.household_epoch (household_id, seq, label, started_at)
        values (${household.id}, 1, '初始成员', now())
      `;
      console.log(`  + household ${label}（epoch 1）`);
    }

    // ── 人与成员关系 ──
    for (const entry of roster) {
      const role = entry.role === "manager" ? "landlord" : entry.role;
      const phone = entry.phone.trim();

      let [contact] = await tx<{ person_id: string }[]>`
        select person_id from coliving.person_contact
        where kind = 'sms' and value = ${phone} limit 1
      `;
      let personId: string;
      if (contact) {
        personId = contact.person_id;
      } else {
        const [p] = await tx<{ id: string }[]>`
          insert into coliving.person (display_name, note)
          values (${entry.name}, ${entry.note ?? null})
          returning id
        `;
        personId = p.id;
        await tx`
          insert into coliving.person_contact (person_id, kind, value, is_primary)
          values (${personId}, 'sms', ${phone}, true)
        `;
        console.log(`  + person ${entry.name}`);
      }

      const [existing] = await tx<{ id: string }[]>`
        select id from coliving.membership
        where household_id = ${household.id} and person_id = ${personId}
          and valid_to is null
        limit 1
      `;
      if (!existing) {
        await tx`
          insert into coliving.membership (household_id, person_id, role, resides, note)
          values (${household.id}, ${personId}, ${role},
                  ${role === "tenant"}, ${entry.note ?? null})
        `;
        console.log(`  + membership ${entry.name} → ${role}`);
      }

      // 名册里的 note 是入住时问出来的作息偏好，属于长期记忆
      if (entry.note) {
        const [mem] = await tx<{ id: string }[]>`
          select id from coliving.memory
          where person_id = ${personId} and kind = 'schedule' and valid_to is null
          limit 1
        `;
        if (!mem) {
          await tx`
            insert into coliving.memory (household_id, person_id, kind, content, confidence)
            values (${household.id}, ${personId}, 'schedule', ${entry.note}, 0.9)
          `;
        }
      }
    }
  });

  console.log("✓ 播种完成");
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

async function main() {
  if (has("--apply")) {
    await apply();
  }
  if (has("--wipe")) {
    await wipe();
  }
  if (has("--seed")) {
    await seed();
  }
  if (has("--status") || args.length === 0) {
    await status();
  }
  await sql.end();
}

main().catch(async (e) => {
  console.error("失败：", e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
