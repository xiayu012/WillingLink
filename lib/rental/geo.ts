/**
 * 距离层 —— 让搜索**知道两个地方有多远**。
 *
 * 为什么加这一层
 * --------------
 * 2026-08-24 用户实测：「求租…靠近 GENERSIS AI…预算1500」返回的房源全在
 * San Jose / Santa Clara / Sunnyvale，而 Genesis AI 在 Palo Alto——差了
 * 二三十公里。根因不是筛选松紧，是**系统里根本没有"距离"这个概念**：所有地点
 * 判断都是城市名字符串比对，理解层遇到不认识的公司名就"猜一个南湾"，下游照单
 * 全收。人类中介会打开地图，我们不能。
 *
 * 数据现实（1215 行实测）：`lat`/`lng` 只有 47 行有值（4%），但
 *   - 500 行能从 locationText / title / rawText 里抠出邮编（41%）
 *   - 另有 410 行有 city 列
 * 合计 ~75% 的房源可以在**零 API 成本**下拿到坐标。这就是本文件的静态表存在的
 * 理由：先用免费的把绝大多数覆盖掉，Google 地理编码（需要 key）只负责剩下的
 * 疑难杂症和查询侧的任意地点名。
 *
 * 精度声明：邮编/地标坐标是**近似质心**，误差 1–2km。它服务的是"15 公里通勤圈
 * 里外"这种判断，不是导航。别拿它去算步行路线。
 */

import {
  aliasPattern,
  CITY_TABLE,
  cityByName,
  detectCityStrict,
} from "./cities";

export type GeoPoint = { lat: number; lng: number };

export type ResolvedPlace = GeoPoint & {
  /** 人读的地名，进日志和给用户的解释。 */
  label: string;
  source: "coords" | "zip" | "landmark" | "city" | "geocode";
};

// ── 邮编 → 近似质心 ──────────────────────────────────────────────────────────
// 只收湾区。覆盖语料里出现过的 89 个邮编 + 常见的其余湾区邮编。
// 值是人工整理的近似质心（±1–2km），不是官方 TIGER 数据。

