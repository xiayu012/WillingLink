const RENT_RE =
  /(?:租金|房租|rent|price|价格|月租)[^\n$¥￥\d]{0,12}([$¥￥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:刀|美金|usd|\/月|per month|monthly|month|mo)?)/i;
const DEPOSIT_RE =
  /(?:押金|deposit)[^\n$¥￥\d]{0,12}([$¥￥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:刀|美金|usd|个月|month|mo)?)/i;
const BUDGET_RE =
  /(?:预算|budget|最多|最高|afford)[^\n$¥￥\d]{0,12}([$¥￥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:刀|美金|usd|\/月|per month|monthly|month|mo)?)/i;
const BED_BATH_RE =
  /(\d+(?:\.\d+)?)\s*(?:b|室|bed|br|bedroom)s?\s*(\d+(?:\.\d+)?)?\s*(?:b|卫|bath|ba|bathroom)s?/i;
const BEDROOM_RE = /(\d+(?:\.\d+)?)\s*(?:b|室|bed|br|bedroom)s?/i;
const BATHROOM_RE = /(\d+(?:\.\d+)?)\s*(?:卫|bath|ba|bathroom)s?/i;
const AVAILABLE_RE =
  /(?:入住|available|avail|起租|可入住|入住时间|搬入|move.?in)[^\n\d]{0,12}((?:\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)|(?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})|(?:now|asap|immediate|随时))/i;
const LEASE_END_RE =
  /(?:lease\s*end|租期到|到期|租期至|end date)[^\n\d]{0,12}((?:\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)|(?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}))/i;
const LEASE_DUR_RE =
  /(?:租(?:多久|期|时间)|多长时间|(\d+)\s*(?:个月|months?|years?|年))/i;
const CONTACT_RE =
  /((?:微信|wechat|vx|v信)[:：\s]*[a-zA-Z0-9_-]{3,})|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|((?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}))/i;
const PROPERTY_RE =
  /(?:公寓|小区|apartment|apt|community|property|楼盘)[:：\s]*([^\n，,。;；]{2,60})/i;
const OCCUPANTS_RE = /(\d+)\s*(?:人|adults?|people|persons?)/i;
const GENDER_RE = /(女生|男生|female|male)\s*(?:优先|preferred|only|室友)/i;
const PET_RE =
  /(?:有宠物|带猫|带狗|有猫|有狗|has\s+(?:cat|dog|pet)|pet.?friendly)/i;

const BAY_AREA_LOCATIONS = [
  "San Francisco",
  "San Jose",
  "Oakland",
  "Palo Alto",
  "Fremont",
  "Santa Clara",
  "Mountain View",
  "Sunnyvale",
  "Berkeley",
  "Daly City",
  "Cupertino",
  "Milpitas",
  "Redwood City",
  "San Mateo",
  "湾区",
  "旧金山",
  "圣何塞",
  "奥克兰",
  "伯克利",
] as const;

function matchText(re: RegExp, text: string, group = 1): string | null {
  const m = text.match(re);
  const value = m?.[group]?.trim();
  return value && value.length > 0 ? value : null;
}

function inferTitle(text: string): string | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  const title = lines.find((line) => line.length >= 4 && line.length <= 120);
  return title ?? null;
}

function inferLocation(text: string): string | null {
  const hits = BAY_AREA_LOCATIONS.filter((name) =>
    text.toLowerCase().includes(name.toLowerCase())
  );
  return hits.length > 0 ? hits.join(", ") : null;
}

function inferListingType(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("转租") || lower.includes("sublease")) {
    return "sublease";
  }
  if (lower.includes("找室友") || lower.includes("roommate")) {
    return "roommate";
  }
  if (
    lower.includes("出租") ||
    lower.includes("lease") ||
    lower.includes("rent")
  ) {
    return "rent";
  }
  return null;
}

