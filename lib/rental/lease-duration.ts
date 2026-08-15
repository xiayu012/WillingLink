/**
 * 租期时长（月数）——查询侧提取、房源侧文本恢复、区间冲突判定。
 *
 * 模型：双方都是一个"可接受的居住月数区间"[min, max]（null = 无界/未知）。
 * - 房源侧：leaseMinMonths = 起租门槛（"一年起租"→12，"只接受长租"→6），
 *   leaseMaxMonths = 最长可住（转租窗口 "9/10-10/30"→2，"仅限一个月短租"→1）。
 * - 查询侧："短租3个月"→[3,3]，"租期6个月或以上"→[6,∞)，
 *   光说"短租"→(?,6]，光说"长租"→[6,?)。
 *
 * 违反判定偏严格：只有两个区间可证明不相交才算冲突（null 一律宽容放行）。
 * 权威数据是 LLM 提取的结构化列；这里的正则只做未提取行的兜底恢复，
 * 与项目 LLM-native 方向一致（复杂表述交给入库 LLM 与聊天 LLM）。
 */

export type LeaseRange = {
  leaseMinMonths: number | null;
  leaseMaxMonths: number | null;
};

export const EMPTY_LEASE_RANGE: LeaseRange = {
  leaseMinMonths: null,
  leaseMaxMonths: null,
};

const CN_MONTH_NUM: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

const EN_MONTH_NUM: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const DIGITS_RE = /^\d+$/;

/** 数字或中文数词 → 月数（1–36 之外视为无效）。 */
function monthToken(raw: string): number | null {
  const t = raw.trim();
  const n = DIGITS_RE.test(t) ? Number(t) : (CN_MONTH_NUM[t] ?? null);
  if (n == null || !Number.isFinite(n) || n < 1 || n > 36) {
    return null;
  }
  return n;
}

const YEAR_NUM: Record<string, number> = {
  一: 12,
  "1": 12,
  两: 24,
  二: 24,
  "2": 24,
  三: 36,
  "3": 36,
};

// 月数 token："6"、"六"、"两"…（不含"半"，半年单独处理）
const M = "(\\d{1,2}|十[一二]?|[一两二三四五六七八九])";
const GE = "(以上|或以上|及以上|起)";

// ── 查询侧（租客需求）───────────────────────────────────────────────────────

