/**
 * LLM-powered structured field extractor for XhsRentalListing.
 *
 * Uses generateObject (Claude Haiku) to read the full rawText and extract
 * all listing fields — including new boolean/numeric columns that regex
 * cannot reliably handle.
 *
 * Falls back to the regex parser on any LLM failure, so ingest never breaks.
 */
import { generateObject } from "ai";
import { z } from "zod";

import { getTitleModel } from "@/lib/ai/providers";
import { listingLeaseFromText } from "@/lib/rental/lease-duration";
import { parseListingFields } from "@/lib/xhs/parse-rental-text";

// ── Zod schema returned by the LLM ───────────────────────────────────────────

const extractedFieldsSchema = z.object({
  title: z
    .string()
    .nullable()
    .describe("Post title / first headline line"),

  rent: z
    .string()
    .nullable()
    .describe("Monthly rent as written, e.g. '$2,000/mo', '2000刀', '1800-2200'"),

  deposit: z
    .string()
    .nullable()
    .describe("Deposit as written, e.g. '一个月押金', '$2000'"),

  availableFrom: z
    .string()
    .nullable()
    .describe("Move-in date as written, e.g. '7/1', 'ASAP', '随时入住'"),

  leaseEndDate: z
    .string()
    .nullable()
    .describe("Lease end date as written"),

  listingType: z
    .enum(["rent", "sublease", "roommate"])
    .nullable()
    .describe("rent=整租/直租; sublease=转租; roommate=找室友"),

  bedrooms: z
    .string()
    .nullable()
    .describe("Bedrooms as written, e.g. '2', '两室', '3BR'"),

  bedroomsNum: z
    .number()
    .int()
    .nullable()
    .describe(
      "Bedrooms as integer: studio→0, 一室/1BR→1, 两室/2BR→2, 三房/3BR→3, etc."
    ),

  bathrooms: z
    .string()
    .nullable()
    .describe("Bathrooms as written"),

  roomType: z
    .enum(["master bedroom", "bedroom", "studio", "living room", "entire unit"])
    .nullable()
    .describe(
      "主卧→master bedroom; 次卧/客卧→bedroom; studio→studio; 客厅→living room; 整套/整租→entire unit"
    ),

  propertyName: z
    .string()
    .nullable()
    .describe("Apartment complex or building name if explicitly mentioned"),

  locationText: z
    .string()
    .nullable()
    .describe("Full address or area as written in the post"),

  city: z
    .string()
    .nullable()
    .describe(
      "Standardized English city name. Map Chinese: 圣何塞→San Jose, " +
        "旧金山/三藩市→San Francisco, 奥克兰→Oakland, 伯克利→Berkeley, " +
        "山景城→Mountain View, 桑尼维尔→Sunnyvale, 圣克拉拉→Santa Clara, " +
        "弗里蒙特→Fremont, 帕洛阿尔托→Palo Alto, 戴利城→Daly City, " +
        "库比蒂诺→Cupertino, 圣马特奥→San Mateo, 红木城→Redwood City"
    ),

  furnished: z
    .enum(["furnished", "unfurnished", "partial"])
    .nullable()
    .describe(
      "furnished=全套家具; unfurnished=无家具; partial=部分家具"
    ),

  contactMethod: z
    .string()
    .nullable()
    .describe("Contact info: WeChat ID, phone number, or email"),

  petFriendly: z
    .boolean()
    .nullable()
    .describe(
      "true if pets are explicitly welcome or negotiable. " +
        "false if explicitly no pets. null if not mentioned."
    ),

  couplesOk: z
    .boolean()
    .nullable()
    .describe(
      "true if couples/pairs can move in. " +
        "false if explicitly one person only. null if not mentioned."
    ),

  utilitiesIncluded: z
    .boolean()
    .nullable()
    .describe(
      "true if water/electricity/utilities are included in rent. " +
        "false if explicitly not included. null if not mentioned."
    ),

  parkingIncluded: z
    .boolean()
    .nullable()
    .describe(
      "true if parking is available or included. " +
        "false if explicitly no parking. null if not mentioned."
    ),

  leaseMinMonths: z
    .number()
    .int()
    .nullable()
    .describe(
      "Minimum lease length in MONTHS the lister REQUIRES (hard floor only). " +
        "一年起租/至少签一年/租期一年→12; 半年起/最短半年→6; 6个月起租→6; " +
        "只接受长租/不短租/谢绝短租→6 (unless a longer floor is stated). " +
        "Preferences are NOT requirements: prefer长租/长租优先/prefer一年起租→null. " +
        "Tiered long/short pricing (长租$X/短租3个月起$Y) → the smallest acceptable " +
        "minimum (3). 最多出租一年 is a max, not a min. 长短租皆可/可短租→null. " +
        "null if not mentioned."
    ),

  leaseMaxMonths: z
    .number()
    .int()
    .nullable()
    .describe(
      "Maximum stay in MONTHS available (hard ceiling only). 最多出租一年→12. " +
        "Compute from an explicit fixed sublease window: 租期8/24-9/10→1; " +
        "9/10-10/30短租→2; 起租9/20+租约到2027/2/6→5 (round up, minimum 1). " +
        "仅限一个月短租→1; 只接受短租→6. null if open-ended, renewable, or unknown."
    ),
});

export type ExtractedListingFields = z.infer<typeof extractedFieldsSchema>;