const ZIP_POINTS: Record<string, [number, number]> = {
  // San Jose
  "95110": [37.3382, -121.9],
  "95111": [37.2861, -121.8225],
  "95112": [37.3496, -121.8817],
  "95113": [37.3336, -121.8907],
  "95116": [37.3496, -121.8555],
  "95117": [37.3122, -121.9575],
  "95118": [37.2544, -121.8905],
  "95119": [37.2311, -121.7889],
  "95120": [37.2, -121.8611],
  "95121": [37.3, -121.8],
  "95122": [37.3305, -121.8309],
  "95123": [37.2444, -121.8322],
  "95124": [37.2564, -121.9256],
  "95125": [37.2953, -121.8961],
  "95126": [37.3252, -121.9147],
  "95127": [37.3661, -121.8189],
  "95128": [37.3155, -121.9367],
  "95129": [37.3072, -122.0],
  "95130": [37.2914, -121.9825],
  "95131": [37.3878, -121.8908],
  "95132": [37.4022, -121.8544],
  "95133": [37.3728, -121.8608],
  "95134": [37.4266, -121.9436],
  "95135": [37.3053, -121.7644],
  "95136": [37.2731, -121.8503],
  "95138": [37.2617, -121.7683],
  "95139": [37.2261, -121.7708],
  "95148": [37.3383, -121.7867],
  // Santa Clara / Sunnyvale / Cupertino / Mountain View / Milpitas
  "95050": [37.3496, -121.9483],
  "95051": [37.3494, -121.9836],
  "95054": [37.3924, -121.9623],
  "94085": [37.3897, -122.0186],
  "94086": [37.3719, -122.0244],
  "94087": [37.3494, -122.0364],
  "94089": [37.4098, -122.0186],
  "95014": [37.3175, -122.0419],
  "94040": [37.3775, -122.0819],
  "94041": [37.3894, -122.0783],
  "94043": [37.4113, -122.0783],
  "95035": [37.4323, -121.8996],
  // Palo Alto / Menlo Park / peninsula
  "94301": [37.4447, -122.1497],
  "94303": [37.4419, -122.1213],
  "94304": [37.4183, -122.1836],
  "94305": [37.4275, -122.1697],
  "94306": [37.4189, -122.1281],
  "94025": [37.453, -122.1817],
  "94027": [37.4613, -122.1977],
  "94061": [37.4655, -122.2311],
  "94062": [37.4322, -122.2731],
  "94063": [37.4869, -122.2033],
  "94065": [37.5333, -122.2503],
  "94070": [37.5072, -122.2605],
  "94002": [37.5202, -122.2758],
  "94010": [37.5779, -122.348],
  "94030": [37.5985, -122.3872],
  "94066": [37.6305, -122.4111],
  "94080": [37.6547, -122.4077],
  "94014": [37.6879, -122.4702],
  "94015": [37.6805, -122.4794],
  "94401": [37.5747, -122.3222],
  "94402": [37.5361, -122.3336],
  "94403": [37.5372, -122.305],
  "94404": [37.5585, -122.2711],
  // San Francisco
  "94102": [37.7797, -122.4194],
  "94103": [37.7726, -122.4103],
  "94105": [37.7898, -122.3942],
  "94107": [37.762, -122.3986],
  "94108": [37.7919, -122.4083],
  "94109": [37.793, -122.4213],
  "94110": [37.7485, -122.4156],
  "94111": [37.7983, -122.4003],
  "94112": [37.7203, -122.4425],
  "94114": [37.7583, -122.435],
  "94115": [37.786, -122.4372],
  "94116": [37.7439, -122.4858],
  "94117": [37.7699, -122.443],
  "94118": [37.7808, -122.4614],
  "94121": [37.7786, -122.4933],
  "94122": [37.7592, -122.485],
  "94123": [37.8003, -122.437],
  "94124": [37.7311, -122.3833],
  "94127": [37.735, -122.4589],
  "94131": [37.7458, -122.4419],
  "94132": [37.7211, -122.4842],
  "94134": [37.7194, -122.4111],
  "94158": [37.7706, -122.3892],
  // East Bay
  "94536": [37.5586, -121.9886],
  "94538": [37.5133, -121.97],
  "94539": [37.5133, -121.9106],
  "94555": [37.5533, -122.05],
  "94560": [37.5297, -122.0402],
  "94587": [37.5934, -122.0438],
  "94541": [37.6721, -122.08],
  "94542": [37.658, -122.0339],
  "94544": [37.635, -122.0611],
  "94545": [37.6294, -122.1069],
  "94546": [37.6941, -122.0863],
  "94577": [37.72, -122.16],
  "94578": [37.6971, -122.1281],
  "94579": [37.6869, -122.1594],
  "94580": [37.681, -122.1244],
  "94601": [37.7789, -122.22],
  "94602": [37.8, -122.21],
  "94605": [37.7614, -122.1447],
  "94606": [37.7936, -122.245],
  "94607": [37.8058, -122.2917],
  "94608": [37.8354, -122.2864],
  "94609": [37.8353, -122.265],
  "94610": [37.8122, -122.2436],
  "94611": [37.8286, -122.2189],
  "94612": [37.8083, -122.2708],
  "94618": [37.8433, -122.24],
  "94619": [37.79, -122.1739],
  "94621": [37.7517, -122.205],
  "94702": [37.8664, -122.2861],
  "94703": [37.8639, -122.2761],
  "94704": [37.8664, -122.2564],
  "94705": [37.8567, -122.24],
  "94706": [37.8869, -122.2977],
  "94707": [37.8961, -122.2811],
  "94708": [37.8956, -122.265],
  "94709": [37.8783, -122.2683],
  "94710": [37.8686, -122.3011],
  "94720": [37.8719, -122.2585],
  "94801": [37.9358, -122.3477],
  "94804": [37.9222, -122.3339],
  "94805": [37.9414, -122.3222],
  "94530": [37.9161, -122.3108],
  "94501": [37.7652, -122.2416],
  "94502": [37.7375, -122.24],
  // Tri-Valley / Contra Costa
  "94568": [37.7022, -121.9358],
  "94566": [37.6624, -121.8747],
  "94588": [37.6969, -121.8969],
  "94550": [37.6819, -121.768],
  "94551": [37.7108, -121.7708],
  "94582": [37.7622, -121.9219],
  "94583": [37.7799, -121.978],
  "94526": [37.8216, -121.9999],
  "94596": [37.901, -122.06],
  "94597": [37.9161, -122.0736],
  "94598": [37.9147, -122.0292],
  "94519": [37.9822, -122.0072],
  "94520": [37.9772, -122.0389],
  "94521": [37.9628, -121.9689],
  "94523": [37.948, -122.0608],
  "94553": [38.0194, -122.1341],
};

