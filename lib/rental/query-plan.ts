/**
 * 查询理解层（LLM-native）：自然语言 → 结构化检索计划 QueryPlan。
 *
 * 为什么要有这一层
 * ----------------
 * 此前"理解查询"这件事分散在两个互相看不见的地方：
 *   生产路径 = 聊天模型调 searchRental 时顺带传的扁平参数；
 *   评测路径 = 直连工具、聊天层缺席，只剩 query-constraints.ts 的正则兜底。
 * 于是**跑门禁时被测的根本不是线上跑的那套理解逻辑**（AGENT_LOG 2026-08-14 §7
 * 记的"评测固有盲区"就是这个）。更糟的是扁平参数表达不了真实语料的形状：
 * 真人一口气说五个可接受城市、四种可接受户型，扁平 schema 只能填一个值，
 * 代码的应对是**整条约束直接丢弃** —— 于是 216 条真实求租帖里 109 条（50%）
 * 完全没有地点约束，另有 51 条（24%）因为"列了多个城市"被放弃过滤，
 * Dublin 的需求可以拿 San Jose 的房源来答。
 *
 * QueryPlan 把这两个问题一起解决：
 *   1. **约束是集合，不是单值**。列了备选 = 一个 OR 集合，不是"放弃过滤"。
 *      "Dublin优先，San Ramon也可以" → cities: [Dublin, San Ramon]。
 *   2. **理解层只有一处**，运行时与评测都调 planQuery，永不漂移。
 *
 * 分工没有变（见 CLAUDE.md）：这一层只负责"用户到底要什么"，
 * 硬筛选依旧偏严格（只剔可证明违反的），相关性依旧交给 rerank + 终审。
 *
 * 失败姿态：LLM 不可用/输出不可解析 → 退回纯正则计划，搜索永不因此挂掉。
 */

import { generateText } from "ai";

import { getQueryPlannerModel } from "@/lib/ai/providers";
import {
  type BayRegion,
  CITY_TABLE,
  citiesInRegions,
  cityByName,
  detectCities,
  detectRegions,
  isNewZealandText,
  isOutOfBayQuery,
  NON_BAY_CITY_RE,
} from "./cities";
import type { FlexibleDate } from "./date-availability";
import { geocodePlace, type ResolvedPlace, staticPlacePoint } from "./geo";
import {
  extractBooleanPrefs,
  extractHardConstraints,
} from "./query-constraints";

export type BoolRequirementKey =
  | "petFriendly"
  | "couplesOk"
  | "utilitiesIncluded"
  | "parkingIncluded";

export type QueryPlan = {
  /** 需求明显不在湾区（西雅图/匹兹堡/温哥华列治文…）→ 如实回答"没有收录"。 */
  outOfScope: boolean;
  outOfScopeReason: string | null;
  /** 可接受城市集合（canonical English），OR 关系。空 = 不限城市。 */
  cities: string[];
  /** 用户说出的区域词，仅用于解释与日志；已经展开进 cities。 */
  regions: BayRegion[];
  /** 小区/公寓/地标原文，用来给排序加权（**不参与硬筛选**）。 */
  anchors: string[];
  /**
   * 用户说"靠近X"里的那个 X，解析成坐标之后的结果。
   * 一旦有值，它就**取代城市集合**成为地理约束——距离比"在不在市界内"精确得多。
   */
  near: ResolvedPlace | null;
  /** 想靠近的地点原文；解析成功与否都留着，进日志和给用户的解释。 */
  nearQuery: string | null;
  /** 说了"靠近X"但 X 定位不出来 → 别假装知道，让聊天层反问用户。 */
  nearUnresolved: string | null;
  /** near 生效时的可接受半径（公里），按用户的出行方式定。 */
  radiusKm: number | null;
  rentMin: number | null;
  rentMax: number | null;
  /** 可接受的整套卧室数集合（studio=0），OR 关系。空 = 不限户型。 */
  bedroomsAnyOf: number[];
  leaseMonthsMin: number | null;
  leaseMonthsMax: number | null;
  moveIn: FlexibleDate;
  /** 硬性布尔要求；只有 true 才构成约束。 */
  requires: Record<BoolRequirementKey, boolean | null>;
  /** 偏好原文（"最好有独卫"）：进 rerank 查询与终审提示，绝不进硬筛选。 */
  prefers: string[];
  /** 命中即淘汰的关键词（"中介"）。 */
  excludes: string[];
  source: "llm" | "regex";
};