/** Combined result type: all ParsedListingFields plus new LLM-only structured fields */
export type ListingFieldsResult = {
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
  // New LLM-extracted fields
  bedroomsNum: number | null;
  city: string | null;
  petFriendly: boolean | null;
  couplesOk: boolean | null;
  utilitiesIncluded: boolean | null;
  parkingIncluded: boolean | null;
  leaseMinMonths: number | null;
  leaseMaxMonths: number | null;
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * 电话号码不是租金。
 *
 * 实测（2026-08-26，用户报的）：一篇**通篇没写价格**的帖子，末尾是
 * `看房联系：(510) 798‑1685`，抽取器把区号 510 当成了月租存进
 * `rent`/`rentNumeric`——同一串数字在 `contactMethod` 里被正确识别成电话。
 *
 * 危害不只是显示成"价格：510美元/月"：`rentNumeric=510` 会让这条房源
 * **假装通过任何预算上限的硬筛选**，出现在每一个"预算1500以内"的结果里。
 *
 * 光在提示词里写"电话不是租金"不够（这一轮已经反复验证提示词压不住输出约束），
 * 所以这里再做一道**结构性校验**：抽出来的数字如果只在电话形状里出现过、
 * 而没有任何一次出现在金额语境里，就判定是误读，退回 null。
 *
 * 判据刻意保守——真有一间 $510 的房，帖子里一定会写成 `$510` 或 `510/月`
 * 之类的金额语境，那样就会被放行。
 */
export function rentLooksLikePhoneNumber(
  rent: string | null,
  rawText: string
): boolean {
  if (!rent) {
    return false;
  }
  const digits = rent.match(/\d[\d,]*/)?.[0]?.replace(/,/g, "");
  // 只有 3 位数才可能是区号；4 位以上的租金不会跟区号混
  if (!digits || digits.length !== 3) {
    return false;
  }
  // 分隔符可能是 ASCII `-`、Unicode 连字符 `‐`/`‑`（原帖用的就是 U+2011）、
  // 点或空格。注意这是**字符串**不是正则字面量，反斜杠要写两个。
  const sep = "[\\s\\-‐‑.]";
  const phoneShaped = new RegExp(
    `\\(?${digits}\\)?${sep}{0,2}\\d{3}${sep}{0,2}\\d{4}`
  );
  if (!phoneShaped.test(rawText)) {
    return false;
  }
  // 同一个数字也出现在金额语境里 → 那是真价格，别动
  const moneyShaped = new RegExp(
    `[$￥￡]\\s*${digits}` +
      `|${digits}\\s*(?:刀|美元|块|元|/\\s*月|每月|usd|per\\s*month|/mo)` +
      `|(?:租金|房租|月租|价格|rent|price)\\D{0,10}${digits}`,
    "i"
  );
  return !moneyShaped.test(rawText);
}

/**
 * Extract structured fields from a raw rental post text.
 * Uses LLM (Claude Haiku via generateObject); falls back to regex on failure.
 * Never throws — always returns a best-effort result.
 */
export async function extractListingFields(
  rawText: string
): Promise<ListingFieldsResult> {
  const regexFallback = parseListingFields(rawText);
  const leaseFallback = listingLeaseFromText(rawText);

  try {
    const { object } = await generateObject({
      model: getTitleModel(),
      schema: extractedFieldsSchema,
      system: `You are a data extractor for US Bay Area rental listings (Chinese/English).
Read the post and extract structured fields. Return null for anything you cannot confidently determine.
Be precise:
- For booleans: only true/false when explicitly stated; null when ambiguous or not mentioned.
- For city: standardize to English city name; null if no clear Bay Area city.
- For rent: extract the exact text; if a range like "1800-2000", return the range string.
  **A phone number is not a rent.** Bay Area posts end with numbers like
  "(510) 798-1685" / "408-219-1207"; the area code is NOT a price. If the post
  never states a price, return null — do not manufacture one from a phone
  number, a zip code, a square footage, or a street address.
- For bedroomsNum: always return an integer (studio=0); null only if truly unclear.`,
      prompt: rawText.slice(0, 5000),
    });

    // Merge: LLM wins on all fields it provides; regex fills nulls
    return {
      title: object.title ?? regexFallback.title,
      rent: rentLooksLikePhoneNumber(object.rent ?? null, rawText)
        ? regexFallback.rent
        : (object.rent ?? regexFallback.rent),
      deposit: object.deposit ?? regexFallback.deposit,
      availableFrom: object.availableFrom ?? regexFallback.availableFrom,
      leaseEndDate: object.leaseEndDate ?? regexFallback.leaseEndDate,
      listingType: object.listingType ?? regexFallback.listingType,
      bedrooms: object.bedrooms ?? regexFallback.bedrooms,
      bedroomsNum: object.bedroomsNum ?? null,
      bathrooms: object.bathrooms ?? regexFallback.bathrooms,
      roomType: object.roomType ?? regexFallback.roomType,
      propertyName: object.propertyName ?? regexFallback.propertyName,
      locationText: object.locationText ?? regexFallback.locationText,
      city: object.city ?? null,
      furnished: object.furnished ?? regexFallback.furnished,
      contactMethod: object.contactMethod ?? regexFallback.contactMethod,
      petFriendly: object.petFriendly ?? null,
      couplesOk: object.couplesOk ?? null,
      utilitiesIncluded: object.utilitiesIncluded ?? null,
      parkingIncluded: object.parkingIncluded ?? null,
      leaseMinMonths: object.leaseMinMonths ?? leaseFallback.leaseMinMonths,
      leaseMaxMonths: object.leaseMaxMonths ?? leaseFallback.leaseMaxMonths,
    };
  } catch (err) {
    console.error("[extract-listing-fields] LLM failed, using regex fallback:", err);
    return {
      ...regexFallback,
      bedroomsNum: null,
      city: null,
      petFriendly: null,
      couplesOk: null,
      utilitiesIncluded: null,
      parkingIncluded: null,
      leaseMinMonths: leaseFallback.leaseMinMonths,
      leaseMaxMonths: leaseFallback.leaseMaxMonths,
    };
  }
}