// ── 地标 / 雇主 / 校园 → 坐标 ────────────────────────────────────────────────
// 真实语料里"靠近X"的 X 十有八九是这些。别名一律小写比对。
// 收录标准：湾区租房帖里真的会被拿来当地点参照的地方。

const LANDMARKS: {
  aliases: string[];
  label: string;
  point: [number, number];
}[] = [
  // 大厂园区
  {
    aliases: ["google", "googleplex", "谷歌"],
    label: "Google (Mountain View)",
    point: [37.422, -122.0841],
  },
  {
    aliases: ["meta", "facebook", "脸书"],
    label: "Meta (Menlo Park)",
    point: [37.4849, -122.1477],
  },
  {
    aliases: ["apple park", "apple", "苹果公司", "无限循环"],
    label: "Apple Park (Cupertino)",
    point: [37.3349, -122.009],
  },
  {
    aliases: ["nvidia", "英伟达"],
    label: "NVIDIA (Santa Clara)",
    point: [37.3708, -121.965],
  },
  {
    aliases: ["tiktok", "字节", "字节跳动", "bytedance", "tt总部"],
    label: "TikTok/ByteDance (San Jose)",
    point: [37.403, -121.975],
  },
  {
    aliases: ["linkedin", "领英"],
    label: "LinkedIn (Sunnyvale)",
    point: [37.423, -122.027],
  },
  { aliases: ["adobe"], label: "Adobe (San Jose)", point: [37.3305, -121.893] },
  { aliases: ["ebay"], label: "eBay (San Jose)", point: [37.2937, -121.933] },
  {
    aliases: ["paypal"],
    label: "PayPal (San Jose)",
    point: [37.386, -121.925],
  },
  {
    aliases: ["cisco", "思科"],
    label: "Cisco (San Jose)",
    point: [37.411, -121.929],
  },
  {
    aliases: ["intel", "英特尔"],
    label: "Intel (Santa Clara)",
    point: [37.3878, -121.9636],
  },
  { aliases: ["amd"], label: "AMD (Santa Clara)", point: [37.383, -121.976] },
  {
    aliases: ["applied materials"],
    label: "Applied Materials (Santa Clara)",
    point: [37.39, -121.964],
  },
  {
    aliases: ["tesla", "特斯拉"],
    label: "Tesla (Fremont)",
    point: [37.493, -121.945],
  },
  {
    aliases: ["lucid motors"],
    label: "Lucid (Newark)",
    point: [37.523, -122.027],
  },
  {
    aliases: ["amazon lab126", "lab126"],
    label: "Amazon Lab126 (Sunnyvale)",
    point: [37.409, -122.025],
  },
  {
    aliases: ["salesforce", "salesforce tower"],
    label: "Salesforce Tower (SF)",
    point: [37.7897, -122.3972],
  },
  {
    aliases: ["openai"],
    label: "OpenAI (SF Mission Bay)",
    point: [37.762, -122.398],
  },
  {
    aliases: ["anthropic"],
    label: "Anthropic (SF SoMa)",
    point: [37.785, -122.396],
  },
  {
    aliases: ["genesis ai", "genersis ai", "genesis"],
    label: "Genesis AI (Palo Alto)",
    point: [37.4419, -122.143],
  },
  {
    aliases: ["waymo"],
    label: "Waymo (Mountain View)",
    point: [37.416, -122.077],
  },
  {
    aliases: ["netflix", "奈飞"],
    label: "Netflix (Los Gatos)",
    point: [37.262, -121.956],
  },
  {
    aliases: ["western digital"],
    label: "Western Digital (San Jose)",
    point: [37.402, -121.975],
  },
  {
    aliases: ["broadcom", "博通"],
    label: "Broadcom (Palo Alto)",
    point: [37.413, -122.147],
  },
  {
    aliases: ["moffett park", "moffett field"],
    label: "Moffett Park (Sunnyvale)",
    point: [37.409, -122.023],
  },
  // 校园
  {
    aliases: ["stanford", "斯坦福"],
    label: "Stanford University",
    point: [37.4275, -122.1697],
  },
  {
    aliases: ["ucb", "uc berkeley", "berkeley campus", "加州大学伯克利"],
    label: "UC Berkeley",
    point: [37.8719, -122.2585],
  },
  {
    aliases: ["sjsu", "san jose state", "圣何塞州立"],
    label: "SJSU",
    point: [37.3352, -121.8811],
  },
  {
    aliases: ["scu", "santa clara university", "圣塔克拉拉大学"],
    label: "Santa Clara University",
    point: [37.3496, -121.939],
  },
  {
    aliases: ["sfsu", "san francisco state"],
    label: "SF State",
    point: [37.7241, -122.4799],
  },
  { aliases: ["ucsf"], label: "UCSF (Mission Bay)", point: [37.768, -122.39] },
  {
    aliases: ["ucsc", "santa cruz campus"],
    label: "UC Santa Cruz",
    point: [36.9914, -122.0609],
  },
  {
    aliases: ["csueb", "cal state east bay"],
    label: "Cal State East Bay (Hayward)",
    point: [37.658, -122.057],
  },
  {
    aliases: ["neu", "northeastern"],
    label: "Northeastern 硅谷校区 (San Jose)",
    point: [37.33, -121.888],
  },
  {
    aliases: ["de anza", "de anza college"],
    label: "De Anza College (Cupertino)",
    point: [37.3195, -122.045],
  },
  {
    aliases: ["foothill college"],
    label: "Foothill College (Los Altos Hills)",
    point: [37.362, -122.129],
  },
  // 交通枢纽 / 商圈
  {
    aliases: ["sjc", "san jose airport", "圣何塞机场"],
    label: "SJC Airport",
    point: [37.3639, -121.9289],
  },
  {
    aliases: ["sfo", "旧金山机场"],
    label: "SFO Airport",
    point: [37.6213, -122.379],
  },
  {
    aliases: ["oak airport", "oakland airport"],
    label: "OAK Airport",
    point: [37.7213, -122.221],
  },
  {
    aliases: ["valley fair", "westfield valley fair"],
    label: "Valley Fair (Santa Clara)",
    point: [37.325, -121.945],
  },
  {
    aliases: ["santana row"],
    label: "Santana Row (San Jose)",
    point: [37.321, -121.948],
  },
  {
    aliases: ["stanford shopping center"],
    label: "Stanford Shopping Center",
    point: [37.443, -122.171],
  },
  {
    aliases: ["great mall"],
    label: "Great Mall (Milpitas)",
    point: [37.416, -121.904],
  },
  {
    aliases: ["stonestown"],
    label: "Stonestown (SF)",
    point: [37.728, -122.475],
  },
  {
    aliases: ["salesforce transit center", "transbay"],
    label: "Salesforce Transit Center (SF)",
    point: [37.7896, -122.3968],
  },
  {
    aliases: ["river oaks"],
    label: "River Oaks (North San Jose)",
    point: [37.403, -121.943],
  },
  {
    aliases: ["mission bay"],
    label: "Mission Bay (SF)",
    point: [37.768, -122.39],
  },
];

