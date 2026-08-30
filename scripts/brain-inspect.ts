/**
 * 大脑组装与路由的检查工具。
 *
 *   pnpm brain:inspect "楼上那个人天天半夜两三点还在弄出声音"
 *   pnpm brain:inspect --full "房租可能要晚几天"     # 打印完整 system prompt
 *   pnpm brain:inspect --probes                      # 跑一遍路由探针
 *
 * 用来验证：这一轮命中了哪些情境模块、为什么命中、上下文多大。
 */

import { assembleSystemPrompt, getBrain, listBrains } from "../lib/ai/brains";

const BRAIN_ID = "coliving";

const PROBES: Array<{
  text: string;
  expect: string[];
  /** 断言不走「简单事实询问」的独占短路 */
  forbidExclusive?: boolean;
}> = [
  {
    text: "楼上那个人天天半夜两三点还在弄出声音，我第二天六点就要起来上班",
    expect: ["conflict"],
  },
  { text: "这个月工时被砍了，房租可能要晚几天", expect: ["money"] },
  {
    text: "新搬来那个人天天做饭，整个屋子都是那个味，我们几个都受不了",
    expect: ["conflict"],
  },
  { text: "3号房那个欠了两个月了，明天把他门锁换了", expect: ["records"] },
  { text: "厨房水槽下面在漏水，越来越大了", expect: ["records"] },
  { text: "我最近老想干脆一了百了", expect: ["complaint-risk"] },
  { text: "他上次还说要收拾我，我看他厨房那把刀", expect: ["complaint-risk"] },
  { text: "垃圾是周几倒？", expect: ["tenancy"] },
  { text: "安静时段是几点到几点？", expect: ["tenancy"] },
  // 短问句但涉及具体某人：不该走独占短路（隐私/冲突信号，常驻层的不披露规则要生效）
  { text: "他昨天半夜几点回来的？", expect: [], forbidExclusive: true },
  { text: "你到底是房东那边的还是我们租客这边的？", expect: [] },
];

function inspect(text: string, full: boolean) {
  const result = assembleSystemPrompt({ brainId: BRAIN_ID, routeOn: text });

  console.log(`\n输入：${text}`);
  console.log(`加载：${result.loadedModuleIds.join(", ") || "（无）"}`);
  for (const t of result.routing.trace) {
    console.log(`  · ${t.moduleId}${t.forced ? " [强制]" : ""} — ${t.reason}`);
  }
  console.log(`上下文：${result.chars} 字符`);

  if (full) {
    console.log("\n──────── system prompt ────────\n");
    console.log(result.system);
  }
}

function runProbes() {
  const brain = getBrain(BRAIN_ID);
  console.log(`大脑：${brain.title}（${brain.id}）`);
  console.log(
    `常驻 1 份 + 情境 ${brain.situational.length} 份，单轮上限 ${brain.maxSituational ?? 2} 份\n`
  );

  let pass = 0;
  for (const probe of PROBES) {
    const { loadedModuleIds, chars, routing } = assembleSystemPrompt({
      brainId: BRAIN_ID,
      routeOn: probe.text,
    });
    const wentExclusive = routing.trace.some((t) => t.reason.includes("独占"));
    const ok =
      probe.expect.every((id) => loadedModuleIds.includes(id)) &&
      !(probe.forbidExclusive && wentExclusive);
    if (ok) {
      pass++;
    }
    const mark = ok ? "✓" : "✗";
    const want = probe.forbidExclusive
      ? "（不得短路）"
      : probe.expect.length
        ? probe.expect.join("+")
        : "（任意）";
    console.log(
      `${mark} ${want.padEnd(16)} 实得 ${loadedModuleIds.join("+").padEnd(28)} ${chars} 字符  ${probe.text.slice(0, 24)}`
    );
  }
  console.log(`\n${pass}/${PROBES.length} 通过`);
}

const args = process.argv.slice(2);

if (args.includes("--brains")) {
  for (const b of listBrains()) {
    console.log(`${b.id}\t${b.title}\t${b.description}`);
  }
} else if (args.includes("--probes") || args.length === 0) {
  runProbes();
} else {
  const full = args.includes("--full");
  const text = args.filter((a) => !a.startsWith("--")).join(" ");
  inspect(text, full);
}