/** 聊天模型在调用 searchRental 时传下来的结构化参数（旧扁平 schema + 新集合）。 */
export type PlanParams = {
  city?: string | null;
  cities?: string[] | null;
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsNum?: number | null;
  bedroomsAnyOf?: number[] | null;
  petFriendly?: boolean | null;
  couplesOk?: boolean | null;
  utilitiesIncluded?: boolean | null;
  parkingIncluded?: boolean | null;
  leaseMonthsMin?: number | null;
  leaseMonthsMax?: number | null;
};

const MAX_CITIES = 12;
const MAX_ANCHORS = 8;
const MAX_PREFERS = 12;
const MAX_BEDROOMS = 6;
const PLAUSIBLE_RENT_MIN = 200;
const PLAUSIBLE_RENT_MAX = 20_000;
const PLANNER_TIMEOUT_MS = 12_000;
const PLAN_CACHE_MAX = 500;
/** 区域展开覆盖超过这个比例的城市表 → 视为"整个湾区"，不构成约束。 */
const BAY_WIDE_RATIO = 0.6;

/**
 * "靠近"到底是多近，按出行方式定。直线距离，实际路网还要打个折，所以取值
 * 偏宽——这是硬筛选，宁可把稍远的留给排序去压，也不要误杀。
 */
const RADIUS_KM: Record<string, number> = {
  walk: 2.5,
  bike: 6,
  transit: 12,
  drive: 25,
};
const DEFAULT_RADIUS_KM = 12;
/** 回退开关：SEARCH_PLANNER_OFF=1 → 只用正则计划，完全不调理解层 LLM。 */
const PLANNER_OFF = process.env.SEARCH_PLANNER_OFF === "1";

export function emptyPlan(): QueryPlan {
  return {
    outOfScope: false,
    outOfScopeReason: null,
    cities: [],
    regions: [],
    anchors: [],
    near: null,
    nearQuery: null,
    nearUnresolved: null,
    radiusKm: null,
    rentMin: null,
    rentMax: null,
    bedroomsAnyOf: [],
    leaseMonthsMin: null,
    leaseMonthsMax: null,
    moveIn: { kind: "unknown" },
    requires: {
      petFriendly: null,
      couplesOk: null,
      utilitiesIncluded: null,
      parkingIncluded: null,
    },
    prefers: [],
    excludes: [],
    source: "regex",
  };
}

// ── 正则基线计划（兜底 + LLM 结果的地基）────────────────────────────────────

/**
 * 纯确定性计划。LLM 不可用时这就是全部；可用时它提供 LLM 未覆盖字段的默认值。
 *
 * 城市在这里**允许集合**（提到几个就是几个），这是相对旧实现最大的行为变化：
 * 旧实现"提到多个城市就整个不过滤"，等于把用户说出口的地点当没听见。
 * 户型仍沿用保守的"唯一值才算硬约束"——"Studio最优先，合租也行"这种备选里
 * 混着无法用卧室数表达的选项，集合是不完整的，拿它硬过滤会误杀（这正是
 * AGENT_LOG 2026-08-15 记的那个 case）。让 LLM 去判断这种句子。
 */
export function planFromRegex(query: string): QueryPlan {
  const nl = extractHardConstraints(query);
  const nlBool = extractBooleanPrefs(query);
  const regions = detectRegions(query);
  const named = detectCities(query).map((c) => c.en);
  // 明确的城市名优先；只说了区域词（"南湾"）才展开成该区域的城市集合。
  const fromRegions = citiesInRegions(regions);
  const cities =
    named.length > 0
      ? named
      : fromRegions.length > CITY_TABLE.length * BAY_WIDE_RATIO
        ? []
        : fromRegions;
  return {
    ...emptyPlan(),
    outOfScope: isOutOfBayQuery(query),
    outOfScopeReason: isOutOfBayQuery(query) ? "查询指向湾区以外的城市" : null,
    cities: cities.slice(0, MAX_CITIES),
    regions,
    rentMin: nl.rentMin,
    rentMax: nl.rentMax,
    bedroomsAnyOf: nl.bedroomsNum == null ? [] : [nl.bedroomsNum],
    leaseMonthsMin: nl.leaseMonthsMin,
    leaseMonthsMax: nl.leaseMonthsMax,
    moveIn: nl.moveIn,
    requires: { ...nlBool },
    source: "regex",
  };
}

