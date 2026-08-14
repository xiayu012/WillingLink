/**
 * Shared Bay Area city intelligence.
 *
 * City is treated as a SOFT, neighbour-aware signal everywhere — never a strict
 * equality filter. A human asking for "San Jose" is happily served a listing in
 * Santa Clara or Milpitas; refusing those would be the dumb behaviour. Both the
 * in-app search (geo-expanded vector query) and the GPT route (neighbour-aware
 * region filter) build on this one table so they stay consistent.
 */

export type CityEntry = {
  re: RegExp;
  en: string;
  zh: string;
  neighbors: string[]; // ≤3 adjacent cities
};

export const CITY_TABLE: CityEntry[] = [
  {
    re: /圣何塞|圣荷塞|圣荷西|圣何西|San\s*Jose/i,
    en: "San Jose",
    zh: "圣何塞",
    neighbors: ["Santa Clara", "Milpitas", "Sunnyvale"],
  },
  {
    re: /旧金山|三藩市|三番市|San\s*Francisco|\bSF\b/i,
    en: "San Francisco",
    zh: "旧金山",
    neighbors: ["Daly City", "South San Francisco", "Oakland"],
  },
  {
    re: /伯克利|柏克利|柏克莱|Berkeley/i,
    en: "Berkeley",
    zh: "伯克利",
    neighbors: ["Oakland", "Albany", "Emeryville"],
  },
  {
    re: /奥克兰|屋仑|Oakland/i,
    en: "Oakland",
    zh: "奥克兰",
    neighbors: ["Berkeley", "Emeryville", "San Leandro"],
  },
  {
    re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i,
    en: "Palo Alto",
    zh: "帕洛阿尔托",
    neighbors: ["Menlo Park", "Mountain View", "Los Altos"],
  },
  {
    re: /山景城|Mountain\s*View/i,
    en: "Mountain View",
    zh: "山景城",
    neighbors: ["Sunnyvale", "Palo Alto", "Los Altos"],
  },
  {
    re: /桑尼维尔|森尼韦尔|Sunnyvale/i,
    en: "Sunnyvale",
    zh: "桑尼维尔",
    neighbors: ["Santa Clara", "Mountain View", "Cupertino"],
  },
  {
    re: /弗里蒙特|菲利蒙|费利蒙|Fremont/i,
    en: "Fremont",
    zh: "弗里蒙特",
    neighbors: ["Newark", "Union City", "Milpitas"],
  },
  {
    re: /圣克拉拉|圣塔克拉拉|Santa\s*Clara/i,
    en: "Santa Clara",
    zh: "圣克拉拉",
    neighbors: ["Sunnyvale", "San Jose", "Cupertino"],
  },
  {
    re: /苗必达|米尔皮塔斯|Milpitas/i,
    en: "Milpitas",
    zh: "苗必达",
    neighbors: ["San Jose", "Fremont", "Santa Clara"],
  },
  {
    re: /海沃德|海沃|Hayward/i,
    en: "Hayward",
    zh: "海沃德",
    neighbors: ["Union City", "San Leandro", "Fremont"],
  },
  {
    re: /纽瓦克|Newark/i,
    en: "Newark",
    zh: "纽瓦克",
    neighbors: ["Fremont", "Union City", "Milpitas"],
  },
  {
    re: /联合市|Union\s*City/i,
    en: "Union City",
    zh: "联合市",
    neighbors: ["Fremont", "Hayward", "Newark"],
  },
  {
    re: /戴利城|Daly\s*City/i,
    en: "Daly City",
    zh: "戴利城",
    neighbors: ["San Francisco", "South San Francisco", "Colma"],
  },
  {
    re: /库比蒂诺|库柏蒂诺|Cupertino/i,
    en: "Cupertino",
    zh: "库比蒂诺",
    neighbors: ["Sunnyvale", "Santa Clara", "Saratoga"],
  },
  {
    re: /圣马特奥|圣马刁|San\s*Mateo/i,
    en: "San Mateo",
    zh: "圣马特奥",
    neighbors: ["Foster City", "Burlingame", "Redwood City"],
  },
  {
    re: /红木城|Redwood\s*City/i,
    en: "Redwood City",
    zh: "红木城",
    neighbors: ["San Carlos", "Menlo Park", "San Mateo"],
  },
  {
    re: /圣克鲁斯|Santa\s*Cruz/i,
    en: "Santa Cruz",
    zh: "圣克鲁斯",
    neighbors: ["Capitola", "Scotts Valley", "Aptos"],
  },
];

