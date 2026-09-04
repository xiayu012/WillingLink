/**
 * 排班算法（lib/chat/coliving/scheduling.ts）的回归检查。
 *
 *   pnpm scheduling:inspect
 *
 * 起因（2026-09-04）：用户要求"多打磨、多使用"这个新工具，自己出题
 * 测了20个跨场景用例（真实原案/多人/极端时长/边界输入/性能压力），
 * 发现一个真实 bug——算法只贪心从前往后堆，从不为了偏好把人往后挪，
 * 导致窗口有富余空当时算不出本该零偏离的解（见用例5/10/12）。修法：
 * 加了一轮从后往前的松弛调整。这份脚本把当时发现问题的用例连同
 * 已知正确的用例都固定下来，**以后改动 scheduling.ts 前后都跑一遍**，
 * 防止同类回归。
 *
 * 不含真实模型调用（这是纯函数测试），几毫秒跑完，随手改随手跑。
 */

import { bestSchedulePlans, formatMinutes } from "../lib/chat/coliving/scheduling";

type TestCase = {
  id: string;
  label: string;
  windowStart: string;
  people: {
    name: string;
    durationMinutes: number;
    earliestStart?: string;
    preferredStart?: string;
  }[];
  /** 断言：排第一的候选，总偏离分钟数应该等于这个值 */
  expectTopGapMinutes: number;
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

const cases: TestCase[] = [
  {
    id: "真实原案",
    label: "厨房三人，硬约束+软偏好混合（2026-09-04 生产事故复现）",
    windowStart: "18:00",
    people: [
      { name: "2号住客", durationMinutes: 120, earliestStart: "18:00" },
      { name: "3号住客", durationMinutes: 30 },
      { name: "老孙", durationMinutes: 30, preferredStart: "19:00" },
    ],
    expectTopGapMinutes: 30,
  },
  {
    id: "窗口有富余空当",
    label: "单人硬约束长占用+另一人偏好，窗口远大于总需求",
    windowStart: "17:00",
    people: [
      { name: "老张", durationMinutes: 90, earliestStart: "17:30" },
      { name: "小刘", durationMinutes: 15, preferredStart: "18:00" },
    ],
    // 小刘只能卡在 17:00-17:30 这段空当里，最多贴到 17:15-17:30，
    // 偏离偏好(18:00) 45 分钟——这是回归测试的核心用例，
    // 曾经错误地算出 60 分钟（贪心把小刘怼在最前面）
    expectTopGapMinutes: 45,
  },
  {
    id: "六人排队多偏好",
    label: "六人合租房浴室排队，多人有偏好",
    windowStart: "06:00",
    people: [
      { name: "住户1", durationMinutes: 15, earliestStart: "06:00", preferredStart: "06:00" },
      { name: "住户2", durationMinutes: 15, preferredStart: "06:30" },
      { name: "住户3", durationMinutes: 20, earliestStart: "06:45" },
      { name: "住户4", durationMinutes: 15 },
      { name: "住户5", durationMinutes: 15, preferredStart: "07:30" },
      { name: "住户6", durationMinutes: 15, earliestStart: "07:00" },
    ],
    expectTopGapMinutes: 0,
  },
  {
    id: "偏好相同谁先谁后",
    label: "两人偏好完全相同、时长不同，窗口起点到偏好之间有空当",
    windowStart: "18:00",
    people: [
      { name: "做饭快", durationMinutes: 15, preferredStart: "18:30" },
      { name: "做饭慢", durationMinutes: 90, preferredStart: "18:30" },
    ],
    expectTopGapMinutes: 15,
  },
  {
    id: "无约束基线",
    label: "两人都无硬约束无偏好",
    windowStart: "07:00",
    people: [
      { name: "小李", durationMinutes: 20 },
      { name: "小王", durationMinutes: 20 },
    ],
    expectTopGapMinutes: 0,
  },
  {
    id: "完美解",
    label: "三人偏好天然首尾相接、互不冲突",
    windowStart: "18:00",
    people: [
      { name: "甲", durationMinutes: 30, preferredStart: "18:00" },
      { name: "乙", durationMinutes: 30, preferredStart: "18:30" },
      { name: "丙", durationMinutes: 30, preferredStart: "19:00" },
    ],
    expectTopGapMinutes: 0,
  },
  {
    id: "三人抢同一时刻",
    label: "全员偏好都是同一时刻，必然有人吃亏",
    windowStart: "18:00",
    people: [
      { name: "甲", durationMinutes: 30, preferredStart: "19:00" },
      { name: "乙", durationMinutes: 30, preferredStart: "19:00" },
      { name: "丙", durationMinutes: 30, preferredStart: "19:00" },
    ],
    // 数学下限：0+30+60=90，无法再优化
    expectTopGapMinutes: 90,
  },
  {
    id: "硬约束不必排最前",
    label: "只有一人有硬约束，其余全部灵活无偏好——核心修复点回归",
    windowStart: "18:00",
    people: [
      { name: "硬约束者", durationMinutes: 60, earliestStart: "19:00" },
      { name: "灵活甲", durationMinutes: 20 },
      { name: "灵活乙", durationMinutes: 20 },
      { name: "灵活丙", durationMinutes: 20 },
    ],
    expectTopGapMinutes: 0,
  },
  {
    id: "偏好早于窗口起点",
    label: "边界：偏好比窗口起点还早，数学下限无法优化",
    windowStart: "18:00",
    people: [
      { name: "小明", durationMinutes: 30, preferredStart: "17:00" },
      { name: "小红", durationMinutes: 30 },
    ],
    expectTopGapMinutes: 60,
  },
];

let failed = 0;
for (const c of cases) {
  const constraints = c.people.map((p) => ({
    name: p.name,
    durationMinutes: p.durationMinutes,
    earliestStartMinutes: p.earliestStart
      ? Math.max(0, toMinutes(p.earliestStart) - toMinutes(c.windowStart))
      : 0,
    preferredStartMinutes:
      p.preferredStart !== undefined
        ? toMinutes(p.preferredStart) - toMinutes(c.windowStart)
        : undefined,
  }));

  const plans = bestSchedulePlans(toMinutes(c.windowStart), constraints, 1);
  const top = plans[0];
  const ok = top && top.totalPreferenceGapMinutes === c.expectTopGapMinutes;

  console.log(
    `${ok ? "✓" : "✗"} [${c.id}] ${c.label} —— 期望偏离${c.expectTopGapMinutes}分钟，` +
      `实得${top?.totalPreferenceGapMinutes ?? "无候选"}分钟`
  );
  if (top) {
    console.log(
      "   " +
        top.assignments
          .map(
            (a) =>
              `${a.name} ${formatMinutes(a.startMinutes)}-${formatMinutes(a.endMinutes)}` +
              (a.preferenceGapMinutes !== null ? `(偏${a.preferenceGapMinutes}分)` : "")
          )
          .join(" | ")
    );
  }
  if (!ok) {
    failed++;
  }
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) {
  process.exit(1);
}
