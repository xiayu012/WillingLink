/**
 * 排班算法（lib/chat/coliving/scheduling.ts）的回归检查。
 *
 *   pnpm scheduling:inspect
 *
 * 起因（2026-09-04）：用户要求"多打磨、多使用"这个新工具，自己出题
 * 测了20个跨场景用例（真实原案/多人/极端时长/边界输入/性能压力），
 * 发现一个真实 bug——算法只贪心从前往后堆，从不为了偏好把人往后挪，
 * 导致窗口有富余空当时算不出本该零偏离的解（见用例5/10/12）。修法：
 * 加了一轮从后往前的松弛调整。
 *
 * 二次事故（2026-09-06）：排序只按总偏离分钟数排，会系统性把代价全部
 * 压给短时长的人——同样让人多等60分钟，对占用半小时的人和占用两小时
 * 的人根本不是一回事。真实场景：厨房三人冲突，2小时的人自己也带了
 * "到家就想做饭"的偏好，纯按总分钟数排序会让30分钟的短用户吃满全部
 * 60分钟代价、2小时的长用户一分钟都不用让——判决评测里被判定"仍然
 * 是老毛病换了马甲"。改法：排序标准换成 worstPreferenceRatio（偏离
 * 最惨的人，偏离时长占他自己所需时长的比例），总分钟数降级为平局判据。
 * 同时给 SlotConstraint 加了 latestStartMinutes（真正钉死的开始时间，
 * 跟 earliestStartMinutes 填一样就是"只能这个点开始"），保证公平排序
 * 不会突破真正的硬约束。
 *
 * 这份脚本把当时发现问题的用例、以及这次公平排序改动新增的用例都固定
 * 下来，**以后改动 scheduling.ts 前后都跑一遍**，防止同类回归。
 * **断言不能只看总偏离分钟数**——那正是这次真实事故里"字段存在但
 * 排序仍然不公平"漏过去的原因，必须核对具体谁被排在哪、排第几。
 *
 * 不含真实模型调用（这是纯函数测试），几毫秒跑完，随手改随手跑。
 */

import {
  bestSchedulePlans,
  checkScheduleSlotConsistency,
  formatMinutes,
  selectScheduleCandidate,
} from "../lib/chat/coliving/scheduling";

type Person = {
  name: string;
  durationMinutes: number;
  earliestStart?: string;
  latestStart?: string;
  preferredStart?: string;
};

