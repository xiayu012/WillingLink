/**
 * 给一段连续时间窗口、几个人各自的硬约束（最早能开始、需要多久）和
 * 可选的偏好时段，算出把这段窗口切给他们的候选排法。
 *
 * ## 为什么要单独写这个，不让模型自己排
 *
 * 真实事故：三人厨房时段冲突，其中一人 18 点到家、要占两小时（硬约束）。
 * 模型把这个人**默认排在最前面**，另外两人自动往后堆到 20:00-21:00，
 * 然后老老实实承认"这个结果不够好"——**承认了，但从没想到把这个人
 * 排在中间或最后，本来能让偏好七点吃饭的房东避开被垫底**。用户原话：
 * "竟然都没想到把两个小时的那个人排到最后一名就解决了"，追问"为什么
 * 不能聪明呢"。
 *
 * 诊断：这不是缺一条提示词规则的问题（core.md 闸四已经要求"结果不合理
 * 要承认"，模型确实照做了），**是这一类"给定约束和偏好，枚举排列组合，
 * 挑出让最多人满意的那个"的组合优化推理，本来就不是语言模型的强项**——
 * 它是在用模式匹配"猜"一个听起来合理的排法（"有硬约束的人自然排最
 * 前面"是一个常见但不必然最优的直觉），不是在真的算。堆多少条提示词
 * 提醒它"要考虑其他排列"，都只能提高它*想到*这件事的概率，不能保证
 * 它*算对*——这正是用户说的"天天开发下去太无穷无尽了"在预言的事。
 *
 * ## 优化目标：不是"总时长最短"，是"尽量满足偏好"
 *
 * 一开始按"最晚结束时刻最早"（minimax）设计，实测发现这个目标在真实
 * 场景里不成立——三人总需求（120+30+30分钟）刚好填满 18:00-21:00 这个
 * 窗口，**不管怎么排，最晚的人结束时间都是同一个 21:00**。真正的问题
 * 不是"最坏情况多差"，是"谁被分配到了他不想要的时段"。所以改成：
 * 每个人可以带一个可选的「偏好时段」（不是硬约束，是软偏好，比如
 * "七点最合适"），**在所有不违反硬约束的排列里，挑出让最多人的分配
 * 落进（或最接近）自己偏好时段的那几种**。
 *
 * 修法：把"枚举排列、算每种排法谁满意谁不满意"这一步从"模型心算"
 * 改成"代码枚举"。模型只从候选方案里选、判断合不合适、想怎么措辞——
 * 组合推理这一步，模型不用再自己做，弱点被绕开了，而不是被提示词
 * 硬压住。判断哪个候选"好不好"、要不要用、怎么跟住户说，仍然是模型
 * 的活——这里只提供"有哪些排法、每种排法谁满意谁不满意"这个事实，
 * 不替模型拍板用哪个（模型可能因为其他人际因素，故意不选偏好满足度
 * 最高的那个，那是它的判断权，不是这个函数管的）。
 */

export type SlotConstraint = {
  /** 用什么称呼这个人（人名，不是 id——这个模块不碰数据库） */
  name: string;
  /** 这个人需要多久，单位分钟 */
  durationMinutes: number;
  /** 最早能开始的时间，单位「距窗口起点的分钟数」。没有硬约束就填 0 */
  earliestStartMinutes: number;
  /**
   * 软偏好：他说的"最合适"的开始时间，距窗口起点的分钟数。
   * 不是硬约束——排列时不会因为这个被拒绝，只用来算"满意度"。
   * 没说偏好就留空，这个人不参与满意度打分。
   */
  preferredStartMinutes?: number;
};

export type SlotAssignment = {
  name: string;
  /** 距窗口起点的分钟数 */
  startMinutes: number;
  endMinutes: number;
  /**
   * 跟偏好差多少分钟（没填偏好就是 null）。0 = 正好落在偏好时刻，
   * 数值越大偏离越远。用绝对值，不区分早于/晚于偏好。
   */
  preferenceGapMinutes: number | null;
};

export type SlotPlan = {
  order: string[];
  assignments: SlotAssignment[];
  /** 这个排法里，最晚的人几点结束 */
  latestEndMinutes: number;
  /**
   * 满意度打分：所有带偏好的人，偏离偏好的分钟数加总，**越小越好**。
   * 没有任何人带偏好时恒为 0，这种情况下退化成纯粹按 latestEndMinutes 排。
   */
  totalPreferenceGapMinutes: number;
};

