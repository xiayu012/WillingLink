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
 * 改成"代码枚举"。代码按公平指标稳定选出候选1，模型负责确认输入事实、
 * 发出待确认提议和组织措辞；有新事实时重新计算，而不是在多个候选之间
 * 凭感觉跳选。组合推理这一步，模型不用再自己做，弱点被绕开了，而不是
 * 被提示词硬压住。
 */

export type SlotConstraint = {
  /** 用什么称呼这个人（人名，不是 id——这个模块不碰数据库） */
  name: string;
  /** 这个人需要多久，单位分钟 */
  durationMinutes: number;
  /** 最早能开始的时间，单位「距窗口起点的分钟数」。没有硬约束就填 0 */
  earliestStartMinutes: number;
  /**
   * 硬约束：最晚不能超过这个开始时间，单位「距窗口起点的分钟数」。
   * 不给就不限制。跟 `earliestStartMinutes` 填成同一个值，就表示
   * "只能这个时刻开始"（医疗预约、固定班次这类真正钉死的时间）——
   * 这种情况下排列算法必须让这个人从这个时刻开始，不管公平与否。
   */
  latestStartMinutes?: number;
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
  /**
   * **公平性指标，跟总和是两回事**：总和最小的排法可能把全部代价都
   * 压在一个人身上（比如让一个人多等一小时，换另外两人零偏离）。
   * 这是所有带偏好的人里，偏离偏好最多的那一个的分钟数——排序只用
   * 总和会漏掉"这个方案对某一个人特别不公平"这件事，把这个数字单独
   * 摆出来，让调用方（模型）能做"总量更省 vs 没人被极端亏待"这类
   * 公平性判断，而不是只能看到一个笼统的总分。
   */
  worstPreferenceGapMinutes: number;
  /**
   * **公平尺度，跟 `worstPreferenceGapMinutes` 是两回事**：绝对分钟数
   * 会系统性偏袒长时占用者——同样是被迫多等 60 分钟，对一个只需要
   * 30 分钟的人（相当于自己所需时长的 2 倍）和对一个需要 2 小时的人
   * （只占自己所需时长的一半）根本不是同一回事。真实事故：三人厨房
   * 冲突里，2 小时的人自己也带了"到家就想做饭"的偏好，纯按绝对分钟
   * 排序会把 30 分钟的人晾到底（帮 2 小时的人省下 0 分钟、让 30 分钟
   * 的人多等 60 分钟），而稍微换个顺序、让 2 小时的人多等 60 分钟
   * （只占他自己时长的一半），能让 30 分钟的人只多等 30 分钟（占他
   * 自己时长的 100%，虽然数字一样大，但这已经是能力范围内最公平的
   * 那一档）。这是所有带偏好的人里，「偏离分钟数 / 自己需要的时长」
   * 这个比值最大的那一个——排序优先压低这个比值，比压低绝对分钟数
   * 总和更接近"没有人被按比例过度亏待"。
   */
  worstPreferenceRatio: number;
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
 * 返回**先按最坏偏离占本人时长的比例、再按总偏离分钟数、最后按最晚
 * 结束时刻**排序的全部可行方案。
 */
/**
 * 给定一个固定的人员顺序，算出这个顺序下的排法（贪心堆 + 从后往前松弛，
 * 见上面两段函数注释）。硬约束互相顶死排不进这个顺序时返回 null。
 *
 * 从 `findSchedulePlans` 里抽出来，是因为公平理由（`describeFairnessGain`）
 * 需要跟"长占用者排最前面"这一个**指定**顺序比较，不是跟全部排列比较。
 */
export function assignPlanForOrder(
  windowStartMinutes: number,
  order: SlotConstraint[]
): SlotPlan | null {
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
  // 下一个人（松弛后）的开始时刻，也不晚于自己的硬性最晚开始时刻
  // （latestStartMinutes，比如医疗预约固定时段）。
  const finalStart = new Array<number>(order.length);
  let nextStart = Number.POSITIVE_INFINITY; // 松弛后，右边那个人的开始时刻上限
  for (let i = order.length - 1; i >= 0; i--) {
    const c = order[i];
    const lowerBound = earliest[i].start;
    const hardLatest =
      c.latestStartMinutes === undefined
        ? Number.POSITIVE_INFINITY
        : windowStartMinutes + c.latestStartMinutes;
    const upperBound = Math.min(nextStart - c.durationMinutes, hardLatest); // 不能挤到下一个人，也不能晚过硬性上限
    if (lowerBound > upperBound) {
      // 硬约束互相顶死，这个顺序排不出可行方案
      return null;
    }
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
  const worstPreferenceGapMinutes = Math.max(
    0,
    ...assignments.map((a) => a.preferenceGapMinutes ?? 0)
  );
  const worstPreferenceRatio = Math.max(
    0,
    ...assignments.map((a, idx) =>
      a.preferenceGapMinutes === null ? 0 : a.preferenceGapMinutes / order[idx].durationMinutes
    )
  );
  return {
    order: order.map((c) => c.name),
    assignments,
    latestEndMinutes,
    totalPreferenceGapMinutes,
    worstPreferenceGapMinutes,
    worstPreferenceRatio,
  };
}

export function findSchedulePlans(
  windowStartMinutes: number,
  constraints: SlotConstraint[]
): SlotPlan[] {
  if (constraints.length === 0) {
    return [];
  }
  const plans: SlotPlan[] = [];
  for (const order of permutations(constraints)) {
    const plan = assignPlanForOrder(windowStartMinutes, order);
    if (plan) {
      plans.push(plan);
    }
  }
  /**
   * 排序优先级：公平比值（worstPreferenceRatio）> 总偏离分钟数
   * （totalPreferenceGapMinutes）> 最晚结束时刻。**先比比值，不是先比
   * 总和**——总和最小的方案可能把全部代价都塞给一个短时长的人（见
   * `worstPreferenceRatio` 的注释），比值优先能避免这一点；总和只在
   * 比值打平时才用来分高下。
   */
  plans.sort(
    (a, b) =>
      a.worstPreferenceRatio - b.worstPreferenceRatio ||
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

/**
 * 把"候选一比直觉排法（长占用者先）公平在哪"算成一句话，代码算数字，
 * 模型不用自己心算比较。
 *
 * 起因：模型自己复述"选这个候选是因为更公平"时会编造具体让了多少、
 * 让给了谁——用户实测抓到过一次：排法本身完全正确，回复却虚构
 * "要让两位短时长者各多等两小时以上"来解释为什么选中了公平候选。
 * 这个函数把"公平在哪"的具体数字算好，模型只需要转述，不需要比较。
 *
 * 两个方案打平或候选一没有更公平时返回 null——没有值得说的对比就不编一句。
 */
export function describeFairnessGain(
  baseline: SlotPlan,
  winner: SlotPlan,
  constraints: SlotConstraint[]
): string | null {
  const durationByName = new Map(constraints.map((c) => [c.name, c.durationMinutes]));
  const ratioOf = (a: SlotAssignment): number =>
    a.preferenceGapMinutes === null ? 0 : a.preferenceGapMinutes / (durationByName.get(a.name) ?? 1);
  const worstOf = (plan: SlotPlan): { assignment: SlotAssignment; ratio: number } | null =>
    plan.assignments.reduce<{ assignment: SlotAssignment; ratio: number } | null>(
      (worst, a) => {
        const ratio = ratioOf(a);
        return !worst || ratio > worst.ratio ? { assignment: a, ratio } : worst;
      },
      null
    );
  const baseWorst = worstOf(baseline);
  const winnerWorst = worstOf(winner);
  if (!baseWorst || !winnerWorst || winnerWorst.ratio >= baseWorst.ratio) {
    return null;
  }

  const [longestName] = [...durationByName.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const baseLongest = baseline.assignments.find((a) => a.name === longestName);
  const winnerLongest = winner.assignments.find((a) => a.name === longestName);
  const shiftMinutes =
    baseLongest && winnerLongest ? winnerLongest.startMinutes - baseLongest.startMinutes : 0;

  return (
    `跟"占用时间最长的${longestName}排最早"这种直觉排法比：候选1把最坏情况从` +
    `${baseWorst.assignment.name}偏离自身所需时长约${Math.round(baseWorst.ratio * 100)}%，` +
    `降到${winnerWorst.assignment.name}偏离约${Math.round(winnerWorst.ratio * 100)}%` +
    (shiftMinutes !== 0
      ? `，代价是${longestName}的开始时间${shiftMinutes > 0 ? "推迟" : "提前"}了约${Math.abs(shiftMinutes)}分钟`
      : "") +
    "（这是代码比较两种排法算出来的数字，不是估的）"
  );
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

export type ScheduleSelection = { plan: SlotPlan; candidateNumber: number };

/**
 * 初始提议只允许候选1；编号校验抽成纯函数，方便直接单测。
 */
export function selectScheduleCandidate(
  candidates: SlotPlan[],
  candidateNumber: number
): { ok: true; selection: ScheduleSelection } | { ok: false; reason: string } {
  const plan = candidates[candidateNumber - 1];
  if (!plan) {
    return { ok: false, reason: `只有 ${candidates.length} 个候选，没有候选${candidateNumber}` };
  }
  if (candidateNumber !== 1) {
    return {
      ok: false,
      reason: "初始提议只能选候选1；若有新事实，更新硬约束/偏好后重新调用 pickSchedule",
    };
  }
  return { ok: true, selection: { plan, candidateNumber } };
}

/**
 * 核对"这条要发给某人的消息里报的时段"跟"已选方案里这个人的时段"是否
 * 一致——结构化字符串比较（HH:MM），不猜正文语义。跨候选拼数字、
 * 编一个方案里没有的人，都在这里被挡下，不进 outbound。
 */
export function checkScheduleSlotConsistency(
  selection: ScheduleSelection,
  name: string,
  slot: { start: string; end: string }
): { ok: true } | { ok: false; reason: string } {
  const assignment = selection.plan.assignments.find((a) => a.name === name);
  if (!assignment) {
    return { ok: false, reason: `已选方案里没有「${name}」，检查人名或窗口名` };
  }
  const expectedStart = formatMinutes(assignment.startMinutes);
  const expectedEnd = formatMinutes(assignment.endMinutes);
  if (slot.start !== expectedStart || slot.end !== expectedEnd) {
    return {
      ok: false,
      reason: `跟已选方案对不上——${name}的时段是${expectedStart}-${expectedEnd}，填的是${slot.start}-${slot.end}`,
    };
  }
  return { ok: true };
}
