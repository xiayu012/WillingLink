const bayAreaCities = [
  "San Francisco",
  "Daly City",
  "South San Francisco",
  "San Bruno",
  "Millbrae",
  "Burlingame",
  "San Mateo",
  "Foster City",
  "Redwood City",
  "Palo Alto",
  "Mountain View",
  "Sunnyvale",
  "Santa Clara",
  "San Jose",
  "Cupertino",
  "Milpitas",
  "Fremont",
  "Union City",
  "Newark",
  "Hayward",
  "San Leandro",
  "Oakland",
  "Berkeley",
  "Emeryville",
  "Alameda",
  "Pleasanton",
  "Dublin",
  "Livermore",
  "Walnut Creek",
  "Concord",
  "San Ramon",
  "Castro Valley",
  "Menlo Park",
  "Belmont",
  "Pacifica",
  "旧金山",
  "南湾",
  "东湾",
  "北湾",
  "半岛",
  "圣何塞",
  "圣荷西",
  "佛利蒙",
  "屋仑",
  "奥克兰",
];

const bayAreaDistricts = [
  "南湾",
  "东湾",
  "北湾",
  "半岛",
  "旧金山市",
  "其他地区",
];

export type RentalStructuredData = {
  priceMin: number | null;
  priceMax: number | null;
  currency: "USD" | "CNY" | null;
  priceUnit: "month" | "week" | "day" | null;
  rentType: "entire" | "shared" | "sublet" | "other" | null;
  roomType: string | null;
  city: string | null;
  district: string | null;
  addressText: string | null;
  availableFrom: string | null;
  leaseTermMonths: number | null;
  contactPhone: string | null;
  contactWechat: string | null;
  contactEmail: string | null;
  genderPreference: "female_only" | "male_only" | "no_preference" | null;
  petPolicy: "allowed" | "not_allowed" | null;
};

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function parseAmount(raw: string): number | null {
  const normalized = raw.replaceAll(",", "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parsePrice(
  text: string
): Pick<
  RentalStructuredData,
  "priceMin" | "priceMax" | "currency" | "priceUnit"
> & { priceRaw: string | null } {
  const usdRangeRegex =
    /(\$|usd\s*)(\d{2,5}(?:,\d{3})?(?:\.\d+)?)(?:\s*(?:-|~|到|至)\s*(?:\$|usd\s*)?(\d{2,5}(?:,\d{3})?(?:\.\d+)?))?/i;
  const cnyRangeRegex =
    /(\d{2,5}(?:,\d{3})?(?:\.\d+)?)\s*元(?:\s*(?:-|~|到|至)\s*(\d{2,5}(?:,\d{3})?(?:\.\d+)?)\s*元?)?/i;

  const usdMatch = text.match(usdRangeRegex);
  const cnyMatch = text.match(cnyRangeRegex);
  let unit: "month" | "week" | "day" | null = null;
  if (/(?:\/|每)\s*(?:月|month|mo|mth)/i.test(text)) {
    unit = "month";
  } else if (/(?:\/|每)\s*(?:周|week|wk)/i.test(text)) {
    unit = "week";
  } else if (/(?:\/|每)\s*(?:日|天|day)/i.test(text)) {
    unit = "day";
  }

  if (usdMatch) {
    return {
      priceRaw: usdMatch[0],
      priceMin: parseAmount(usdMatch[2]),
      priceMax: parseAmount(usdMatch[3] ?? usdMatch[2]),
      currency: "USD",
      priceUnit: unit,
    };
  }

  if (cnyMatch) {
    return {
      priceRaw: cnyMatch[0],
      priceMin: parseAmount(cnyMatch[1]),
      priceMax: parseAmount(cnyMatch[2] ?? cnyMatch[1]),
      currency: "CNY",
      priceUnit: unit,
    };
  }

  return {
    priceRaw: null,
    priceMin: null,
    priceMax: null,
    currency: null,
    priceUnit: unit,
  };
}

function parseRoomType(text: string): string | null {
  const patterns = [
    /studio/i,
    /\b[1-9]b[1-9]b\b/i,
    /主卧/,
    /次卧/,
    /单间/,
    /雅房/,
    /套房/,
    /独立房间/,
    /客卧/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }

  return null;
}

function parseRentType(
  text: string
): RentalStructuredData["rentType"] {
  if (/整租/.test(text)) {
    return "entire";
  }
  if (/分租|合租/.test(text)) {
    return "shared";
  }
  if (/转租|短租/.test(text)) {
    return "sublet";
  }
  return null;
}

function parseCity(text: string): string | null {
  for (const city of bayAreaCities) {
    if (new RegExp(city, "i").test(text)) {
      return city;
    }
  }

  return null;
}

function parseDistrict(text: string): string | null {
  for (const district of bayAreaDistricts) {
    if (text.includes(district)) {
      return district;
    }
  }
  return null;
}

function parseAvailableFrom(text: string): string | null {
  const fullDate = text.match(
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/
  );
  if (fullDate?.[0]) {
    return fullDate[0];
  }

  if (/随时入住|拎包入住|即可入住/.test(text)) {
    return "immediate";
  }

  return null;
}

function parseLeaseTermMonths(text: string): number | null {
  const match = text.match(/(\d{1,2})\s*(?:个月|月|months?)/i);
  if (!match?.[1]) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseGenderPreference(
  text: string
): RentalStructuredData["genderPreference"] {
  if (/限女|女生优先|女性优先/.test(text)) {
    return "female_only";
  }
  if (/限男|男生优先|男性优先/.test(text)) {
    return "male_only";
  }
  if (/不限男女|男女不限/.test(text)) {
    return "no_preference";
  }
  return null;
}

function parsePetPolicy(text: string): RentalStructuredData["petPolicy"] {
  if (/可宠物|宠物友好|可以养宠物/.test(text)) {
    return "allowed";
  }
  if (/不接受宠物|不可宠物|不能养宠物|禁宠/.test(text)) {
    return "not_allowed";
  }
  return null;
}

export function parseContacts(text: string): {
  contactRaw: string | null;
  contactPhone: string | null;
  contactWechat: string | null;
  contactEmail: string | null;
} {
  const phoneMatch = text.match(
    /(?:\+?1[-\s.]?)?(?:\(?\d{3}\)?[-\s.]?)\d{3}[-\s.]?\d{4}/
  );
  const wechatMatch = text.match(
    /(?:微信|wechat|vx|v:|vx:)\s*[:：]?\s*([a-zA-Z0-9_-]{4,30})/i
  );
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  const contactRawParts = [phoneMatch?.[0], wechatMatch?.[0], emailMatch?.[0]]
    .filter((part): part is string => Boolean(part))
    .join(" | ");

  return {
    contactRaw: contactRawParts.length > 0 ? contactRawParts : null,
    contactPhone: phoneMatch?.[0] ?? null,
    contactWechat: wechatMatch?.[1] ?? null,
    contactEmail: emailMatch?.[0] ?? null,
  };
}

export function extractPostIdFromUrl(url: string): string | null {
  const match = url.match(/\/f\/page_viewtopic\/t_(\d+)\.html/i);
  return match?.[1] ?? null;
}

export function parsePublishedAtRaw(value: string): Date | null {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    return null;
  }

  const dateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const day = Number(dateMatch[3]);
    return new Date(Date.UTC(year, month, day, 0, 0, 0));
  }

  const timeMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/i);
  if (timeMatch) {
    const now = new Date();
    const hours12 = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const period = timeMatch[3].toLowerCase();
    const hours24 = period === "pm" ? (hours12 % 12) + 12 : hours12 % 12;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours24,
      minutes,
      0,
      0
    );
  }

  return null;
}

