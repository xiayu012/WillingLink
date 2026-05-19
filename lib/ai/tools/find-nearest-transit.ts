import { tool } from "ai";
import { z } from "zod";
import {
  getListingsForTransitSearch,
  type ListingForTransit,
  updateListingGeocode,
} from "@/lib/db/queries";

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";

const MAX_TRANSIT_CANDIDATES = 10;

type GeoPoint = { lat: number; lng: number; formattedAddress: string };

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

type TransitResult = { minutes: number; durationText: string };

type ListingWithCoords = ListingForTransit & { lat: number; lng: number };

type RankedListing = {
  listing: ListingWithCoords;
  distanceKm: number;
  transit: TransitResult;
};

// Top-level regex declarations (must stay at module scope to avoid re-creation)
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

/**
 * Normalize a Chinese-language address into a form that Google Maps geocoding understands.
 * Replaces common Chinese Bay Area city names and intersection phrases with English equivalents.
 */
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

async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  if (!GOOGLE_MAPS_KEY) return null;
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
    const result = data.results[0];
    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formattedAddress: result.formatted_address,
    };
  } catch {
    return null;
  }
}

async function getTransitDuration(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<TransitResult | null> {
  if (!GOOGLE_MAPS_KEY) return null;
  const departureTime = Math.floor(Date.now() / 1_000) + 60;
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${originLat},${originLng}` +
    `&destination=${destLat},${destLng}` +
    `&mode=transit` +
    `&departure_time=${departureTime}` +
    `&key=${GOOGLE_MAPS_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as GoogleDirectionsResponse;
    if (data.status !== "OK" || data.routes.length === 0) return null;
    const leg = data.routes[0].legs[0];
    return {
      minutes: Math.round(leg.duration.value / 60),
      durationText: leg.duration.text,
    };
  } catch {
    return null;
  }
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const findNearestTransit = tool({
  description:
    "Find the rental listing with the shortest public transit commute from the user's address. " +
    "Call this when the user provides their address/location and wants to know which listing is closest " +
    "by public transit, or says something like '离我最近', '通勤最方便', '公共交通最快', '哪个房子离我近'. " +
    "Returns the best-matching listing ranked by transit time, plus a human-readable duration string.",
  inputSchema: z.object({
    userAddress: z
      .string()
      .describe(
        "The user's full address or location, e.g. '123 Main St, Mountain View, CA' or '三藩市 10th Ave' or '旧金山市中心'."
      ),
  }),
  execute: async ({ userAddress }) => {
    if (!GOOGLE_MAPS_KEY) {
      return {
        error: "MAPS_API_NOT_CONFIGURED" as const,
        message:
          "Google Maps API key is not set. Please add GOOGLE_MAPS_API_KEY to your environment variables.",
      };
    }

    const userGeo = await geocodeAddress(userAddress);
    if (!userGeo) {
      return {
        error: "GEOCODE_FAILED" as const,
        message: `Could not resolve the address "${userAddress}". Please try a more specific address.`,
      };
    }

    const listings = await getListingsForTransitSearch();
    if (listings.length === 0) {
      return {
        error: "NO_LISTINGS" as const,
        message: "No rental listings with location data found.",
      };
    }

    // Geocode every listing that is missing coordinates (no artificial cap —
    // Promise.all runs them in parallel and results are cached to DB for future requests)
    const needsGeocode = listings.filter(
      (l) => (l.lat === null || l.lng === null) && l.locationText
    );

    const freshGeoResults = await Promise.all(
      needsGeocode.map((l) =>
        geocodeAddress(l.locationText ?? "").then((geo) => ({
          id: l.id,
          geo,
        }))
      )
    );

    // Persist fresh geocodes back to DB
    await Promise.all(
      freshGeoResults
        .filter((r): r is { id: string; geo: GeoPoint } => r.geo !== null)
        .map((r) => updateListingGeocode(r.id, r.geo.lat, r.geo.lng))
    );

    const freshGeoMap = new Map(
      freshGeoResults
        .filter((r): r is { id: string; geo: GeoPoint } => r.geo !== null)
        .map((r) => [r.id, r.geo])
    );

    // Merge coordinates: prefer DB-cached, fall back to freshly geocoded
    const listingsWithCoords: ListingWithCoords[] = listings
      .map((l) => {
        const fresh = freshGeoMap.get(l.id);
        const lat = l.lat ?? fresh?.lat ?? null;
        const lng = l.lng ?? fresh?.lng ?? null;
        return { ...l, lat, lng };
      })
      .filter((l): l is ListingWithCoords => l.lat !== null && l.lng !== null);

    if (listingsWithCoords.length === 0) {
      return {
        error: "NO_GEOCODED_LISTINGS" as const,
        message:
          "No listings could be geocoded. Make sure listings have a locationText field and the Maps API key is valid.",
      };
    }

    // Pre-filter by straight-line distance, then check transit for top N
    const sortedByDistance = listingsWithCoords
      .map((l) => ({
        listing: l,
        distanceKm: haversineKm(userGeo.lat, userGeo.lng, l.lat, l.lng),
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_TRANSIT_CANDIDATES);

    const transitResults = await Promise.all(
      sortedByDistance.map(({ listing, distanceKm }) =>
        getTransitDuration(
          userGeo.lat,
          userGeo.lng,
          listing.lat,
          listing.lng
        ).then((transit) => ({ listing, distanceKm, transit }))
      )
    );

    const ranked: RankedListing[] = transitResults
      .filter(
        (
          r
        ): r is {
          listing: ListingWithCoords;
          distanceKm: number;
          transit: TransitResult;
        } => r.transit !== null
      )
      .sort((a, b) => a.transit.minutes - b.transit.minutes);

    if (ranked.length === 0) {
      return {
        error: "TRANSIT_UNAVAILABLE" as const,
        message:
          "Could not compute transit routes for nearby listings. Transit data may not be available in this area.",
      };
    }

    const best = ranked[0];

    return {
      userResolvedAddress: userGeo.formattedAddress,
      bestListing: best.listing,
      transitMinutes: best.transit.minutes,
      transitDurationText: best.transit.durationText,
      allCandidates: ranked.map((r) => ({
        id: r.listing.id,
        title: r.listing.title,
        locationText: r.listing.locationText,
        propertyName: r.listing.propertyName,
        rent: r.listing.rent,
        roomType: r.listing.roomType,
        bedrooms: r.listing.bedrooms,
        sourceUrl: r.listing.sourceUrl,
        transitMinutes: r.transit.minutes,
        transitDurationText: r.transit.durationText,
        distanceKm: Math.round(r.distanceKm * 10) / 10,
      })),
    };
  },
});
