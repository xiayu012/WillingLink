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
  { re: /圣何塞|San\s*Jose/i,             en: "San Jose",       zh: "圣何塞",    neighbors: ["Santa Clara", "Milpitas", "Sunnyvale"] },
  { re: /旧金山|三藩市|San\s*Francisco/i,  en: "San Francisco",  zh: "旧金山",    neighbors: ["Daly City", "South San Francisco", "Oakland"] },
  { re: /伯克利|Berkeley/i,               en: "Berkeley",       zh: "伯克利",    neighbors: ["Oakland", "Albany", "Emeryville"] },
  { re: /奥克兰|Oakland/i,                en: "Oakland",        zh: "奥克兰",    neighbors: ["Berkeley", "Emeryville", "San Leandro"] },
  { re: /帕罗奥图|帕洛阿尔托|Palo\s*Alto/i, en: "Palo Alto",    zh: "帕洛阿尔托", neighbors: ["Menlo Park", "Mountain View", "Los Altos"] },
  { re: /山景城|Mountain\s*View/i,        en: "Mountain View",  zh: "山景城",    neighbors: ["Sunnyvale", "Palo Alto", "Los Altos"] },
  { re: /桑尼维尔|Sunnyvale/i,            en: "Sunnyvale",      zh: "桑尼维尔",   neighbors: ["Santa Clara", "Mountain View", "Cupertino"] },
  { re: /弗里蒙特|Fremont/i,              en: "Fremont",        zh: "弗里蒙特",   neighbors: ["Newark", "Union City", "Milpitas"] },
  { re: /圣克拉拉|Santa\s*Clara/i,        en: "Santa Clara",    zh: "圣克拉拉",   neighbors: ["Sunnyvale", "San Jose", "Cupertino"] },
  { re: /戴利城|Daly\s*City/i,            en: "Daly City",      zh: "戴利城",    neighbors: ["San Francisco", "South San Francisco", "Colma"] },
  { re: /库比蒂诺|Cupertino/i,            en: "Cupertino",      zh: "库比蒂诺",   neighbors: ["Sunnyvale", "Santa Clara", "Saratoga"] },
  { re: /圣马特奥|San\s*Mateo/i,          en: "San Mateo",      zh: "圣马特奥",   neighbors: ["Foster City", "Burlingame", "Redwood City"] },
  { re: /红木城|Redwood\s*City/i,         en: "Redwood City",   zh: "红木城",    neighbors: ["San Carlos", "Menlo Park", "San Mateo"] },
  { re: /圣克鲁斯|Santa\s*Cruz/i,         en: "Santa Cruz",     zh: "圣克鲁斯",   neighbors: ["Capitola", "Scotts Valley", "Aptos"] },
];

/** Detect a Bay Area city mentioned anywhere in a free-text string. */
export function detectCity(text: string): CityEntry | null {
  for (const entry of CITY_TABLE) {
    if (entry.re.test(text)) return entry;
  }
  return null;
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
