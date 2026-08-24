/**
 * Shared Bay Area geography.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS
 * ---------------------------------
 * Measured on 216 real 求租帖 (2026-08-23): the old 18-city table detected NO
 * city at all in 109 of them (50%) and detected several in another 51 (24%,
 * which the strict path then dropped entirely). So half of all searches ran
 * with no location constraint whatsoever and happily answered a Dublin request
 * with San Jose listings. Covering the place vocabulary people actually use —
 * 70+ cities, region words (南湾/东湾/半岛/三谷), SF neighbourhoods — is the
 * single highest-leverage geography fix available, so cities are declared as
 * data (aliases + regions) and every regex is generated from that declaration.
 *
 * Detection is longest-alias-first, which is what makes "South San Francisco"
 * and "East Palo Alto" resolve to themselves instead of to their substrings.
 */

export type BayRegion =
  | "sf"
  | "peninsula"
  | "south"
  | "east"
  | "tri-valley"
  | "north"
  | "santa-cruz";

type CityDef = {
  en: string;
  zh: string;
  /** Every spelling a post or query might use (EN + ZH). `en`/`zh` implied. */
  aliases?: string[];
  neighbors: string[];
  regions: BayRegion[];
};

// Detection does NOT depend on this order (longest alias wins), only on the
// alias sets. Grouped by region purely for human readability.
const CITY_DEFS: CityDef[] = [
  // ── 南湾 South Bay ────────────────────────────────────────────────────────
  {
    en: "San Jose",
    zh: "圣何塞",
    aliases: ["圣荷塞", "圣荷西", "圣何西", "San Jose", "SJ", "SJSU"],
    neighbors: ["Santa Clara", "Milpitas", "Sunnyvale"],
    regions: ["south"],
  },
  {
    en: "Santa Clara",
    zh: "圣克拉拉",
    aliases: ["圣塔克拉拉", "圣塔克拉", "SCU"],
    neighbors: ["Sunnyvale", "San Jose", "Cupertino"],
    regions: ["south"],
  },
  {
    en: "Sunnyvale",
    zh: "桑尼维尔",
    aliases: ["森尼韦尔", "阳谷", "Moffett Park"],
    neighbors: ["Santa Clara", "Mountain View", "Cupertino"],
    regions: ["south"],
  },
  {
    en: "Mountain View",
    zh: "山景城",
    aliases: ["山景市", "Mtn View"],
    neighbors: ["Sunnyvale", "Palo Alto", "Los Altos"],
    regions: ["south", "peninsula"],
  },
  {
    en: "Cupertino",
    zh: "库比蒂诺",
    aliases: ["库柏蒂诺", "苹果城"],
    neighbors: ["Sunnyvale", "Santa Clara", "Saratoga"],
    regions: ["south"],
  },
  {
    en: "Milpitas",
    zh: "苗必达",
    aliases: ["米尔皮塔斯"],
    neighbors: ["San Jose", "Fremont", "Santa Clara"],
    regions: ["south", "east"],
  },
  {
    en: "Campbell",
    zh: "坎贝尔",
    neighbors: ["San Jose", "Los Gatos", "Saratoga"],
    regions: ["south"],
  },
  {
    en: "Los Gatos",
    zh: "洛斯加托斯",
    neighbors: ["Campbell", "Saratoga", "San Jose"],
    regions: ["south"],
  },
  {
    en: "Saratoga",
    zh: "萨拉托加",
    neighbors: ["Cupertino", "Campbell", "Los Gatos"],
    regions: ["south"],
  },
  {
    en: "Morgan Hill",
    zh: "摩根山",
    neighbors: ["San Jose", "Gilroy"],
    regions: ["south"],
  },
  {
    en: "Gilroy",
    zh: "吉尔罗伊",
    neighbors: ["Morgan Hill", "San Jose"],
    regions: ["south"],
  },
  {
    en: "Los Altos",
    zh: "洛斯阿尔托斯",
    aliases: ["Los Altos Hills"],
    neighbors: ["Mountain View", "Palo Alto", "Sunnyvale"],
    regions: ["south", "peninsula"],
  },

  // ── 半岛 Peninsula ────────────────────────────────────────────────────────
  {
    en: "Palo Alto",
    zh: "帕洛阿尔托",
    aliases: ["帕罗奥图", "帕拉阿图", "帕洛阿托", "Stanford", "斯坦福"],
    neighbors: ["Menlo Park", "Mountain View", "Los Altos"],
    regions: ["peninsula", "south"],
  },
  {
    en: "East Palo Alto",
    zh: "东帕洛阿尔托",
    neighbors: ["Palo Alto", "Menlo Park", "Redwood City"],
    regions: ["peninsula"],
  },
  {
    en: "Menlo Park",
    zh: "门洛帕克",
    aliases: ["曼罗公园"],
    neighbors: ["Palo Alto", "Redwood City", "Atherton"],
    regions: ["peninsula"],
  },
  {
    en: "Redwood City",
    zh: "红木城",
    aliases: ["Redwood Shores"],
    neighbors: ["San Carlos", "Menlo Park", "San Mateo"],
    regions: ["peninsula"],
  },
  {
    en: "San Mateo",
    zh: "圣马特奥",
    aliases: ["圣马刁"],
    neighbors: ["Foster City", "Burlingame", "Redwood City"],
    regions: ["peninsula"],
  },
  {
    en: "Foster City",
    zh: "福斯特城",
    neighbors: ["San Mateo", "Belmont", "Redwood City"],
    regions: ["peninsula"],
  },
  {
    en: "Belmont",
    zh: "贝尔蒙特",
    neighbors: ["San Carlos", "San Mateo", "Redwood City"],
    regions: ["peninsula"],
  },
  {
    en: "San Carlos",
    zh: "圣卡洛斯",
    neighbors: ["Belmont", "Redwood City", "San Mateo"],
    regions: ["peninsula"],
  },
  {
    en: "Burlingame",
    zh: "伯林盖姆",
    neighbors: ["San Mateo", "Millbrae", "Hillsborough"],
    regions: ["peninsula"],
  },
  {
    en: "Millbrae",
    zh: "米尔布雷",
    neighbors: ["Burlingame", "San Bruno", "San Mateo"],
    regions: ["peninsula"],
  },
  {
    en: "San Bruno",
    zh: "圣布鲁诺",
    neighbors: ["Millbrae", "South San Francisco", "Pacifica"],
    regions: ["peninsula"],
  },
  {
    en: "South San Francisco",
    zh: "南旧金山",
    aliases: ["SSF", "南三藩市"],
    neighbors: ["San Bruno", "Daly City", "Brisbane"],
    regions: ["peninsula"],
  },
  {
    en: "Daly City",
    zh: "戴利城",
    aliases: ["黛利城"],
    neighbors: ["San Francisco", "South San Francisco", "Colma"],
    regions: ["peninsula"],
  },
  {
    en: "Brisbane",
    zh: "布里斯班",
    neighbors: ["South San Francisco", "Daly City", "San Francisco"],
    regions: ["peninsula"],
  },
  {
    en: "Colma",
    zh: "科尔马",
    neighbors: ["Daly City", "South San Francisco"],
    regions: ["peninsula"],
  },
  {
    en: "Pacifica",
    zh: "太平洋城",
    neighbors: ["Daly City", "San Bruno", "Half Moon Bay"],
    regions: ["peninsula"],
  },
  {
    en: "Half Moon Bay",
    zh: "半月湾",
    neighbors: ["Pacifica", "Redwood City"],
    regions: ["peninsula"],
  },
  {
    en: "Atherton",
    zh: "阿瑟顿",
    neighbors: ["Menlo Park", "Redwood City", "Palo Alto"],
    regions: ["peninsula"],
  },

  // ── 旧金山 San Francisco ──────────────────────────────────────────────────
  {
    en: "San Francisco",
    zh: "旧金山",
    aliases: [
      "三藩市",
      "三番市",
      "舊金山",
      "SF",
      "SOMA",
      "Noe Valley",
      "Mission Bay",
      "Dogpatch",
      "Hayes Valley",
      "Nob Hill",
      "Russian Hill",
      "Rincon Hill",
      "Tenderloin",
      "Financial District",
      "FiDi",
      "Potrero Hill",
      "日落区",
      "教会区",
      "湾景区",
    ],
    neighbors: ["Daly City", "South San Francisco", "Oakland"],
    regions: ["sf"],
  },

  // ── 东湾 East Bay ─────────────────────────────────────────────────────────
  {
    en: "Oakland",
    zh: "奥克兰",
    aliases: ["屋仑", "Rockridge", "Temescal"],
    neighbors: ["Berkeley", "Emeryville", "San Leandro"],
    regions: ["east"],
  },
  {
    en: "Berkeley",
    zh: "伯克利",
    aliases: ["柏克利", "柏克莱", "UCB", "UC Berkeley"],
    neighbors: ["Oakland", "Albany", "Emeryville"],
    regions: ["east"],
  },
  {
    en: "Emeryville",
    zh: "埃默里维尔",
    neighbors: ["Berkeley", "Oakland", "Albany"],
    regions: ["east"],
  },
  {
    en: "Albany",
    zh: "阿尔巴尼",
    neighbors: ["Berkeley", "El Cerrito", "Emeryville"],
    regions: ["east"],
  },
  {
    en: "El Cerrito",
    zh: "埃尔塞里托",
    neighbors: ["Albany", "Richmond", "Berkeley"],
    regions: ["east"],
  },
  {
    en: "Richmond",
    zh: "里士满",
    aliases: ["Point Richmond"],
    neighbors: ["El Cerrito", "San Pablo", "Albany"],
    regions: ["east"],
  },
  {
    en: "San Pablo",
    zh: "圣巴勃罗",
    neighbors: ["Richmond", "El Sobrante", "Pinole"],
    regions: ["east"],
  },
  {
    en: "El Sobrante",
    zh: "埃尔索布兰特",
    neighbors: ["San Pablo", "Richmond", "Pinole"],
    regions: ["east"],
  },
  {
    en: "Pinole",
    zh: "皮诺尔",
    neighbors: ["San Pablo", "Hercules", "El Sobrante"],
    regions: ["east"],
  },
  {
    en: "Hercules",
    zh: "赫拉克勒斯",
    neighbors: ["Pinole", "Martinez", "Vallejo"],
    regions: ["east"],
  },
  {
    en: "Alameda",
    zh: "阿拉米达",
    neighbors: ["Oakland", "San Leandro", "Emeryville"],
    regions: ["east"],
  },
  {
    en: "Piedmont",
    zh: "皮埃蒙特",
    neighbors: ["Oakland", "Berkeley"],
    regions: ["east"],
  },
  {
    en: "San Leandro",
    zh: "圣利安卓",
    aliases: ["圣林德罗"],
    neighbors: ["Oakland", "Hayward", "San Lorenzo"],
    regions: ["east"],
  },
  {
    en: "San Lorenzo",
    zh: "圣洛伦索",
    neighbors: ["San Leandro", "Hayward", "Castro Valley"],
    regions: ["east"],
  },
  {
    en: "Castro Valley",
    zh: "卡斯特罗谷",
    neighbors: ["Hayward", "San Lorenzo", "San Leandro"],
    regions: ["east"],
  },
  {
    en: "Hayward",
    zh: "海沃德",
    aliases: ["海沃", "CSUEB"],
    neighbors: ["Union City", "San Leandro", "Fremont"],
    regions: ["east"],
  },
  {
    en: "Union City",
    zh: "联合市",
    neighbors: ["Fremont", "Hayward", "Newark"],
    regions: ["east"],
  },
  {
    en: "Newark",
    zh: "纽瓦克",
    neighbors: ["Fremont", "Union City", "Milpitas"],
    regions: ["east"],
  },
  {
    en: "Fremont",
    zh: "弗里蒙特",
    aliases: ["菲利蒙", "费利蒙", "佛利蒙", "Warm Springs"],
    neighbors: ["Newark", "Union City", "Milpitas"],
    regions: ["east"],
  },
  {
    en: "Walnut Creek",
    zh: "核桃溪",
    neighbors: ["Pleasant Hill", "Lafayette", "Concord"],
    regions: ["east"],
  },
  {
    en: "Concord",
    zh: "康科德",
    neighbors: ["Walnut Creek", "Pleasant Hill", "Martinez"],
    regions: ["east"],
  },
  {
    en: "Pleasant Hill",
    zh: "普莱森特希尔",
    neighbors: ["Walnut Creek", "Concord", "Martinez"],
    regions: ["east"],
  },
  {
    en: "Martinez",
    zh: "马丁内斯",
    neighbors: ["Concord", "Pleasant Hill", "Hercules"],
    regions: ["east"],
  },
  {
    en: "Lafayette",
    zh: "拉斐特",
    neighbors: ["Walnut Creek", "Orinda", "Moraga"],
    regions: ["east"],
  },
  {
    en: "Orinda",
    zh: "奥林达",
    neighbors: ["Lafayette", "Moraga", "Berkeley"],
    regions: ["east"],
  },
  {
    en: "Moraga",
    zh: "莫拉加",
    neighbors: ["Lafayette", "Orinda", "Walnut Creek"],
    regions: ["east"],
  },
  {
    en: "Antioch",
    zh: "安条克",
    neighbors: ["Brentwood", "Pittsburg", "Oakley"],
    regions: ["east"],
  },
  {
    en: "Brentwood",
    zh: "布伦特伍德",
    neighbors: ["Antioch", "Oakley", "Discovery Bay"],
    regions: ["east"],
  },
  {
    // NOTE: "Pittsburg" (no H) is the Contra Costa city. "Pittsburgh"/"匹兹堡"
    // is Pennsylvania and lives in NON_BAY_CITY_RE — do not merge the two.
    en: "Pittsburg",
    zh: "匹兹堡市",
    neighbors: ["Antioch", "Concord", "Martinez"],
    regions: ["east"],
  },

  // ── 三谷 Tri-Valley (part of the East Bay, but named separately in posts) ──
  {
    en: "Dublin",
    zh: "都柏林",
    neighbors: ["Pleasanton", "San Ramon", "Livermore"],
    regions: ["east", "tri-valley"],
  },
  {
    en: "Pleasanton",
    zh: "普莱森顿",
    neighbors: ["Dublin", "Livermore", "San Ramon"],
    regions: ["east", "tri-valley"],
  },
  {
    en: "Livermore",
    zh: "利弗莫尔",
    neighbors: ["Pleasanton", "Dublin"],
    regions: ["east", "tri-valley"],
  },
  {
    en: "San Ramon",
    zh: "圣拉蒙",
    neighbors: ["Dublin", "Danville", "Pleasanton"],
    regions: ["east", "tri-valley"],
  },
  {
    en: "Danville",
    zh: "丹维尔",
    neighbors: ["San Ramon", "Alamo", "Walnut Creek"],
    regions: ["east", "tri-valley"],
  },

  // ── 北湾 North Bay ────────────────────────────────────────────────────────
  {
    en: "San Rafael",
    zh: "圣拉斐尔",
    neighbors: ["Novato", "Mill Valley", "Larkspur"],
    regions: ["north"],
  },
  {
    en: "Novato",
    zh: "诺瓦托",
    neighbors: ["San Rafael", "Petaluma"],
    regions: ["north"],
  },
  {
    en: "Mill Valley",
    zh: "米尔谷",
    neighbors: ["Sausalito", "San Rafael", "Corte Madera"],
    regions: ["north"],
  },
  {
    en: "Sausalito",
    zh: "索萨利托",
    neighbors: ["Mill Valley", "San Francisco"],
    regions: ["north"],
  },
  {
    en: "Vallejo",
    zh: "瓦列霍",
    neighbors: ["Benicia", "American Canyon", "Hercules"],
    regions: ["north"],
  },
  {
    en: "Napa",
    zh: "纳帕",
    neighbors: ["American Canyon", "Vallejo", "Yountville"],
    regions: ["north"],
  },
  {
    en: "Benicia",
    zh: "贝尼西亚",
    neighbors: ["Vallejo", "Martinez"],
    regions: ["north"],
  },
  {
    en: "Fairfield",
    zh: "费尔菲尔德",
    neighbors: ["Vacaville", "Suisun City", "Benicia"],
    regions: ["north"],
  },
  {
    en: "Petaluma",
    zh: "佩塔卢马",
    neighbors: ["Novato", "Rohnert Park", "Santa Rosa"],
    regions: ["north"],
  },
  {
    en: "Santa Rosa",
    zh: "圣罗莎",
    neighbors: ["Rohnert Park", "Petaluma", "Windsor"],
    regions: ["north"],
  },

  // ── 圣克鲁斯 Santa Cruz ───────────────────────────────────────────────────
  {
    en: "Santa Cruz",
    zh: "圣克鲁斯",
    aliases: ["UCSC"],
    neighbors: ["Capitola", "Scotts Valley", "Aptos"],
    regions: ["santa-cruz"],
  },
  {
    en: "Scotts Valley",
    zh: "斯科茨谷",
    neighbors: ["Santa Cruz", "Felton"],
    regions: ["santa-cruz"],
  },
];