// 长别名优先（"apple park" 不会被 "apple" 抢走），且**必须走词边界**。
// 裸子串匹配会把 "San Fran|cisco|" 读成 San Jose 的 Cisco 园区——差 70 公里。
// 这不是假想：第一版就是 includes()，用户的 key 一接上、拿 SF 的公寓名一测
// 就跑去了南湾。同类地雷还有 "AI intel|ligent|"→Intel、"re|scu|e"→SCU。
// aliasPattern 与城市表共用（cities.ts），两边的边界规则永远一致。
const LANDMARK_ALIASES = LANDMARKS.flatMap((l) =>
  l.aliases.map((alias) => ({ alias, label: l.label, point: l.point }))
).sort((a, b) => b.alias.length - a.alias.length);

/** 捕获组 i+1 ↔ LANDMARK_ALIASES[i]，与 cities.ts 的扫描器同款结构。 */
const LANDMARK_SCAN_RE = new RegExp(
  LANDMARK_ALIASES.map(({ alias }) => `(${aliasPattern(alias)})`).join("|"),
  "i"
);

// ── 距离 ─────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** 两点间大圆距离（公里）。 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

// 加州湾区邮编都在 9xxxx。限定 5 位且前后不是数字，免得吃掉电话号和租金。
const ZIP_RE = /(?<!\d)(9[0-5]\d{3})(?!\d)/;

