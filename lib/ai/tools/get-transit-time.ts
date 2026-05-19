import { tool } from "ai";
import { z } from "zod";

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";

const RE_SANFRANSHI = /三藩市/g;
const RE_JIUJIUSHAN = /旧金山/g;
const RE_WANQU = /湾区/g;
const RE_AOKELAND = /奥克兰/g;
const RE_BOLI = /伯克利/g;
const RE_SHENGHEXI = /圣何塞/g;
const RE_PALOALTO = /帕罗奥图/g;
const RE_SHANJINGCHENG = /山景城/g;
const RE_SANGNIYWEIER = /桑尼维尔/g;
const RE_SHENGKELALA = /圣克拉拉/g;
const RE_FULEIMENGDE = /弗里蒙特/g;
const RE_DAILI = /戴利城/g;
const RE_NANBEI = /南湾/g;
const RE_DONGWAN = /东湾/g;
const RE_BEIBEI = /北湾/g;
const RE_JIAOKOUPHRASE = /和(.+?)交口/g;
const RE_JIAOKOU = /交口/g;
const RE_CHINESE_COMMA = /，/g;
const RE_MULTI_SPACE = /\s{2,}/g;

function normalizeAddress(raw: string): string {
  return raw
    .replace(RE_SANFRANSHI, "San Francisco")
    .replace(RE_JIUJIUSHAN, "San Francisco")
    .replace(RE_WANQU, "Bay Area, CA")
    .replace(RE_AOKELAND, "Oakland")
    .replace(RE_BOLI, "Berkeley")
    .replace(RE_SHENGHEXI, "San Jose")
    .replace(RE_PALOALTO, "Palo Alto")
    .replace(RE_SHANJINGCHENG, "Mountain View")
    .replace(RE_SANGNIYWEIER, "Sunnyvale")
    .replace(RE_SHENGKELALA, "Santa Clara")
    .replace(RE_FULEIMENGDE, "Fremont")
    .replace(RE_DAILI, "Daly City")
    .replace(RE_NANBEI, "South Bay, CA")
    .replace(RE_DONGWAN, "East Bay, CA")
    .replace(RE_BEIBEI, "North Bay, CA")
    .replace(RE_JIAOKOUPHRASE, "and $1")
    .replace(RE_JIAOKOU, "")
    .replace(RE_CHINESE_COMMA, ", ")
    .replace(RE_MULTI_SPACE, " ")
    .trim();
}

type GoogleGeocodeResponse = {
  status: string;
  results: Array<{
    formatted_address: string;
    geometry: { location: { lat: number; lng: number } };
  }>;
};

type GoogleDirectionsResponse = {
  status: string;
  routes: Array<{
    legs: Array<{
      duration: { value: number; text: string };
    }>;
  }>;
};

async function geocode(
  address: string
): Promise<{ lat: number; lng: number; formatted: string } | null> {
  const normalized = normalizeAddress(address);
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?address=${encodeURIComponent(normalized)}` +
    `&region=us` +
    `&components=country:US` +
    `&key=${GOOGLE_MAPS_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as GoogleGeocodeResponse;
    if (data.status !== "OK" || data.results.length === 0) return null;
    const r = data.results[0];
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted: r.formatted_address,
    };
  } catch {
    return null;
  }
}

export const getTransitTime = tool({
  description:
    "Calculate the public transit commute time between the user's address and a specific rental listing's address. " +
    "Call this when the user has already found a specific listing (via searchRental) and now asks about commute time to it, " +
    "e.g. '这个房子通勤多久', '从我家去这个房源要多久', '这个房子离我多远', 'how long to commute to this listing', " +
    "'这个房源的通勤时间'. " +
    "You must extract BOTH the user's origin address from the conversation history AND the listing's locationText from the previous search results. " +
    "If the user's address was mentioned earlier in the conversation, reuse it — do NOT ask again.",
  inputSchema: z.object({
    userAddress: z
      .string()
      .describe(
        "The user's home/current address extracted from the conversation. E.g. '三藩市 10th Ave' or '123 Main St, Mountain View'."
      ),
    listingAddress: z
      .string()
      .describe(
        "The listing's locationText or propertyName from the search results, e.g. 'Union City, CA' or 'San Francisco, Irving St'."
      ),
    listingTitle: z
      .string()
      .optional()
      .describe("The listing title for display purposes."),
  }),
  execute: async ({ userAddress, listingAddress, listingTitle }) => {
    if (!GOOGLE_MAPS_KEY) {
      return {
        error: "MAPS_API_NOT_CONFIGURED" as const,
        message: "Google Maps API key is not configured.",
      };
    }

    const [originGeo, destGeo] = await Promise.all([
      geocode(userAddress),
      geocode(listingAddress),
    ]);

    if (!originGeo) {
      return {
        error: "ORIGIN_GEOCODE_FAILED" as const,
        message: `Could not resolve your address "${userAddress}". Please clarify your location.`,
      };
    }

    if (!destGeo) {
      return {
        error: "DEST_GEOCODE_FAILED" as const,
        message: `Could not resolve the listing address "${listingAddress}".`,
      };
    }

    const departureTime = Math.floor(Date.now() / 1_000) + 60;
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${originGeo.lat},${originGeo.lng}` +
      `&destination=${destGeo.lat},${destGeo.lng}` +
      `&mode=transit` +
      `&departure_time=${departureTime}` +
      `&key=${GOOGLE_MAPS_KEY}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        return {
          error: "TRANSIT_API_ERROR" as const,
          message: "Transit directions API request failed.",
        };
      }
      const data = (await res.json()) as GoogleDirectionsResponse;
      if (data.status !== "OK" || data.routes.length === 0) {
        return {
          error: "TRANSIT_UNAVAILABLE" as const,
          message: `No transit route found between "${userAddress}" and "${listingAddress}".`,
        };
      }
      const leg = data.routes[0].legs[0];
      return {
        originFormatted: originGeo.formatted,
        destinationFormatted: destGeo.formatted,
        listingTitle: listingTitle ?? null,
        transitMinutes: Math.round(leg.duration.value / 60),
        transitDurationText: leg.duration.text,
      };
    } catch {
      return {
        error: "TRANSIT_UNAVAILABLE" as const,
        message: "Failed to fetch transit directions.",
      };
    }
  },
});