// ── 聊天模型传下来的参数覆盖 ────────────────────────────────────────────────

function normalizeCities(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const entry = cityByName(raw);
    // 表里没有的城市名（"Tracy"）保留原样：谓词会退化成仅比对 city 列，
    // 好过默默丢掉用户说出口的地点。
    const name = entry?.en ?? raw.trim();
    if (name && !out.includes(name)) {
      out.push(name);
    }
  }
  return out.slice(0, MAX_CITIES);
}

/** 聊天模型显式传的参数覆盖计划里的对应字段（它看得见完整对话上下文）。 */
export function applyParams(plan: QueryPlan, params: PlanParams): QueryPlan {
  const paramCities = normalizeCities([
    ...(params.cities ?? []),
    ...(params.city ? [params.city] : []),
  ]);
  const paramBeds = [
    ...(params.bedroomsAnyOf ?? []),
    ...(params.bedroomsNum == null ? [] : [params.bedroomsNum]),
  ].filter((n) => Number.isInteger(n) && n >= 0 && n <= 5);

  // 模型点名了城市 → 清掉**由城市推出来的**那个半径锚点。
  //
  // 以前只覆盖 cities、不动 near，于是计划里同时留着 cities=["Mountain View"]
  // 和 near=MountainView/12km。而 `planQuery` 自己解析时是二选一的（设了 near
  // 就把 cities 清空），只有走 applyParams 这条路才会两个并存——语义上说不通，
  // 匹配器里那句"距离约束生效时取代城市约束"的注释也就落了空。
  //
  // 实测后果："mountain view或者附近通勤30分钟内都可"被压平成 MV 周围 12km 的
  // 均匀圆盘，Los Altos/Sunnyvale/Cupertino/Santa Clara 全部合格，用户点名的
  // Mountain View 反而淹没在里面（AGENT_LOG 2026-08-26）。
  //
  // **只清城市锚点，不清地标锚点**：「近Apple Park」「走路到UCB」这种精度比城市
  // 高，是 cities 表达不了的东西，清掉就是丢信息。
  const dropCityAnchor = paramCities.length > 0 && plan.near?.source === "city";

  return {
    ...plan,
    near: dropCityAnchor ? null : plan.near,
    radiusKm: dropCityAnchor ? null : plan.radiusKm,
    cities: paramCities.length > 0 ? paramCities : plan.cities,
    bedroomsAnyOf:
      paramBeds.length > 0 ? [...new Set(paramBeds)] : plan.bedroomsAnyOf,
    rentMin: params.rentMin ?? plan.rentMin,
    rentMax: params.rentMax ?? plan.rentMax,
    leaseMonthsMin: params.leaseMonthsMin ?? plan.leaseMonthsMin,
    leaseMonthsMax: params.leaseMonthsMax ?? plan.leaseMonthsMax,
    requires: {
      petFriendly: params.petFriendly ?? plan.requires.petFriendly,
      couplesOk: params.couplesOk ?? plan.requires.couplesOk,
      utilitiesIncluded:
        params.utilitiesIncluded ?? plan.requires.utilitiesIncluded,
      parkingIncluded: params.parkingIncluded ?? plan.requires.parkingIncluded,
    },
  };
}

// ── LLM 计划 ────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `你是湾区租房搜索的查询理解层。把租客的自然语言需求翻译成一个 JSON 检索计划。

最重要的两条：

1. **硬性要求 vs 偏好**。只有"必须/需要/一定要"级别的条件才进硬字段；凡是
   "最好/优先/理想/如果有更好/prefer"，一律只进 prefers 数组，绝不进硬字段。
   判错方向的代价不对称：把偏好当硬条件会把用户明明接受的房源全部筛掉。

2. **列了备选就全部列出，不要放弃**。用户说"Dublin优先，San Ramon也可以" →
   cities: ["Dublin","San Ramon"]；说"1b1b或studio都行" → bedroomsAnyOf: [1,0]。
   数组是"或"的关系。只有在真的无从判断时才留空数组。

字段规则：

