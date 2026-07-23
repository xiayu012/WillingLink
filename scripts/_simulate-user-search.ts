/**
 * 临时验证脚本：以 20 种措辞/角度模拟用户搜索，检验 embedding 修复效果。
 * 每条查询用独立 chatId（互不去重），打印命中房源与松弛提示。
 *
 * 运行：NODE_OPTIONS="--conditions=react-server" npx tsx scripts/_simulate-user-search.ts
 */
import { config } from "dotenv";
config({ path: "/workspaces/willinglink/.env.local" });
for (const k of ["POSTGRES_URL", "VOYAGE_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]!.slice(1, -1);
  }
}

import { randomUUID } from "node:crypto";

const QUERIES: Array<{ label: string; query: string; mustNotContain?: string[] }> = [
  { label: "① 城市变体字", query: "圣荷塞找个主卧，独立卫生间" },
  { label: "② 整租+预算", query: "圣何塞两室一厅整租，预算3000以内" },
  { label: "③ 纯英文", query: "studio or 1b1b in San Jose near downtown" },
  { label: "④ 三番市+养猫", query: "三番市一室一厅，可以养猫" },
  { label: "⑤ 合租+性别", query: "旧金山合租单间，限女生" },
  { label: "⑥ 通勤导向", query: "南湾找单间，去Google上班通勤方便" },
  { label: "⑦ 苗必达+包水电", query: "苗必达有没有包水电的房间" },
  { label: "⑧ 英文主卧独卫", query: "Milpitas master bedroom with private bathroom" },
  { label: "⑨ 菲利蒙变体", query: "菲利蒙好学区两室出租" },
  { label: "⑩ 近BART短租", query: "Fremont 近BART站 单间短租" },
  { label: "⑪ 情侣入住", query: "情侣可住的主卧独卫，预算2000左右", mustNotContain: ["仅限一人", "限一人", "单人", "one person only"] },
  { label: "⑫ 宠物+院子", query: "宠物友好带院子的房子" },
  { label: "⑬ 入住日期", query: "8月1日入住，圣克拉拉附近单间" },
  { label: "⑭ 学生口吻", query: "马上要去SJSU读书了，想找学校附近1200左右的房间" },
  { label: "⑮ 双城市或", query: "Sunnyvale或Mountain View的1b1b整租" },
  { label: "⑯ 斯坦福附近", query: "帕洛阿尔托斯坦福附近租房" },
  { label: "⑰ 海沃德低价", query: "海沃德便宜单间，越便宜越好" },
  { label: "⑱ 东湾通勤SF", query: "住东湾、通勤去旧金山方便的转租" },
  { label: "⑲ 车位需求", query: "newark或union city带车位的联排" },
  { label: "⑳ 拎包入住", query: "圣塔克拉拉家具齐全拎包入住" },
];

async function main() {
  const { createSearchRentalTool } = await import(
    "@/lib/ai/tools/search-rental"
  );

  let hit = 0;
  let relaxed = 0;
  let miss = 0;

  for (const q of QUERIES) {
    const tool = createSearchRentalTool(randomUUID());
    const started = Date.now();
    const r: any = await (tool as any).execute(
      { query: q.query, mustNotContain: q.mustNotContain },
      {} as any
    );
    const ms = Date.now() - started;
    console.log(`\n═══ ${q.label} 「${q.query}」 (${ms}ms)`);
    if (!r.listing) {
      miss++;
      console.log(`   ✗ 无结果: ${String(r.action).slice(0, 60)}`);
      continue;
    }
    const l = r.listing;
    if (r.relaxedNote) {
      relaxed++;
      console.log(`   ~ 松弛: ${r.relaxedNote}`);
    } else {
      hit++;
    }
    console.log(
      `   → ${l.title ?? "(无标题)"} | 城市:${l.city ?? "?"} | 租金:${l.rent ?? "?"} | 房型:${l.roomType ?? "?"} | 位置:${(l.locationText ?? "").slice(0, 30)}`
    );
  }

  console.log(`\n══════ 汇总: 精确命中 ${hit} / 松弛 ${relaxed} / 无结果 ${miss} (共${QUERIES.length}) ══════`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
