import { tool } from "ai";
import { z } from "zod";
import { searchXhsRentalListings } from "@/lib/db/queries";

const RENTAL_FILTER_FIELDS = [
  "rent",
  "bedrooms",
  "bathrooms",
  "roomType",
  "listingType",
  "furnished",
  "locationText",
  "availableFrom",
] as const;

export const searchRental = tool({
  description:
    "Search rental listings (XhsRentalListing table) for the user. " +
    "Call this whenever the user is looking for housing/rental/找房/租房, even with weird or long-tail criteria. " +
    "Extract structured fields when the user is explicit (e.g. '2 bedrooms', '$2000 max', 'Arlington'). " +
    "For ANY non-structured criteria (e.g. pet-friendly, near subway, balcony, washer/dryer, sublease, female-only, smoke-free, short-term, parking, gym, 留学生, 中国房东) " +
    "put each as a short Chinese-or-English term in `keywords` — they will be ILIKE-matched against the full post text. " +
    "Pass accumulated filters from the conversation. Only pass a filter when the user has explicitly provided that information.",
  inputSchema: z.object({
    bedrooms: z
      .string()
      .optional()
      .describe("Exact bedroom string filter, e.g. '2', 'studio'."),
    bedroomsMin: z
      .number()
      .int()
      .optional()
      .describe("Minimum number of bedrooms (numeric, takes first integer)."),
    bathrooms: z.string().optional().describe("Exact bathroom string filter."),
    bathroomsMin: z.number().int().optional().describe("Minimum bathrooms."),
    rentMin: z
      .number()
      .int()
      .optional()
      .describe("Minimum monthly rent in the listing's currency (integer)."),
    rentMax: z
      .number()
      .int()
      .optional()
      .describe("Maximum monthly rent in the listing's currency (integer)."),
    roomType: z
      .string()
      .optional()
      .describe(
        "Room type, e.g. 'apartment', 'house', '单间', '主卧', '次卧', '独栋'."
      ),
    listingType: z
      .string()
      .optional()
      .describe(
        "Listing type, e.g. 'sublease', 'long-term', 'short-term', '转租', '长租'."
      ),
    furnished: z
      .string()
      .optional()
      .describe("Furnishing, e.g. 'furnished', 'unfurnished', '带家具'."),
    propertyName: z
      .string()
      .optional()
      .describe("Property/community name fuzzy match."),
    locationText: z
      .string()
      .optional()
      .describe(
        "Location/neighborhood/city fuzzy match, e.g. 'Arlington', '法拉盛', 'Dupont Circle'."
      ),
    availableFromAfter: z
      .string()
      .optional()
      .describe(
        "Earliest acceptable move-in date as ISO date string YYYY-MM-DD."
      ),
    availableFromBefore: z
      .string()
      .optional()
      .describe(
        "Latest acceptable move-in date as ISO date string YYYY-MM-DD."
      ),
    keywords: z
      .array(z.string())
      .optional()
      .describe(
        "Free-form keywords for any criterion that doesn't map to a structured field. " +
          "Examples: ['宠物'], ['地铁'], ['阳台'], ['女生'], ['不抽烟'], ['短租'], ['停车位'], ['留学生'], ['中国房东']. " +
          "Each keyword is ILIKE-matched against rawText/title/locationText/propertyName; multiple keywords are AND-ed."
      ),
  }),
  execute: async (args) => {
    const { totalCount, results } = await searchXhsRentalListings({
      bedrooms: args.bedrooms ?? null,
      bedroomsMin: args.bedroomsMin ?? null,
      bathrooms: args.bathrooms ?? null,
      bathroomsMin: args.bathroomsMin ?? null,
      rentMin: args.rentMin ?? null,
      rentMax: args.rentMax ?? null,
      roomType: args.roomType ?? null,
      listingType: args.listingType ?? null,
      furnished: args.furnished ?? null,
      propertyName: args.propertyName ?? null,
      locationText: args.locationText ?? null,
      availableFromAfter: args.availableFromAfter ?? null,
      availableFromBefore: args.availableFromBefore ?? null,
      keywords: args.keywords ?? null,
    });

    const rentRangeFilter =
      args.rentMin !== undefined || args.rentMax !== undefined
        ? `${args.rentMin ?? "?"} ~ ${args.rentMax ?? "?"}`
        : undefined;

    const availableFromFilter =
      args.availableFromAfter || args.availableFromBefore
        ? `${args.availableFromAfter ?? ""} → ${args.availableFromBefore ?? ""}`
        : undefined;

    const filters: Record<string, string | undefined> = {
      rent: rentRangeFilter,
      bedrooms: args.bedrooms ?? args.bedroomsMin?.toString(),
      bathrooms: args.bathrooms ?? args.bathroomsMin?.toString(),
      roomType: args.roomType,
      listingType: args.listingType,
      furnished: args.furnished,
      locationText: args.locationText ?? args.propertyName,
      availableFrom: availableFromFilter,
    };

    const appliedFilters: Record<string, string> = {};
    const remainingFields: string[] = [];
    for (const field of RENTAL_FILTER_FIELDS) {
      const value = filters[field];
      if (value) {
        appliedFilters[field] = value;
      } else {
        remainingFields.push(field);
      }
    }
    if (args.keywords && args.keywords.length > 0) {
      appliedFilters.keywords = args.keywords.join(", ");
    }

    return {
      totalCount,
      results,
      appliedFilters,
      remainingFields,
      action:
        totalCount === 0
          ? "NO_RESULTS: Tell the user no listings matched, list the applied filters, and suggest relaxing one filter (most often: drop one keyword, widen rent, or broaden location). Offer 1-2 concrete relaxations and ask if they want to retry."
          : totalCount <= 8
            ? "SHOW_RESULTS_NOW: You MUST display ALL results below to the user immediately. Do NOT ask any more questions."
            : `ASK_TO_NARROW: ${totalCount} listings matched, which is too many. Pick ONE field from remainingFields (or suggest a new keyword) that would best narrow it down based on the variety in the sample, and ask the user a single natural question.`,
    };
  },
});
