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
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract structured fields from a raw rental post text.
 * Uses LLM (Claude Haiku via generateObject); falls back to regex on failure.
 * Never throws — always returns a best-effort result.
 */
export async function extractListingFields(
  rawText: string
): Promise<ListingFieldsResult> {
  const regexFallback = parseListingFields(rawText);

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
- For bedroomsNum: always return an integer (studio=0); null only if truly unclear.`,
      prompt: rawText.slice(0, 5000),
    });

    // Merge: LLM wins on all fields it provides; regex fills nulls
    return {
      title: object.title ?? regexFallback.title,
      rent: object.rent ?? regexFallback.rent,
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
    };
  }
}