/** 文本里第一个能查到坐标的湾区邮编。 */
export function zipPointIn(text: string): ResolvedPlace | null {
  const m = text.match(ZIP_RE);
  if (!m) return null;
  const p = ZIP_POINTS[m[1]];
  return p ? { lat: p[0], lng: p[1], label: m[1], source: "zip" } : null;
}

/** 文本里第一个已知地标/雇主/校园。 */
export function landmarkPointIn(text: string): ResolvedPlace | null {
  const m = text.match(LANDMARK_SCAN_RE);
  if (!m) return null;
  for (let i = 1; i < m.length; i++) {
    if (m[i] !== undefined) {
      const hit = LANDMARK_ALIASES[i - 1];
      return {
        lat: hit.point[0],
        lng: hit.point[1],
        label: hit.label,
        source: "landmark",
      };
    }
  }
  return null;
}

/** 城市名（英文规范名或任意别名）→ 市中心。 */
export function cityPoint(
  name: string | null | undefined
): ResolvedPlace | null {
  const c = cityByName(name);
  return c ? { lat: c.lat, lng: c.lng, label: c.en, source: "city" } : null;
}

/**
 * 房源坐标。优先级：真坐标 → 邮编 → city 列 → 正文里能认出的城市。
 * 全部落空返回 null（谓词对 null 宽容——沉默不是违反）。
 */
export function listingPoint(row: {
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  title?: string | null;
  locationText?: string | null;
  propertyName?: string | null;
  rawText: string;
}): ResolvedPlace | null {
  if (row.lat != null && row.lng != null) {
    return { lat: row.lat, lng: row.lng, label: "coords", source: "coords" };
  }
  // 邮编比城市精确一个数量级（San Jose 横跨 20+ 公里），所以先找邮编。
  const zipText = `${row.locationText ?? ""} ${row.title ?? ""} ${row.rawText}`;
  const zip = zipPointIn(zipText);
  if (zip) return zip;

  const col = cityPoint(row.city);
  if (col) return col;

  const detected = detectCityStrict(
    `${row.title ?? ""} ${row.locationText ?? ""} ${row.propertyName ?? ""} ${row.rawText}`
  );
  return detected
    ? {
        lat: detected.lat,
        lng: detected.lng,
        label: detected.en,
        source: "city",
      }
    : null;
}