export function parseStructuredRentalData(input: {
  title: string;
  contentText: string;
}): {
  structured: RentalStructuredData;
  priceRaw: string | null;
  locationRaw: string | null;
  contactRaw: string | null;
} {
  const mergedText = normalizeText(`${input.title} ${input.contentText}`);
  const price = parsePrice(mergedText);
  const rentType = parseRentType(mergedText);
  const city = parseCity(mergedText);
  const district = parseDistrict(mergedText);
  const contacts = parseContacts(mergedText);

  const locationRaw = city
    ? city
    : mergedText.match(/\b\d{5}\b/)?.[0] ??
      mergedText.match(/(?:位于|地址|在)\s*[:：]?\s*([^\s,，。;；]+)/)?.[1] ??
      null;

  const structured: RentalStructuredData = {
    priceMin: price.priceMin,
    priceMax: price.priceMax,
    currency: price.currency,
    priceUnit: price.priceUnit,
    rentType,
    roomType: parseRoomType(mergedText),
    city,
    district,
    addressText: locationRaw,
    availableFrom: parseAvailableFrom(mergedText),
    leaseTermMonths: parseLeaseTermMonths(mergedText),
    contactPhone: contacts.contactPhone,
    contactWechat: contacts.contactWechat,
    contactEmail: contacts.contactEmail,
    genderPreference: parseGenderPreference(mergedText),
    petPolicy: parsePetPolicy(mergedText),
  };

  return {
    structured,
    priceRaw: price.priceRaw,
    locationRaw,
    contactRaw: contacts.contactRaw,
  };
}
