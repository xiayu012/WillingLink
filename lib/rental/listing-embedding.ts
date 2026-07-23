/**
 * Shared embedding-document composition for XhsRentalListing.
 *
 * Every path that writes an embedding (ingest route, scraper, backfill script)
 * MUST embed the SAME composed document, or vectors from different writers
 * live in different semantic spaces and ranking silently degrades.
 *
 * Why compose instead of embedding rawText directly:
 * - Listings are written in mixed Chinese/English ("圣荷塞" vs "San Jose"),
 *   while the query side geo-expands to English. Prefixing a canonical
 *   bilingual city line makes the two sides meet.
 * - Structured fields (rent, room type, move-in date) are often buried in
 *   noisy prose; surfacing them as labeled lines gives the embedding model
 *   clean signal.
 * - Deliberately NO neighbor cities here — the query side already expands
 *   neighbors. Expanding both sides would blur city boundaries two hops out.
 */

import { CITY_TABLE, detectCity } from "./cities";

export type ListingEmbeddingFields = {
  rawText: string;
  title?: string | null;
  city?: string | null;
  locationText?: string | null;
  propertyName?: string | null;
  rent?: string | null;
  roomType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  listingType?: string | null;
  availableFrom?: string | null;
  furnished?: string | null;
};

/** Resolve a canonical bilingual "San Jose 圣何塞" city label, or null. */
function resolveCityLabel(fields: ListingEmbeddingFields): string | null {
  // Prefer the structured city column (English canonical name)
  if (fields.city) {
    const entry = CITY_TABLE.find(
      (c) => c.en.toLowerCase() === fields.city?.trim().toLowerCase()
    );
    if (entry) {
      return `${entry.en} ${entry.zh}`;
    }
    return fields.city;
  }
  // Fall back to detecting a city anywhere in the listing text
  const haystack = [fields.title, fields.locationText, fields.rawText]
    .filter(Boolean)
    .join(" ");
  const detected = detectCity(haystack);
  return detected ? `${detected.en} ${detected.zh}` : null;
}

/**
 * Compose the canonical document text to embed for one listing.
 * Deterministic; skips absent fields; rawText always last.
 */
export function composeListingEmbeddingDoc(
  fields: ListingEmbeddingFields
): string {
  const lines: string[] = [];

  if (fields.title) {
    lines.push(`标题: ${fields.title}`);
  }

  const cityLabel = resolveCityLabel(fields);
  if (cityLabel) {
    lines.push(`城市: ${cityLabel}`);
  }
  if (fields.locationText) {
    lines.push(`位置: ${fields.locationText}`);
  }
  if (fields.propertyName) {
    lines.push(`小区: ${fields.propertyName}`);
  }
  if (fields.rent) {
    lines.push(`租金: ${fields.rent}`);
  }

  const roomBits = [
    fields.roomType,
    fields.bedrooms ? `${fields.bedrooms}室` : null,
    fields.bathrooms ? `${fields.bathrooms}卫` : null,
    fields.listingType,
  ].filter(Boolean);
  if (roomBits.length > 0) {
    lines.push(`房型: ${roomBits.join(" ")}`);
  }

  if (fields.availableFrom) {
    lines.push(`入住时间: ${fields.availableFrom}`);
  }
  if (fields.furnished) {
    lines.push(`家具: ${fields.furnished}`);
  }

  lines.push(fields.rawText);
  return lines.join("\n");
}