// ── Alias → regex compilation ────────────────────────────────────────────────
// Regexes are DERIVED from the alias lists, never hand-written, so a city can
// never be detectable under one spelling and invisible under another.

const ASCII_ONLY_RE = /^[ -~]+$/;
const RE_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;
const WS_RE = /\s+/g;
const SHORT_ABBREV_RE = /^[A-Za-z]{1,2}$/;

function escapeRe(s: string): string {
  return s.replace(RE_SPECIAL_RE, "\\$&");
}

/** One alias → a pattern that tolerates flexible whitespace between words and
 *  requires word boundaries for ASCII (so "SF" never matches "transfer"). */
function aliasPattern(alias: string): string {
  const body = escapeRe(alias.trim()).replace(WS_RE, "\\s*");
  return ASCII_ONLY_RE.test(alias) ? `\\b${body}\\b` : body;
}

export type CityEntry = {
  re: RegExp;
  en: string;
  zh: string;
  neighbors: string[];
  regions: BayRegion[];
  aliases: string[];
};

export const CITY_TABLE: CityEntry[] = CITY_DEFS.map((d) => {
  const aliases = [...new Set([d.en, d.zh, ...(d.aliases ?? [])])];
  return {
    re: new RegExp(
      aliases
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(aliasPattern)
        .join("|"),
      "i"
    ),
    en: d.en,
    zh: d.zh,
    neighbors: d.neighbors,
    regions: d.regions,
    aliases,
  };
});

