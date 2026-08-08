import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(
  new URL("../userscript/xhs-guide.user.js", import.meta.url)
);
const source = await readFile(scriptPath, "utf8");
const expectEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message}; expected=${expected}; actual=${actual}`);
  }
};
const startIndex = source.indexOf("  const DEFAULT_CONFIG");
const endIndex = source.indexOf("  const state =");
const ruleStartIndex = source.indexOf("  const ruleScreenStage");
const ruleEndIndex = source.indexOf("\n  // ---- 互联网 4o-mini", ruleStartIndex);
if (
  startIndex < 0 ||
  endIndex < startIndex ||
  ruleStartIndex < 0 ||
  ruleEndIndex < ruleStartIndex
) {
  throw new Error("无法从 userscript 提取地理分类器");
}

const context = {};
vm.createContext(context);
const initializationStartedAt = performance.now();
vm.runInContext(
  `${source.slice(startIndex, endIndex)}
  ${source.slice(ruleStartIndex, ruleEndIndex)}
  globalThis.classifyTitleGeography = classifyTitleGeography;
  globalThis.ruleScreenStage = ruleScreenStage;
  globalThis.config = DEFAULT_CONFIG;`,
  context
);
const initializationMs = performance.now() - initializationStartedAt;

const geographyCases = [
  ["San Jose 95128南灣出租", "bay"],
  ["加州伯克利求租1b1b（8月中旬起）", "bay"],
  ["南湾 95051 找室友", "bay"],
  ["Santa Clara University对面apt客厅出租", "bay"],
  ["7.30-8.8转租PALO ALTO公寓", "bay"],
  ["湾区转租", "bay"],
  ["灣區轉租", "bay"],
  ["南灣兩房一廳出租", "bay"],
  ["95128 1b1b出租", "bay"],
  ["92101 1b1b出租", "outside"],
  ["UCSD租房求推荐", "outside"],
  ["洛杉矶Monterey Park山顶房出租", "outside"],
  ["Seattle 1b1b sublease", "outside"],
  ["Boston求租", "outside"],
  ["Toronto downtown condo出租", "outside"],
  ["San Diego转租", "outside"],
  ["Sacramento找室友", "outside"],
  ["Irvine公寓出租", "outside"],
  ["jsq2 1b1b 转租", "unknown"],
  ["男生租房", "unknown"],
  ["California 1b1b出租", "unknown"],
];
const coreBayPlaces = [
  "San Francisco",
  "San Mateo",
  "Santa Clara",
  "San Jose",
  "Oakland",
  "Fremont",
  "Milpitas",
  "Cupertino",
  "Mountain View",
  "Sunnyvale",
  "Palo Alto",
  "Redwood City",
  "Foster City",
  "Daly City",
  "San Bruno",
  "Millbrae",
  "Burlingame",
  "Berkeley",
  "Hayward",
  "Alameda",
  "Union City",
  "Newark",
  "San Leandro",
  "Pleasanton",
  "Dublin",
  "Livermore",
  "Walnut Creek",
  "Concord",
  "Emeryville",
  "Richmond",
  "Morgan Hill",
  "Gilroy",
  "San Ramon",
  "Danville",
];
for (const place of coreBayPlaces) {
  geographyCases.push([`${place} 1b1b出租`, "bay"]);
}
const outsidePlaces = [
  "North Bay",
  "San Rafael",
  "Napa",
  "Santa Rosa",
  "Sacramento",
  "Davis",
  "Los Angeles",
  "Irvine",
  "San Diego",
  "Seattle",
  "Bellevue",
  "Portland",
  "Austin",
  "Dallas",
  "Chicago",
  "New York",
  "Boston",
  "Toronto",
  "Vancouver",
];
for (const place of outsidePlaces) {
  geographyCases.push([`${place} 1b1b出租`, "outside"]);
}

const startedAt = performance.now();
for (const [title, expectedScope] of geographyCases) {
  const result = context.classifyTitleGeography(title);
  expectEqual(
    result.scope,
    expectedScope,
    `${title}: ${JSON.stringify(result)}`
  );
}
const classificationMs = performance.now() - startedAt;

const ruleCases = [
  ["San Jose 95128南灣出租", false],
  ["湾区租房避雷", false],
  ["Cupertino 华人拼邮｜合箱巨省", true],
  ["湾区的 Robotics Startup 分两派", true],
  ["北美女博｜relocate到湾区啦", true],
  ["UCSD租房求推荐", true],
  ["男生租房", true],
  ["新上市房源", true],
];
for (const [title, expectedSkipLlm] of ruleCases) {
  const result = context.ruleScreenStage({ titleText: title }, context.config);
  expectEqual(
    result.skipLlm,
    expectedSkipLlm,
    `${title}: ${JSON.stringify(result)}`
  );
}

process.stdout.write(
  `${JSON.stringify({
    cases: geographyCases.length + ruleCases.length,
    initializationMs: Math.round(initializationMs * 100) / 100,
    averageClassificationUs:
      Math.round((classificationMs * 1000 * 100) / geographyCases.length) / 100,
  })}\n`
);
