/**
 * 把治理资料/判例灌进 Knowledge 域，供 findSimilarCases 一并检索。
 *
 *   pnpm coliving:ingest <文件或目录> [--kind reference] [--jurisdiction CA]
 *   pnpm coliving:ingest --list
 *
 * **只放证据，不放规则。** 行为准则留在各大脑自己的 doctrine 目录里——
 * 规则越多越互相抵消（见 AGENT_LOG 的「按周轮换」事故），
 * 而"这类事真实世界里怎么收场的"是知识，多多益善。
 *
 * 支持 .md / .txt。分块按段落聚合到约 1200 字符，段落边界不切断。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local" });

const sql = postgres(process.env.POSTGRES_URL as string, { max: 1 });

const CHUNK_TARGET = 1200;

/** 按空行切段，再聚合到目标大小——不在句子中间切断 */
function chunk(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length > CHUNK_TARGET) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) {
    out.push(buf);
  }
  return out;
}

function collect(path: string): string[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .map((f) => join(path, f))
      .filter((f) => statSync(f).isFile() && [".md", ".txt"].includes(extname(f)))
      .sort();
  }
  return [path];
}

async function list() {
  const docs = await sql`
    select d.title, d.kind, d.jurisdiction, count(c.id)::int as chunks
    from coliving.knowledge_doc d
    left join coliving.knowledge_chunk c on c.doc_id = d.id
    group by d.id order by d.created_at
  `;
  if (docs.length === 0) {
    console.log("知识库是空的。");
    return;
  }
  for (const d of docs) {
    console.log(
      `  ${String(d.title).padEnd(40)} ${d.kind} ${d.jurisdiction ?? ""} · ${d.chunks} 块`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list") || args.length === 0) {
    await list();
    await sql.end();
    return;
  }

  const argOf = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.log("要给一个文件或目录路径");
    await sql.end();
    return;
  }
  const kind = argOf("--kind") ?? "reference";
  const jurisdiction = argOf("--jurisdiction") ?? null;

  const { embedBatch } = await import("../lib/chat/coliving/embedding");
  const files = collect(target);
  console.log(`准备灌入 ${files.length} 个文件…`);

  for (const file of files) {
    const body = readFileSync(file, "utf8");
    const title = basename(file, extname(file));

    const [existing] = await sql<{ id: string }[]>`
      select id from coliving.knowledge_doc where title = ${title} limit 1
    `;
    if (existing) {
      console.log(`  跳过（已有）${title}`);
      continue;
    }

    const pieces = chunk(body);
    if (pieces.length === 0) {
      continue;
    }
    const vectors = await embedBatch(pieces);

    await sql.begin(async (tx) => {
      const [doc] = await tx<{ id: string }[]>`
        insert into coliving.knowledge_doc (title, source, kind, jurisdiction, body)
        values (${title}, ${file}, ${kind}, ${jurisdiction}, ${body})
        returning id
      `;
      for (const [i, piece] of pieces.entries()) {
        await tx`
          insert into coliving.knowledge_chunk (doc_id, ord, body, embedding)
          values (${doc.id}, ${i}, ${piece},
                  ${`[${vectors[i].join(",")}]`}::vector)
        `;
      }
    });
    console.log(`  ✓ ${title} · ${pieces.length} 块`);
  }

  console.log("\n现在的知识库：");
  await list();
  await sql.end();
}

main().catch(async (e) => {
  console.log("失败：", e instanceof Error ? e.message : e);
  await sql.end();
  process.exit(1);
});