const BY_EN = new Map(CITY_TABLE.map((c) => [c.en.toLowerCase(), c]));

/**
 * Every alias across every city, longest first, as one scanning regex. Longest
 * first is what makes "South San Francisco" win over "San Francisco" and
 * "East Palo Alto" over "Palo Alto": at a given position the alternation picks
 * the longest branch, and the scan then resumes past the whole match.
 */
const ALL_ALIASES: { alias: string; city: CityEntry }[] = CITY_TABLE.flatMap(
  (city) => city.aliases.map((alias) => ({ alias, city }))
).sort((a, b) => b.alias.length - a.alias.length);

const SCAN_RE = new RegExp(
  ALL_ALIASES.map(({ alias }) => `(${aliasPattern(alias)})`).join("|"),
  "gi"
);

/** All distinct cities named in a text, in first-mention order. */
function scanCities(text: string): CityEntry[] {
  const found: CityEntry[] = [];
  SCAN_RE.lastIndex = 0;
  let m = SCAN_RE.exec(text);
  while (m !== null) {
    // Capture group i+1 corresponds to ALL_ALIASES[i].
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) {
        const city = ALL_ALIASES[i - 1].city;
        if (!found.includes(city)) {
          found.push(city);
        }
        break;
      }
    }
    m = SCAN_RE.exec(text);
  }
  return found;
}