function inferWantedType(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("求租") || lower.includes("找房")) {
    return "wanted";
  }
  if (lower.includes("找室友") || lower.includes("roommate")) {
    return "roommate-seeking";
  }
  return null;
}

function inferRoomType(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("主卧") || lower.includes("master")) {
    return "master bedroom";
  }
  if (lower.includes("次卧") || lower.includes("客卧")) {
    return "bedroom";
  }
  if (lower.includes("studio")) {
    return "studio";
  }
  if (lower.includes("客厅") || lower.includes("living room")) {
    return "living room";
  }
  return null;
}

function inferFurnished(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("不带家具") || lower.includes("unfurnished")) {
    return "unfurnished";
  }
  if (lower.includes("家具") || lower.includes("furnished")) {
    return "furnished";
  }
  return null;
}

function extractBedroomsBathrooms(text: string) {
  const both = text.match(BED_BATH_RE);
  if (both?.[1]) {
    return {
      bedrooms: both[1],
      bathrooms: both[2] ?? null,
    };
  }
  return {
    bedrooms: matchText(BEDROOM_RE, text),
    bathrooms: matchText(BATHROOM_RE, text),
  };
}

function inferGender(text: string): string | null {
  const m = text.match(GENDER_RE);
  if (!m) {
    return null;
  }
  const hit = m[1]?.toLowerCase();
  if (hit === "女生" || hit === "female") {
    return "female";
  }
  if (hit === "男生" || hit === "male") {
    return "male";
  }
  return m[0] ?? null;
}

function inferPets(text: string): string | null {
  if (!PET_RE.test(text)) {
    return null;
  }
  const lower = text.toLowerCase();
  if (lower.includes("猫") || lower.includes("cat")) {
    return "has cat";
  }
  if (lower.includes("狗") || lower.includes("dog")) {
    return "has dog";
  }
  return "has pet";
}

function inferLeaseDuration(text: string): string | null {
  const m = text.match(LEASE_DUR_RE);
  if (!m) {
    return null;
  }
  return m[0].trim().slice(0, 40);
}

export type ParsedListingFields = {
  title: string | null;
  rent: string | null;
  deposit: string | null;
  availableFrom: string | null;
  leaseEndDate: string | null;
  listingType: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  roomType: string | null;
  propertyName: string | null;
  locationText: string | null;
  furnished: string | null;
  contactMethod: string | null;
};

export function parseListingFields(rawText: string): ParsedListingFields {
  const { bedrooms, bathrooms } = extractBedroomsBathrooms(rawText);
  return {
    title: inferTitle(rawText),
    rent: matchText(RENT_RE, rawText),
    deposit: matchText(DEPOSIT_RE, rawText),
    availableFrom: matchText(AVAILABLE_RE, rawText),
    leaseEndDate: matchText(LEASE_END_RE, rawText),
    listingType: inferListingType(rawText),
    bedrooms,
    bathrooms,
    roomType: inferRoomType(rawText),
    propertyName: matchText(PROPERTY_RE, rawText),
    locationText: inferLocation(rawText),
    furnished: inferFurnished(rawText),
    contactMethod: matchText(CONTACT_RE, rawText, 0),
  };
}

export function parseWantedFields(rawText: string) {
  const { bedrooms, bathrooms } = extractBedroomsBathrooms(rawText);
  return {
    title: inferTitle(rawText),
    budgetText: matchText(BUDGET_RE, rawText),
    preferredLocations: inferLocation(rawText),
    moveInDate: matchText(AVAILABLE_RE, rawText),
    leaseDuration: inferLeaseDuration(rawText),
    wantedType: inferWantedType(rawText),
    bedrooms,
    bathrooms,
    roomType: inferRoomType(rawText),
    furnished: inferFurnished(rawText),
    pets: inferPets(rawText),
    occupation: null,
    householdSize: matchText(OCCUPANTS_RE, rawText, 0),
    gender: inferGender(rawText),
    requirements: null,
    contactMethod: matchText(CONTACT_RE, rawText, 0),
  };
}
