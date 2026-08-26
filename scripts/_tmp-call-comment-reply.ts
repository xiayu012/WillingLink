import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) {
    process.env[m[1]] ??= m[2].replace(/^"|"$/g, "");
  }
}

const TOKEN = process.env.XHS_API_TOKEN as string;
const BASE = "https://willinglink.vercel.app";

type Row = { id: string; sourceUrl: string; rawText: string; createdAt: string };

async function main() {
  const rows: Row[] = JSON.parse(
    readFileSync(
      "C:/Users/78/AppData/Local/Temp/claude/d--WillingLink/9455cafb-e7f5-441c-99bd-b5759319c13e/scratchpad/wanted.json",
      "utf8"
    )
  );

  const results: any[] = [];

  for (const [i, row] of rows.entries()) {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${BASE}/api/xhs/comment-reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Xhs-Token": TOKEN,
        },
        body: JSON.stringify({ rawText: row.rawText, sourceUrl: row.sourceUrl }),
      });
      const json = await res.json();
      results.push({ index: i + 1, id: row.id, rawText: row.rawText, httpStatus: res.status, ...json });
      console.log(`[${i + 1}/${rows.length}] ${row.id} status=${res.status} ok=${json.ok} skipped=${json.skipped} kind=${json.postKind} chars=${json.chars} elapsed=${Date.now() - startedAt}ms`);
    } catch (err) {
      results.push({ index: i + 1, id: row.id, rawText: row.rawText, error: String(err) });
      console.log(`[${i + 1}/${rows.length}] ${row.id} FAILED: ${err}`);
    }
    writeFileSync(
      "C:/Users/78/AppData/Local/Temp/claude/d--WillingLink/9455cafb-e7f5-441c-99bd-b5759319c13e/scratchpad/results.json",
      JSON.stringify(results, null, 2)
    );
  }

  console.log("DONE");
}

main();