// "短租3个月" / "租期6个月或以上" / "租 3 个月" / "住三个月"
const Q_MONTHS_RE = new RegExp(
  `(?:租期|租住|短租|长租|转租|住|租)\\s*(?:为|是|约|大概|[:：])?\\s*${M}\\s*个月\\s*${GE}?`
);
// "租期3月以上"——缺"个"时必须带"以上/起"，避免命中三月=March
const Q_MONTHS_NO_GE_RE = new RegExp(
  `(?:租期)\\s*[:：]?\\s*${M}\\s*月\\s*${GE}`
);
// "12个月以上长租"——cue 不紧邻，但"N个月以上/起"本身就是明确的租期语义
const Q_MONTHS_BARE_GE_RE = new RegExp(`${M}\\s*个月\\s*${GE}`);
// "minimum of three months" / "at least 3 months"
const Q_MONTHS_EN_RE =
  /(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[-\s]*months?/i;
// "长租一年" / "租期两年" / "计划为期一年" / "签1年"（排除"一年级"）
const Q_YEAR_RE = new RegExp(
  `(?:租期|长租|租住|为期|签约?|租|住)\\s*(?:为|是|约|[:：])?\\s*(?<!\\d)(一|两|二|三|1|2|3)\\s*年(?!级)\\s*${GE}?`
);
// "一年租期" / "1年lease"
const Q_YEAR_POST_RE =
  /(?<!\d)(一|两|二|1|2)\s*年(?!级)\s*(?:租期|长租|lease)/i;
// "租半年" / "租期半年以上"
const Q_HALF_YEAR_RE = new RegExp(
  `(?:租期|租|住|短租)\\s*[:：]?\\s*半年\\s*${GE}?`
);

const FLEXIBLE_RE = /长短租|短租长租|长租短租|长租\/短租|短租\/长租|长\/短租/;
const NEG_SHORT_RE = /不(?:要|做|接受|考虑)?短租/;
const BARE_SHORT_RE = /短租|short[-\s]?term/i;
const BARE_LONG_RE = /长租|long[-\s]?term/i;

/**
 * 从租客自然语言查询里恢复期望租期区间（聊天 LLM 未传参数时的兜底）。
 * 精确时长（"3个月"）→ [n,n]；带"以上/起" → [n,∞)；
 * 只说"短租" → (?,6]；只说"长租"或"不短租" → [6,?)；
 * "长短租都行"或长短租同时出现 → 不构成约束。
 */
export function extractQueryLeaseRange(query: string): LeaseRange {
  let m =
    query.match(Q_MONTHS_RE) ??
    query.match(Q_MONTHS_NO_GE_RE) ??
    query.match(Q_MONTHS_BARE_GE_RE);
  if (m) {
    const n = monthToken(m[1]);
    if (n != null) {
      return m[2]
        ? { leaseMinMonths: n, leaseMaxMonths: null }
        : { leaseMinMonths: n, leaseMaxMonths: n };
    }
  }

  m = query.match(Q_MONTHS_EN_RE);
  if (m) {
    const t = m[1].toLowerCase();
    const n = DIGITS_RE.test(t) ? Number(t) : (EN_MONTH_NUM[t] ?? null);
    if (n != null && n >= 1 && n <= 36) {
      return { leaseMinMonths: n, leaseMaxMonths: null };
    }
  }

  m = query.match(Q_YEAR_RE) ?? query.match(Q_YEAR_POST_RE);
  if (m) {
    const n = YEAR_NUM[m[1]];
    if (n != null) {
      return m[2]
        ? { leaseMinMonths: n, leaseMaxMonths: null }
        : { leaseMinMonths: n, leaseMaxMonths: n };
    }
  }

  m = query.match(Q_HALF_YEAR_RE);
  if (m) {
    return m[1]
      ? { leaseMinMonths: 6, leaseMaxMonths: null }
      : { leaseMinMonths: 6, leaseMaxMonths: 6 };
  }

  // 无具体时长 → 只看长/短租倾向；两者并存或明说灵活 → 不构成约束
  if (FLEXIBLE_RE.test(query)) {
    return EMPTY_LEASE_RANGE;
  }
  const wantsLong = BARE_LONG_RE.test(query) || NEG_SHORT_RE.test(query);
  const wantsShort = !NEG_SHORT_RE.test(query) && BARE_SHORT_RE.test(query);
  if (wantsLong && wantsShort) {
    return EMPTY_LEASE_RANGE;
  }
  if (wantsLong) {
    return { leaseMinMonths: 6, leaseMaxMonths: null };
  }
  if (wantsShort) {
    return { leaseMinMonths: null, leaseMaxMonths: 6 };
  }
  return EMPTY_LEASE_RANGE;
}

// ── 房源侧（帖子文本兜底恢复，保守：只认清晰硬表述）─────────────────────────

// "6个月起租" / "三个月起" / "6个月及以上起签"
const L_MIN_MONTHS_QI_RE = new RegExp(
  `${M}\\s*个月(?:及以上|以上)?\\s*起(?:租|签)?`
);
// "至少6个月" / "最低3个月可签" / "最短半年" / "minimum 6 months"
const L_MIN_ATLEAST_RE = new RegExp(
  `(?:至少|最少|最低|最短|起码|minimum|at\\s+least)\\s*(?:租|签(?:订|约)?)?\\s*${M}\\s*个?月`
);
const L_MIN_ATLEAST_HALF_RE =
  /(?:至少|最少|最短)\s*(?:租|签(?:订|约)?)?\s*半年|半年起/;
// "一年起租" / "1年及以上起签"（(?<!\d) 防止 "2021年起" 误当 "1年起"）
const L_MIN_YEAR_QI_RE = /(?<!\d)(?:一|1)\s*年(?:及以上|以上)?\s*起(?:租|签)?/;
// "要求至少签订一年租约" / "至少一年"
const L_MIN_ATLEAST_YEAR_RE =
  /(?:至少|最少|要求)[^。\n，,]{0,6}(?<!\d)(?:一|1)\s*年/;
// "欢迎长租一年以上" / "租一年以上"
const L_MIN_YEAR_ABOVE_RE =
  /(?:长租|租|lease)[^。\n，,]{0,4}(?<!\d)(?:一|1)\s*年以上/i;
// "只接受长租" / "不短租" / "谢绝短租"（"prefer 长租/长租优先"是偏好，不算）
const L_LONG_ONLY_RE =
  /只(?:接受|限|要|考虑)?长租|不(?:接受|考虑|做)?短租|谢绝短租/;
// "租期三个月"（无"起/以上"→ 固定转租窗口，min=max）
const L_TERM_EXACT_RE = new RegExp(`租期\\s*[:：]?\\s*${M}\\s*个月(?!${GE})`);
// "租期一年"（年租约常可续 → 只作 min，不设 max）
const L_TERM_YEAR_RE = /租期\s*[:：]?\s*(?<!\d)(?:一|1)\s*年(?!以上|及以上|起)/;
// "仅限一个月短租" / "只接受3个月"
const L_MAX_ONLY_RE = new RegExp(
  `(?:仅|只)(?:限|接受|考虑)?\\s*${M}\\s*个月(?:短租)?`
);
// "目前只考虑按月短租"
const L_SHORT_ONLY_RE = /只(?:考虑|接受|限|做)?(?:按月)?短租/;
// "租期12个月以上"（无"起"但带"以上"，语义同起租门槛）
const L_MIN_MONTHS_GE_RE = new RegExp(`${M}\\s*个月\\s*(?:以上|或以上|及以上)`);

/**
 * 从房源帖文本保守恢复租期区间——仅在结构化列（LLM 提取）为 null 时兜底。
 * 日期窗口（"9/10-10/30 短租"）之类需要日期推算的表述不在此处理，交给 LLM。
 */
export function listingLeaseFromText(text: string): LeaseRange {
  let min: number | null = null;
  let max: number | null = null;

  // 精确/上限类（min 与 max 同时确定）优先
  let m = text.match(L_MAX_ONLY_RE);
  if (m) {
    const n = monthToken(m[1]);
    if (n != null) {
      return { leaseMinMonths: n, leaseMaxMonths: n };
    }
  }
  m = text.match(L_TERM_EXACT_RE);
  if (m) {
    const n = monthToken(m[1]);
    if (n != null) {
      return { leaseMinMonths: n, leaseMaxMonths: n };
    }
  }

  m =
    text.match(L_MIN_MONTHS_QI_RE) ??
    text.match(L_MIN_ATLEAST_RE) ??
    text.match(L_MIN_MONTHS_GE_RE);
  if (m) {
    min = monthToken(m[1]);
  }
  if (min == null && L_MIN_ATLEAST_HALF_RE.test(text)) {
    min = 6;
  }
  if (
    min == null &&
    (L_MIN_YEAR_QI_RE.test(text) ||
      L_MIN_ATLEAST_YEAR_RE.test(text) ||
      L_MIN_YEAR_ABOVE_RE.test(text) ||
      L_TERM_YEAR_RE.test(text))
  ) {
    min = 12;
  }
  if (min == null && L_LONG_ONLY_RE.test(text)) {
    min = 6;
  }

  if (L_SHORT_ONLY_RE.test(text)) {
    max = 6;
  }

  // 自相矛盾的提取不可信 → 全部作废
  if (min != null && max != null && min > max) {
    return EMPTY_LEASE_RANGE;
  }
  return { leaseMinMonths: min, leaseMaxMonths: max };
}

// ── 冲突判定 ─────────────────────────────────────────────────────────────────

/**
 * 房源与租客的租期区间是否可证明不相交（任一侧 null 都宽容放行）。
 */
export function leaseConflict(listing: LeaseRange, want: LeaseRange): boolean {
  if (
    want.leaseMinMonths != null &&
    listing.leaseMaxMonths != null &&
    listing.leaseMaxMonths < want.leaseMinMonths
  ) {
    return true;
  }
  if (
    want.leaseMaxMonths != null &&
    listing.leaseMinMonths != null &&
    listing.leaseMinMonths > want.leaseMaxMonths
  ) {
    return true;
  }
  return false;
}