/**
 * 穷举全部排列（人数很少，穷举足够快——合租房场景几乎不会超过 6-8 人，
 * 8! = 40320，几毫秒内算完，没必要上更复杂的算法）。
 *
 * 每种排列按顺序把人依次排进窗口：每个人的开始时间取
 * 「max(硬约束的最早开始时间, 前一个人结束的时间)」得到**最早可行时刻**，
 * 再从最后一个人开始**往回松弛**：只要不违反"不早于自己的最早开始时间"
 * 和"不能晚到挤进下一个人的时段"，就把每个人的开始时刻朝自己的偏好挪。
 *
 * **为什么需要这一步（真实踩过的坑）**：只贪心从前往后堆、从不回头调整，
 * 会漏掉"窗口有富余空当时，应该把空当让给最接近这里的偏好"这种情形。
 * 例：窗口 17:00 起，老张 17:30 起硬占 90 分钟，小刘偏好 18:00、只要
 * 15 分钟——纯贪心会把小刘怼在窗口最前面（17:00-17:15，偏离偏好 60
 * 分钟），但小刘其实可以贴着老张开始前排（17:15-17:30，偏离只剩 45
 * 分钟；如果窗口起点更早、空当更大，甚至能让小刘正好卡在 17:45-18:00，
 * 偏离归零）——**贪心从前往后堆永远发现不了这种"该往后挪半步"的解**，
 * 必须再来一遍从后往前的松弛调整。
 *
 * 返回**先按满意度（totalPreferenceGapMinutes 从小到大）、
 * 再按最晚结束时刻（从小到大）**排序的全部方案。
 */
export function findSchedulePlans(
  windowStartMinutes: number,
  constraints: SlotConstraint[]
): SlotPlan[] {
  if (constraints.length === 0) {
    return [];
  }
  const plans: SlotPlan[] = [];
  for (const order of permutations(constraints)) {
    // 第一遍：贪心从前往后堆，得到每个人的「最早可行开始时刻」
    let cursor = windowStartMinutes;
    const earliest: { start: number; end: number }[] = [];
    for (const c of order) {
      const start = Math.max(cursor, windowStartMinutes + c.earliestStartMinutes);
      const end = start + c.durationMinutes;
      earliest.push({ start, end });
      cursor = end;
    }

    // 第二遍：从最后一个人开始往回松弛，把每个人尽量挪向自己的偏好，
    // 但不早于「最早可行开始时刻」，也不晚到让自己的结束时刻超过
    // 下一个人（松弛后）的开始时刻。
    const finalStart = new Array<number>(order.length);
    let nextStart = Number.POSITIVE_INFINITY; // 松弛后，右边那个人的开始时刻上限
    for (let i = order.length - 1; i >= 0; i--) {
      const c = order[i];
      const lowerBound = earliest[i].start;
      const upperBound = nextStart - c.durationMinutes; // 不能挤到下一个人
      const preferred =
        c.preferredStartMinutes === undefined
          ? lowerBound
          : windowStartMinutes + c.preferredStartMinutes;
      // 在 [lowerBound, upperBound] 区间内，选离 preferred 最近的点
      const start = Math.min(Math.max(preferred, lowerBound), upperBound);
      finalStart[i] = start;
      nextStart = start;
    }

    const assignments: SlotAssignment[] = order.map((c, i) => {
      const start = finalStart[i];
      const end = start + c.durationMinutes;
      const preferenceGapMinutes =
        c.preferredStartMinutes === undefined
          ? null
          : Math.abs(start - (windowStartMinutes + c.preferredStartMinutes));
      return { name: c.name, startMinutes: start, endMinutes: end, preferenceGapMinutes };
    });

    const latestEndMinutes = Math.max(...assignments.map((a) => a.endMinutes));
    const totalPreferenceGapMinutes = assignments.reduce(
      (sum, a) => sum + (a.preferenceGapMinutes ?? 0),
      0
    );
    plans.push({
      order: order.map((c) => c.name),
      assignments,
      latestEndMinutes,
      totalPreferenceGapMinutes,
    });
  }
  plans.sort(
    (a, b) =>
      a.totalPreferenceGapMinutes - b.totalPreferenceGapMinutes ||
      a.latestEndMinutes - b.latestEndMinutes
  );
  return plans;
}

/** 只返回按满意度排序去重后的前 N 个方案，供模型挑选 */
export function bestSchedulePlans(
  windowStartMinutes: number,
  constraints: SlotConstraint[],
  topN = 3
): SlotPlan[] {
  const all = findSchedulePlans(windowStartMinutes, constraints);
  const seen = new Set<string>();
  const out: SlotPlan[] = [];
  for (const p of all) {
    const key = p.order.join(">");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(p);
    if (out.length >= topN) {
      break;
    }
  }
  return out;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) {
      out.push([items[i], ...p]);
    }
  }
  return out;
}

/** 分钟数转「HH:MM」，方便直接拼进给模型看的文本。超过24小时环绕显示，调用方自己保证窗口不超过一天 */
export function formatMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
