/**
 * GET /api/gpt/listings/{id}
 *
 * Returns the full details of a single XhsRentalListing including rawText.
 * Use this after searchListings to get the complete post content and contact info.
 *
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import postgres from "postgres";
import { requireGptKey } from "@/lib/api/gpt-auth";

// biome-ignore lint/style/noNonNullAssertion: required env var
const client = postgres(process.env.POSTGRES_URL!);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return Response.json(
      { error: "Invalid id format — must be a UUID" },
      { status: 400 }
    );
  }

  try {
    const rows = await client`
      SELECT
        id, "sourceUrl", title, "rawText",
        rent, "rentNumeric", deposit,
        "availableFrom", "leaseEndDate",
        "listingType", bedrooms, "bedroomsNum", bathrooms, "roomType",
        "propertyName", "locationText", city,
        furnished, "contactMethod",
        "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded",
        "imageUrls", "postedAt", "createdAt"
      FROM "XhsRentalListing"
      WHERE id = ${id}::uuid
      LIMIT 1
    `;

    if (rows.length === 0) {
      return Response.json({ error: "Listing not found" }, { status: 404 });
    }

    const row = rows[0];

    return Response.json({
      id: row.id,
      sourceUrl: row.sourceUrl,
      title: row.title,
      rawText: row.rawText,
      rent: row.rent,
      rentNumeric: row.rentNumeric,
      deposit: row.deposit,
      availableFrom: row.availableFrom,
      leaseEndDate: row.leaseEndDate,
      listingType: row.listingType,
      bedrooms: row.bedrooms,
      bedroomsNum: row.bedroomsNum,
      bathrooms: row.bathrooms,
      roomType: row.roomType,
      propertyName: row.propertyName,
      locationText: row.locationText,
      city: row.city,
      furnished: row.furnished,
      contactMethod: row.contactMethod,
      petFriendly: row.petFriendly,
      couplesOk: row.couplesOk,
      utilitiesIncluded: row.utilitiesIncluded,
      parkingIncluded: row.parkingIncluded,
      imageUrls: row.imageUrls,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/listings/id] error:", msg);
    return Response.json(
      { error: "Database query failed", detail: msg },
      { status: 500 }
    );
  }
}