- cities：可接受城市的**标准英文名**。用你的世界知识把小区名、公寓名、地标、
  公司、学校、邮编、街道、社区解析成城市：SOMA/Mission/Noe Valley→San Francisco，
  Moffett Park→Sunnyvale，UCB→Berkeley，Stanford→Palo Alto，94583→San Ramon，
  TikTok/字节→San Jose，Meta→Menlo Park，NVIDIA→Santa Clara。
  地点线索是公司/学校/地标（用户要的是"附近"、"通勤方便"，不是某个市界内）→
  **把通勤可达的相邻城市一起列进去**："公司在TikTok" → ["San Jose","Santa Clara",
  "Sunnyvale"]；"UCB附近" → ["Berkeley","Oakland","Albany","Emeryville"]。
  用户自己点名城市时则不要擅自扩散。
  只说了大区（"南湾"/"东湾"/"半岛"/"三谷"）而没点名城市 → cities 留空，
  改填 regions（取值：sf / peninsula / south / east / tri-valley / north /
  santa-cruz）。**"湾区"/"Bay Area"/"不限区域"是整个收录范围，不是区域词：
  这时 cities 和 regions 都留空**，填满七个区域等于什么都没筛还顺手排除了
  没写明城市的房源。
- anchors：用户点名的小区/公寓/楼盘/地标原文（"Elan at River Oaks"、
  "the Hadley"、"Page Mill Rd"）。它只用来排序加权，不做过滤，宁可多填。
- nearPlace：用户明确说要"靠近/附近/走路可到/通勤到"的**那一个**地点，
  写成**适合拿去查地图的字符串**：原文 + 你知道的补充信息，例如
  "GENERSIS AI" → "Genesis AI, Palo Alto"（拼写按你的判断纠正），
  "公司在94583" → "94583"，"步行到Meta" → "Meta Menlo Park"。
  **你不认识这个地方就照抄原文，不要编造城市**——下游会去查地图，查不到会
  反问用户。**宁可让 cities 空着也不要拿猜的城市去填**，猜错的地点比没有地点
  更糟：用户会拿到一堆二三十公里外的房源还以为系统听懂了。
  用户没说"靠近某处"就填 null。
- nearMode：靠近的方式 —— "walk" / "bike" / "transit" / "drive"，
  说不清就 null。决定可接受半径，别乱填。
- outOfScope：需求明显不在旧金山湾区（西雅图、纽约、匹兹堡/CMU、温哥华列治文、
  科罗拉多、洛杉矶、圣地亚哥…）→ true 并写明原因。注意同名陷阱：
  Richmond 既是湾区城市也是温哥华的列治文，Frisco 可能是科罗拉多，
  Pittsburg（无 h）是湾区城市而 Pittsburgh 是宾州——按上下文判断。
- bedroomsAnyOf：**整套单元**的卧室数（studio=0，1B1B=1，2B2B=2）。
  "想租2B2B里的一间"→[2]。**如果用户给的备选里含有无法用卧室数表达的选项
  （"合租也行"、"单间"、"什么都可以"），就留空数组**——用不完整的集合硬过滤
  等于误杀。用户完全没提户型也留空。
- rentMin/rentMax：月租美元。合租按**每人**的租金理解。只有用户真的说了预算
  才填。"预算3k以下"→rentMax:3000。**只有钱才是钱**：面积（800+sqft、
  四百尺、平方英尺）、邮编（94085）、门牌、电话、房号里的数字一律不是预算，
  绝不能填进来。
- leaseMonthsMin/leaseMonthsMax：打算住多久（月）。"长租一年"→min:12；
  裸"长租"→min:6；"短租3个月"→min:3,max:3；裸"短租"→max:6；
  "8月底到12月初"→按日期折算 max:4。长短租都行 → 都留 null。
- moveIn：租客**最晚**能接受的入住日 "YYYY-MM-DD"，也就是"过了这天就来不及"。
  硬约束是"房源可入住日 ≤ 这一天"，所以：
  · 给了区间（"9月初到9月中都行"）→ 填**最晚**那天（9-15）。
  · 只给了一个起始日（"8/24即可入住"、"9月开始起租"、"随时可搬"）→ 填 null，
    因为租客并没有说出任何截止日，晚一点的房源他照样能接受；填成 8-24 会把
    8-25 起租的房源误杀。
  · 明确的截止（"9月12日必须入住"、"9月中之前"）→ 填那一天。
  今年是 2026 年。
- requires：四个布尔硬需求，只有"必须有"才填 true，否则填 null。
  "最好有车位"→null（进 prefers）。"我不养宠物"→null（那是自述，不是需求）。