/** Detect a Bay Area city mentioned anywhere in a free-text string. */
export function detectCity(text: string): CityEntry | null {
  return scanCities(text)[0] ?? null;
}

/** Look a city up by canonical English name (or any alias). */
export function cityByName(name: string | null | undefined): CityEntry | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return BY_EN.get(trimmed.toLowerCase()) ?? detectCity(trimmed);
}

// Region-wide phrases that EMBED a city name without meaning that city: "旧金山
// 湾区" (SF Bay Area) contains "旧金山", so a naive match tags every East/South
// Bay listing that calls itself "旧金山湾区" as San Francisco. Neutralize these
// before detecting a specific city.
const BAY_AREA_PHRASE_RE =
  /(旧金山|三藩市|三番市|sf)\s*(湾区|bay\s*area)|bay\s*area|海湾地区|湾区/gi;

/**
 * Like detectCity, but first strips region-wide "Bay Area" phrases so the city
 * embedded in "旧金山湾区" / "SF Bay Area" is not misread as San Francisco.
 * Use when resolving which city a listing/post actually sits in.
 */
export function detectCityStrict(text: string): CityEntry | null {
  return detectCity(text.replace(BAY_AREA_PHRASE_RE, " "));
}

/**
 * 查询/帖子里提到的所有不同城市（先中和"湾区"短语）。
 * 提到多个城市不再等于"放弃过滤"——见 query-plan.ts，它们构成一个 OR 集合。
 */