/**
 * 把用户说的一个地点（"94583"、"Stanford"、"靠近TikTok"、"Palo Alto"）解析成
 * 坐标，**不花钱、不联网**。解析不出返回 null —— 那正是需要 geocodePlace
 * （或者干脆反问用户）的场合。
 */
export function staticPlacePoint(text: string): ResolvedPlace | null {
  return zipPointIn(text) ?? landmarkPointIn(text) ?? cityPointIn(text);
}

function cityPointIn(text: string): ResolvedPlace | null {
  const c = detectCityStrict(text);
  return c ? { lat: c.lat, lng: c.lng, label: c.en, source: "city" } : null;
}

// ── 真正的地理编码（可选，需要 key）──────────────────────────────────────────

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";
const GEOCODE_TIMEOUT_MS = 6000;
/** 湾区外的结果一律作废：地理编码把 "Genesis" 定位到别的州是很常见的。 */
const BAY_BOUNDS = {
  minLat: 36.7,
  maxLat: 38.9,
  minLng: -123.2,
  maxLng: -121.2,
};

type GoogleGeocodeResponse = {
  status: string;
  error_message?: string;
  results: {
    formatted_address: string;
    geometry: { location: { lat: number; lng: number } };
  }[];
};

const geocodeCache = new Map<string, ResolvedPlace | null>();

/**
 * 任意地点名 → 坐标（Google Geocoding，偏置到湾区）。
 *
 * **没有 GOOGLE_MAPS_API_KEY 时直接返回 null**，调用方回落到静态表。这是
 * "有 key 更聪明，没 key 也能跑"的分界线：静态表覆盖不了的是那些我们没听过的
 * 公司/新楼盘（比如触发这次改动的 Genesis AI），而那恰恰是最需要地图的场合。
 */
export async function geocodePlace(
  query: string
): Promise<ResolvedPlace | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;
  if (!GOOGLE_MAPS_KEY) return null;

  let out: ResolvedPlace | null = null;
  try {
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json" +
      `?address=${encodeURIComponent(`${query}, Bay Area, CA`)}` +
      "&region=us&components=country:US" +
      `&key=${GOOGLE_MAPS_KEY}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as GoogleGeocodeResponse;
      // Google 对配置问题回 HTTP 200 + status:"REQUEST_DENIED"。静默 null 会
      // 让"key 配错了"和"这个地方查不到"看起来一模一样——实测就踩过（key 有效
      // 但项目没开 Billing，一整轮测试全是 null，肉眼看不出原因）。
      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        console.error(
          `[geocodePlace] ${data.status}: ${data.error_message ?? "(no message)"}`
        );
      }
      const hit = data.status === "OK" ? data.results[0] : null;
      const loc = hit?.geometry.location;
      if (
        loc &&
        loc.lat >= BAY_BOUNDS.minLat &&
        loc.lat <= BAY_BOUNDS.maxLat &&
        loc.lng >= BAY_BOUNDS.minLng &&
        loc.lng <= BAY_BOUNDS.maxLng
      ) {
        out = {
          lat: loc.lat,
          lng: loc.lng,
          label: hit.formatted_address,
          source: "geocode",
        };
      }
    }
  } catch (error) {
    const e = error as Error;
    console.error(`[geocodePlace] ${e.name}: ${e.message}`);
  }
  geocodeCache.set(key, out);
  return out;
}

/** 地理编码是否可用（有 key）。用于日志与"要不要反问用户"的判断。 */
export function geocodingAvailable(): boolean {
  return GOOGLE_MAPS_KEY.length > 0;
}

/** 落到哪个城市里（用于把坐标翻回人能读的城市名）。 */
export function nearestCityName(point: GeoPoint): string {
  let best = CITY_TABLE[0];
  let bestKm = Number.POSITIVE_INFINITY;
  for (const c of CITY_TABLE) {
    const km = haversineKm(point, c);
    if (km < bestKm) {
      bestKm = km;
      best = c;
    }
  }
  return best.en;
}