type TestCase = {
  id: string;
  label: string;
  windowStart: string;
  people: Person[];
  /** 期望排第一的候选，总偏离分钟数应该等于这个值（null = 不检查这项） */
  expectTopGapMinutes: number | null;
  /** 期望排第一的候选，具体某个人排在窗口的第几个开始时刻（0 = 最早），不检查的人可以不写 */
  expectStart?: Record<string, string>;
  /** 期望这道题无解（硬约束互相顶死） */
  expectInfeasible?: boolean;
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
    label: "全员偏好都是同一时刻，时长相同，必然有人吃亏",
    windowStart: "18:00",
    people: [
      { name: "甲", durationMinutes: 30, preferredStart: "19:00" },
      { name: "乙", durationMinutes: 30, preferredStart: "19:00" },
      { name: "丙", durationMinutes: 30, preferredStart: "19:00" },
    ],
    // 时长相同时，比值排序退化成跟总分钟数排序一样：数学下限 0+30+60=90
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
  {
    id: "公平排序-厨房三人",
    label:
      "2026-09-06 判定失败复现：长时长者(120分钟)带偏好+两个短时长者，" +
      "总偏离最小的排法会让短时长者吃满全部代价，公平排序应该反过来",
    windowStart: "18:00",
    people: [
      { name: "小林", durationMinutes: 120, preferredStart: "18:00" },
      { name: "小周", durationMinutes: 30 },
      { name: "小陈", durationMinutes: 30, preferredStart: "19:00" },
    ],
    // 公平排序下：小周、小陈（各30分钟）排前面，小林（120分钟）排最后，
    // 小林多等60分钟只占他自己时长的一半，小陈只多等30分钟——
    // 总分钟数(90)比"总偏离最小"的排法(60)更多，但没人被按比例过度亏待。
    // 数学验证见 lib/chat/coliving/scheduling.ts 改动时的推导。
    expectTopGapMinutes: 90,
    expectStart: { 小周: "18:00", 小陈: "18:30", 小林: "19:00" },
  },
  {
    id: "长者fixedStart仍必须最早",
    label:
      "跟上一条同样的人员时长配置，但长时长者的开始时间是真正钉死的" +
      "硬约束（earliest=latest=18:00）——公平排序不能突破真硬约束",
    windowStart: "18:00",
    people: [
      { name: "老王", durationMinutes: 120, earliestStart: "18:00", latestStart: "18:00" },
      { name: "小周", durationMinutes: 30 },
      { name: "小陈", durationMinutes: 30, preferredStart: "19:00" },
    ],
    // 老王被钉死在18:00开始，不管公平不公平——第一个断言就是这个
    expectStart: { 老王: "18:00" },
    expectTopGapMinutes: null,
  },
  {
    id: "latestStart边界不可突破",
    label: "两人都有 latestStart，硬约束互相顶死到物理上排不进窗口——应返回空",
    windowStart: "18:00",
    people: [
      { name: "甲", durationMinutes: 60, earliestStart: "18:00", latestStart: "18:00" },
      { name: "乙", durationMinutes: 60, earliestStart: "18:00", latestStart: "18:00" },
    ],
    expectTopGapMinutes: null,
    expectInfeasible: true,
  },
  {
    id: "洗衣非厨房同样适用公平排序",
    label:
      "换个场景（洗衣机）验证公平排序不是厨房/长者硬编码的特例——" +
      "结构跟厨房用例一样（长时长者也带偏好、两个短时长者一个有偏好" +
      "一个没有），公平排序同样把两个短时长者排前面、长时长者排最后，" +
      "长时长者多等的分钟数相对他自己的时长占比更低。",
    windowStart: "20:00",
    people: [
      { name: "长时使用者", durationMinutes: 80, preferredStart: "20:00" },
      { name: "短时使用者甲", durationMinutes: 20 },
      { name: "短时使用者乙", durationMinutes: 20, preferredStart: "20:40" },
    ],
    expectStart: { 短时使用者甲: "20:00", 短时使用者乙: "20:20", 长时使用者: "20:40" },
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
    latestStartMinutes:
      p.latestStart !== undefined
        ? toMinutes(p.latestStart) - toMinutes(c.windowStart)
        : undefined,
    preferredStartMinutes:
      p.preferredStart !== undefined
        ? toMinutes(p.preferredStart) - toMinutes(c.windowStart)
        : undefined,
  }));

  const plans = bestSchedulePlans(toMinutes(c.windowStart), constraints, 1);
  const top = plans[0];

  let ok = true;
  const problems: string[] = [];

  if (c.expectInfeasible) {
    if (plans.length !== 0) {
      ok = false;
      problems.push("期望无解（硬约束互相顶死），但算出了候选");
    }
  } else {
    if (!top) {
      ok = false;
      problems.push("没有候选，但这道题应该有解");
    } else {
      if (
        c.expectTopGapMinutes !== null &&
        c.expectTopGapMinutes !== undefined &&
        top.totalPreferenceGapMinutes !== c.expectTopGapMinutes
      ) {
        ok = false;
        problems.push(
          `总偏离期望${c.expectTopGapMinutes}分钟，实得${top.totalPreferenceGapMinutes}分钟`
        );
      }
      if (c.expectStart) {
        for (const [name, hhmm] of Object.entries(c.expectStart)) {
          const a = top.assignments.find((x) => x.name === name);
          if (!a) {
            ok = false;
            problems.push(`候选一里找不到 ${name}`);
            continue;
          }
          const expected = toMinutes(hhmm);
          if (a.startMinutes !== expected) {
            ok = false;
            problems.push(
              `${name} 期望从 ${hhmm} 开始，实际是 ${formatMinutes(a.startMinutes)}`
            );
          }
        }
      }
    }
  }

  console.log(`${ok ? "✓" : "✗"} [${c.id}] ${c.label}`);
  if (top) {
    console.log(
      "   " +
        top.assignments
          .map(
            (a) =>
              `${a.name} ${formatMinutes(a.startMinutes)}-${formatMinutes(a.endMinutes)}` +
              (a.preferenceGapMinutes !== null ? `(偏${a.preferenceGapMinutes}分)` : "")
          )
          .join(" | ") +
        ` —— 总偏离${top.totalPreferenceGapMinutes}分钟，公平比值${(top.worstPreferenceRatio * 100).toFixed(0)}%`
    );
  } else if (!c.expectInfeasible) {
    console.log("   无候选");
  } else {
    console.log("   （无候选，符合预期）");
  }
  for (const p of problems) {
    console.log(`   ✗ ${p}`);
  }

  if (!ok) {
    failed++;
  }
}

// 候选选择和跨消息一致性是纯代码门禁，不能只靠模型遵守提示词。
const selectionPlans = bestSchedulePlans(18 * 60, [
  { name: "长时", durationMinutes: 120, earliestStartMinutes: 0, preferredStartMinutes: 0 },
  { name: "短时甲", durationMinutes: 30, earliestStartMinutes: 0 },
  { name: "短时乙", durationMinutes: 30, earliestStartMinutes: 0, preferredStartMinutes: 60 },
], 5);
const invalidSelection = selectScheduleCandidate(selectionPlans, 99);
const unexplainedAlternative = selectScheduleCandidate(selectionPlans, 2);
const selected = selectScheduleCandidate(selectionPlans, 1);
const selectionChecksOk =
  !invalidSelection.ok &&
  !unexplainedAlternative.ok &&
  selected.ok &&
  checkScheduleSlotConsistency(selected.selection, "短时甲", {
    start: "18:00",
    end: "18:30",
  }).ok &&
  !checkScheduleSlotConsistency(selected.selection, "短时乙", {
    start: "20:30",
    end: "21:00",
  }).ok;
console.log(`${selectionChecksOk ? "✓" : "✗"} [结构化候选选择] 非法/次优候选被拒，同一候选时段通过，跨候选拼接被拒`);
if (!selectionChecksOk) failed++;

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} 通过`);
if (failed > 0) {
  process.exit(1);
}