export function detectCities(text: string): CityEntry[] {
  return scanCities(text.replace(BAY_AREA_PHRASE_RE, " "));
}

// ── Regions ──────────────────────────────────────────────────────────────────

const REGION_PATTERNS: { region: BayRegion; re: RegExp }[] = [
  { region: "south", re: /南湾|南灣|south\s*bay|硅谷|矽谷|silicon\s*valley/i },
  { region: "east", re: /东湾|東灣|east\s*bay/i },
  { region: "north", re: /北湾|北灣|north\s*bay|马林郡|marin\b/i },
  { region: "peninsula", re: /半岛|半島|peninsula/i },
  { region: "tri-valley", re: /三谷|tri[-\s]?valley/i },
  {
    region: "sf",
    re: /(?:旧金山|三藩市|san\s*francisco|\bsf\b)\s*(?:市区|市中心|downtown|city)/i,
  },
];

/** Region words a query uses ("南湾"/"东湾"/"半岛"/"三谷"). */
export function detectRegions(text: string): BayRegion[] {
  return REGION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.region);
}

/** Canonical English city names belonging to any of the given regions. */
export function citiesInRegions(regions: BayRegion[]): string[] {
  if (regions.length === 0) return [];
  const set = new Set(regions);
  return CITY_TABLE.filter((c) => c.regions.some((r) => set.has(r))).map(
    (c) => c.en
  );
}