/** Detect a Bay Area city mentioned anywhere in a free-text string. */
export function detectCity(text: string): CityEntry | null {
  for (const entry of CITY_TABLE) {
    if (entry.re.test(text)) return entry;
  }
  return null;
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
 * The ≤3 neighbouring cities for a city named in English or Chinese.
 * Returns [] when the city isn't in the table (unknown → no expansion).
 */
export function neighborsOf(cityName: string | null | undefined): string[] {
  if (!cityName) return [];
  const trimmed = cityName.trim();
  for (const entry of CITY_TABLE) {
    if (
      entry.en.toLowerCase() === trimmed.toLowerCase() ||
      entry.zh === trimmed ||
      entry.re.test(trimmed)
    ) {
      return entry.neighbors;
    }
  }
  return [];
}

/**
 * Plain-text alias strings for a city — every spelling a post might use, in
 * English AND Chinese. Derived from the entry's detection regex so the two
 * never drift: "圣何塞|圣荷塞|San\s*Jose" → ["圣何塞", "圣荷塞", "San Jose"].
 *
 * WHY: city keyword search must match Chinese-only posts. Matching only the
 * English canonical name ("San Jose") silently misses every post that wrote
 * "圣何塞" and nothing else — a large fraction of the real data.
 */
export function cityAliases(entry: CityEntry): string[] {
  const terms = entry.re.source
    .split("|")
    .map((s) =>
      s
        .replace(/\\s\*/g, " ") // \s* → single space (regex → literal)
        .replace(/\\b/g, "") // drop word boundaries
        .replace(/[()]/g, "") // drop grouping
        .trim()
    )
    // Drop 1–2 letter ASCII abbreviations ("SF"): safe for boundary-anchored
    // detectCity, but as a raw ILIKE '%SF%' substring they match "tran*sf*er"
    // and friends. Chinese aliases are kept (CJK never sits inside a word).
    .filter((s) => s.length > 0 && !/^[A-Za-z]{1,2}$/.test(s));
  // Guarantee the canonical English + Chinese names are present.
  return [...new Set([entry.en, entry.zh, ...terms])];
}

/**
 * Cities/metros clearly OUTSIDE the Bay Area. When a query names one of these
 * and no Bay Area city, the database provably has nothing for it — strict
 * search should answer "没有" instead of returning an unrelated Bay listing.
 * (Shared with the eval harness so verdicts and runtime behavior agree.)
 */
export const NON_BAY_CITY_RE =
  /西雅图|seattle|芝加哥|chicago|纽约|new\s*york|nyc|洛杉矶|los\s*angeles|圣地亚哥|san\s*diego|波士顿|boston|奥斯汀|austin|尔湾|irvine|拉斯维加斯|vegas|达拉斯|dallas|休斯顿|houston|费城|philadelphia|亚特兰大|atlanta|凤凰城|phoenix|丹佛|denver|波特兰|portland|盐湖城|salt\s*lake|\bucla\b|westwood|sawtelle|圣盖博|san\s*gabriel|temple\s*city|上东区?|上西区?|\blic\b|长岛市|佐治亚理工|georgia\s*tech|\busc\b|圣塔莫尼卡|santa\s*monica/i;

/** True when the query targets a non-Bay metro and names no Bay Area city. */
export function isOutOfBayQuery(query: string): boolean {
  return !detectCity(query) && NON_BAY_CITY_RE.test(query);
}