- prefers：其余所有软性/无法结构化的期望原文短语（"独立卫浴"、"女生室友"、
  "in-unit laundry"、"安静干净"、"交通方便"）。
- excludes：出现即淘汰的词（"中介"、"二房东"）。用户没明说排斥就留空。

只输出一个 JSON 对象，不要代码围栏、不要任何解释文字：
{"outOfScope":false,"outOfScopeReason":null,"cities":[],"regions":[],"anchors":[],"nearPlace":null,"nearMode":null,"rentMin":null,"rentMax":null,"bedroomsAnyOf":[],"leaseMonthsMin":null,"leaseMonthsMax":null,"moveIn":null,"requires":{"petFriendly":null,"couplesOk":null,"utilitiesIncluded":null,"parkingIncluded":null},"prefers":[],"excludes":[]}`;

const JSON_BLOCK_RE = /\{[\s\S]*\}/;
const REGION_VALUES: BayRegion[] = [
  "sf",
  "peninsula",
  "south",
  "east",
  "tri-valley",
  "north",
  "santa-cruz",
];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type RawPlan = Record<string, unknown>;

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s.length > 0 && s.length <= 80 && !out.includes(s)) {
      out.push(s);
    }
  }
  return out.slice(0, max);
}

function asRent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= PLAUSIBLE_RENT_MIN && n <= PLAUSIBLE_RENT_MAX ? n : null;
}

function asMonths(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= 1 && n <= 60 ? n : null;
}

function asBool(value: unknown): boolean | null {
  return value === true ? true : null;
}

function asMoveIn(value: unknown): FlexibleDate | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (s === "asap") return { kind: "asap" };
  if (ISO_DATE_RE.test(s)) return { kind: "date", iso: s };
  return null;
}

/**
 * LLM 原始 JSON → QueryPlan，逐字段校验，任何不可信的值一律降级成"没有约束"。
 * 故意**不**回退到正则基线：LLM 解析成功时它说的 null 是有意义的
 * （"用户没给这个条件"），拿正则值填回去会把已经修掉的误杀重新塞进来。
 */
function coercePlan(raw: RawPlan, query: string): QueryPlan {
  const regions = asStringArray(raw.regions, REGION_VALUES.length).filter(
    (r): r is BayRegion => (REGION_VALUES as string[]).includes(r)
  );
  // 模型有时不勾 outOfScope，而是老老实实把域外城市填进 cities（实测
  // "离匹兹堡大学近的…奥克兰也行" → cities:["Pittsburgh"]）。城市名本身就能
  // 证伪：不在城市表里、又命中域外名单 → 这条需求我们没有收录。
  const rawCities = normalizeCities(asStringArray(raw.cities, MAX_CITIES));
  const outOfCoverage = rawCities.filter(
    (c) => !cityByName(c) && NON_BAY_CITY_RE.test(c)
  );
  const namedCities = rawCities.filter((c) => !outOfCoverage.includes(c));
  const fromRegions = citiesInRegions(regions);
  // 兜底守卫：模型偶尔会把"湾区找房"填成全部七个区域。展开出来的城市集合
  // 覆盖了大半张表时，它表达的是"整个收录范围"而不是一个约束——真拿它去筛，
  // 唯一效果是把 city 列缺失的房源全部排除，纯粹的误杀。
  const wholeBay = fromRegions.length > CITY_TABLE.length * BAY_WIDE_RATIO;
  const cities =
    namedCities.length > 0 ? namedCities : wholeBay ? [] : fromRegions;

  const beds = Array.isArray(raw.bedroomsAnyOf)
    ? [
        ...new Set(
          raw.bedroomsAnyOf.filter(
            (n): n is number => Number.isInteger(n) && n >= 0 && n <= 5
          )
        ),
      ].slice(0, MAX_BEDROOMS)
    : [];

  const requires = (raw.requires ?? {}) as RawPlan;
  const leaseMin = asMonths(raw.leaseMonthsMin);
  const leaseMax = asMonths(raw.leaseMonthsMax);

  // 点名的城市全部在收录范围外 = 这条需求本身就不在湾区。
  const allOutOfCoverage = outOfCoverage.length > 0 && namedCities.length === 0;
  // 新西兰要在这里单独兜一道：模型看到"奥克兰"就认成 Oakland（它没错，中文里
  // 两个城市同名），所以指望 raw.outOfScope 是指望不上的。正则基线那条路
  // （planFromRegex）已经判了，但 LLM 成功时整份 plan 都来自模型，基线的判断
  // 就被丢掉了——实测"离奥克兰大学近一点"因此拿到了一整页新西兰房源。
  const nzAmbiguity = isNewZealandText(query);
  const outOfScope = raw.outOfScope === true || allOutOfCoverage || nzAmbiguity;

  return {
    outOfScope,
    outOfScopeReason: outOfScope
      ? typeof raw.outOfScopeReason === "string" && raw.outOfScopeReason.trim()
        ? raw.outOfScopeReason.trim().slice(0, 120)
        : nzAmbiguity
        ? "「奥克兰」在这里指新西兰 Auckland，不在旧金山湾区收录范围内"
        : `${outOfCoverage.join("、")} 不在旧金山湾区收录范围内`
      : null,
    cities,
    regions,
    anchors: asStringArray(raw.anchors, MAX_ANCHORS),
    // near 的解析要联网（可能），放到 planQuery 里做；这里只把原始诉求带出来。
    near: null,
    nearQuery:
      typeof raw.nearPlace === "string" && raw.nearPlace.trim()
        ? raw.nearPlace.trim().slice(0, 120)
        : null,
    nearUnresolved: null,
    radiusKm:
      typeof raw.nearMode === "string"
        ? (RADIUS_KM[raw.nearMode.trim().toLowerCase()] ?? DEFAULT_RADIUS_KM)
        : DEFAULT_RADIUS_KM,
    rentMin: asRent(raw.rentMin),
    rentMax: asRent(raw.rentMax),
    bedroomsAnyOf: beds,
    // min>max 是自相矛盾的提取（多见于长短租双档表述），两边都作废，
    // 别拿一个不可能满足的区间去筛（listing 侧同款防御见 search-rental.ts）。
    leaseMonthsMin:
      leaseMin != null && leaseMax != null && leaseMin > leaseMax
        ? null
        : leaseMin,
    leaseMonthsMax:
      leaseMin != null && leaseMax != null && leaseMin > leaseMax
        ? null
        : leaseMax,
    // LLM 解析成功时它的 null 是有意义的（"用户没有给截止日"），不能回退到
    // 正则基线——正则会把"8/24即可入住"当成硬截止，正是要修的那个误杀。
    moveIn: asMoveIn(raw.moveIn) ?? { kind: "unknown" },
    requires: {
      petFriendly: asBool(requires.petFriendly),
      couplesOk: asBool(requires.couplesOk),
      utilitiesIncluded: asBool(requires.utilitiesIncluded),
      parkingIncluded: asBool(requires.parkingIncluded),
    },
    prefers: asStringArray(raw.prefers, MAX_PREFERS),
    excludes: asStringArray(raw.excludes, MAX_PREFERS),
    source: "llm",
  };
}

// 同一条查询在一次搜索里会被问两次（运行时 + 评测 ground truth），评测更是
// 反复跑同一批查询——缓存把计划变成"每条查询一次 LLM 调用"。
const planCache = new Map<string, QueryPlan>();

function cacheGet(key: string): QueryPlan | undefined {
  return planCache.get(key);
}

function cacheSet(key: string, plan: QueryPlan): void {
  if (planCache.size >= PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) {
      planCache.delete(oldest);
    }
  }
  planCache.set(key, plan);
}

/** 测试/评测用：清空进程内计划缓存。 */
export function clearPlanCache(): void {
  planCache.clear();
}

async function planWithLlm(query: string): Promise<QueryPlan> {
  const { text } = await generateText({
    model: getQueryPlannerModel(),
    system: PLANNER_SYSTEM,
    prompt: `【今天】${new Date().toISOString().slice(0, 10)}\n【租客需求原文】\n${query.slice(0, 2000)}`,
    temperature: 0,
    abortSignal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
  });
  const match = text.match(JSON_BLOCK_RE);
  if (!match) {
    throw new Error(`planner returned no JSON object: ${text.slice(0, 200)}`);
  }
  return coercePlan(JSON.parse(match[0]) as RawPlan, query);
}

/**
 * 查询 → 检索计划。运行时与评测共用的**唯一**理解入口。
 *
 * 顺序：正则基线 → LLM 覆盖（失败则保留基线）→ 聊天模型显式参数覆盖。
 * 聊天模型放最后是因为它看得见整段对话历史，比只看单条 query 的两层都可靠。
 */
export async function planQuery(
  query: string,
  params: PlanParams = {}
): Promise<QueryPlan> {
  const base = planFromRegex(query);
  if (PLANNER_OFF) {
    return applyParams(base, params);
  }
  const key = query.trim();
  const cached = cacheGet(key);
  if (cached) {
    return applyParams(cached, params);
  }

  let plan = base;
  try {
    plan = await planWithLlm(query);
  } catch (error) {
    // fail-open：理解层挂了就用正则基线继续搜，绝不让搜索整体失败。
    // 注意只打印 name/message —— AI SDK 的错误对象丢给 console.error 会让
    // node util.inspect 自身抛 TypeError（AGENT_LOG 2026-08-15 §调试史 4）。
    const e = error as Error;
    console.error(`[planQuery] fail-open (${e.name}): ${e.message}`);
  }
  plan = await resolveNear(plan, query);
  cacheSet(key, plan);
  return applyParams(plan, params);
}

/**
 * "靠近X" → 坐标。静态表（邮编/地标/城市，免费瞬时）优先，落空才去 Google
 * 地理编码（要 key）。两边都落空 → nearUnresolved，聊天层据此**反问用户**
 * 而不是拿猜的城市糊弄过去。
 *
 * 解析成功时把城市集合清空：距离约束比"在不在市界内"精确得多，而且理解层给的
 * 城市在这种句子里往往是猜的——用户实测那次 "靠近GENERSIS AI" 就被猜成了
 * San Jose/Santa Clara/Sunnyvale，而 Genesis AI 在 Palo Alto。
 */
async function resolveNear(plan: QueryPlan, query: string): Promise<QueryPlan> {
  if (!plan.nearQuery) return plan;
  const point =
    staticPlacePoint(plan.nearQuery) ??
    (await geocodePlace(plan.nearQuery)) ??
    // 最后一搏：整条查询里也许有邮编/地标是 nearPlace 字段没带上的。
    staticPlacePoint(query);
  if (!point) {
    return { ...plan, nearUnresolved: plan.nearQuery, radiusKm: null };
  }
  return { ...plan, near: point, cities: [] };
}

// ── 排序 / 终审用的派生物 ───────────────────────────────────────────────────

/**
 * 给语义 rerank 用的查询文本：原文 + 计划里抽出的地点锚点与偏好。
 * 偏好进不了硬筛选，但**必须**影响排序，否则"最好有独卫"就等于没说。
 */
export function rerankQueryFor(query: string, plan: QueryPlan): string {
  const extras = [...plan.anchors, ...plan.cities, ...plan.prefers];
  return extras.length > 0 ? `${query}\n关注：${extras.join("、")}` : query;
}

/** 计划里所有偏好的合并文本，供终审提示与人工日志使用。 */
export function planSummary(plan: QueryPlan): string {
  const parts: string[] = [];
  if (plan.near) {
    parts.push(
      `靠近=${plan.near.label}(${plan.near.source},${plan.radiusKm}km)`
    );
  }
  if (plan.nearUnresolved) parts.push(`靠近?=${plan.nearUnresolved}(定位失败)`);
  if (plan.cities.length > 0) parts.push(`城市=${plan.cities.join("/")}`);
  if (plan.regions.length > 0) parts.push(`区域=${plan.regions.join("/")}`);
  if (plan.rentMin != null || plan.rentMax != null) {
    parts.push(`预算=${plan.rentMin ?? ""}-${plan.rentMax ?? ""}`);
  }
  if (plan.bedroomsAnyOf.length > 0) {
    parts.push(`户型=${plan.bedroomsAnyOf.join("/")}`);
  }
  if (plan.leaseMonthsMin != null || plan.leaseMonthsMax != null) {
    parts.push(
      `租期=${plan.leaseMonthsMin ?? ""}-${plan.leaseMonthsMax ?? ""}月`
    );
  }
  if (plan.moveIn.kind !== "unknown") {
    parts.push(
      `入住=${plan.moveIn.kind === "asap" ? "随时" : plan.moveIn.iso}`
    );
  }
  for (const [k, v] of Object.entries(plan.requires)) {
    if (v === true) parts.push(k);
  }
  if (plan.anchors.length > 0) parts.push(`锚点=${plan.anchors.join("/")}`);
  if (plan.prefers.length > 0) parts.push(`偏好=${plan.prefers.join("/")}`);
  return parts.join(" ") || "(无约束)";
}