/**
 * The ≤3 neighbouring cities for a city named in English or Chinese.
 * Returns [] when the city isn't in the table (unknown → no expansion).
 */
export function neighborsOf(cityName: string | null | undefined): string[] {
  return cityByName(cityName)?.neighbors ?? [];
}

/**
 * Plain-text alias strings for a city — every spelling a post might use, in
 * English AND Chinese.
 *
 * WHY: city keyword search must match Chinese-only posts. Matching only the
 * English canonical name ("San Jose") silently misses every post that wrote
 * "圣何塞" and nothing else — a large fraction of the real data.
 *
 * 1–2 letter ASCII abbreviations ("SF", "SJ") are dropped: safe inside the
 * boundary-anchored detection regex, but as a raw ILIKE '%SF%' substring they
 * match "tran*sf*er" and friends.
 */
export function cityAliases(entry: CityEntry): string[] {
  return entry.aliases.filter((a) => !SHORT_ABBREV_RE.test(a));
}

/**
 * Cities/metros clearly OUTSIDE the Bay Area. When a query names one of these
 * and no Bay Area city, the database provably has nothing for it — strict
 * search should answer "没有" instead of returning an unrelated Bay listing.
 * (Shared with the eval harness so verdicts and runtime behavior agree.)
 *
 * 匹兹堡大学/Pittsburgh (PA) is here while Pittsburg (CA, no H) is a Bay city —
 * the trailing `h` and the word boundary are load-bearing. Same trap for
 * 列治文/Richmond BC vs Richmond CA: only the unambiguous alias is listed.
 */
export const NON_BAY_CITY_RE =
  /西雅图|西雅圖|seattle|芝加哥|chicago|纽约|new\s*york|nyc|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|波士顿|boston|奥斯汀|austin|尔湾|irvine|拉斯维加斯|vegas|达拉斯|dallas|休斯顿|houston|费城|philadelphia|亚特兰大|atlanta|凤凰城|phoenix|丹佛|denver|波特兰|portland|盐湖城|salt\s*lake|\bucla\b|westwood|sawtelle|圣盖博|san\s*gabriel|temple\s*city|上东区?|上西区?|\blic\b|长岛市|佐治亚理工|georgia\s*tech|\busc\b|圣塔莫尼卡|santa\s*monica|匹兹堡大学|匹兹堡生活|\bpittsburgh\b|\bcmu\b|卡内基梅隆|松鼠山|温哥华|vancouver|列治文|多伦多|toronto|科罗拉多|colorado|安娜堡|ann\s*arbor|\bnyu\b|哥伦比亚大学|普林斯顿|princeton|康奈尔|cornell|奥克兰大学|university\s*of\s*auckland/i;

/** True when the query targets a non-Bay metro and names no Bay Area city. */
export function isOutOfBayQuery(query: string): boolean {
  return !detectCityStrict(query) && NON_BAY_CITY_RE.test(query);
}
