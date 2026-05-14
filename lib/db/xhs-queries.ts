import "server-only";

import { neon } from "@neondatabase/serverless";

const xhsDatabaseUrl = process.env.POSTGRES_URL;

if (!xhsDatabaseUrl) {
  throw new Error("POSTGRES_URL must be set");
}

const sql = neon(xhsDatabaseUrl);

export type CreateXhsRentalListingInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  rent?: string | null;
  deposit?: string | null;
  availableFrom?: string | null;
  leaseEndDate?: string | null;
  listingType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  propertyName?: string | null;
  locationText?: string | null;
  furnished?: string | null;
  contactMethod?: string | null;
};

type InsertedXhsRentalListing = {
  id: string;
};

type XhsListingImageRow = {
  id: string;
  imageUrls: string[] | null;
};

export async function createXhsRentalListing(
  input: CreateXhsRentalListingInput
) {
  const rows = (await sql`
    insert into "XhsRentalListing" (
      "sourceUrl",
      "title",
      "rawText",
      "rent",
      "deposit",
      "availableFrom",
      "leaseEndDate",
      "listingType",
      "bedrooms",
      "bathrooms",
      "roomType",
      "propertyName",
      "locationText",
      "furnished",
      "contactMethod",
      "createdAt"
    )
    values (
      ${input.sourceUrl},
      ${input.title ?? null},
      ${input.rawText},
      ${input.rent ?? null},
      ${input.deposit ?? null},
      ${input.availableFrom ?? null},
      ${input.leaseEndDate ?? null},
      ${input.listingType ?? null},
      ${input.bedrooms ?? null},
      ${input.bathrooms ?? null},
      ${input.roomType ?? null},
      ${input.propertyName ?? null},
      ${input.locationText ?? null},
      ${input.furnished ?? null},
      ${input.contactMethod ?? null},
      ${new Date().toISOString()}
    )
    returning "id"
  `) as InsertedXhsRentalListing[];

  return rows.at(0) ?? null;
}

export type AppendXhsListingImageResult = {
  id: string | null;
  imageUrlsLength: number;
  duplicated: boolean;
  listingFound: boolean;
};

export async function appendXhsListingImageUrl(
  sourceUrl: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = (await sql`
    select "id", "imageUrls"
    from "XhsRentalListing"
    where "sourceUrl" = ${sourceUrl}
    limit 1
  `) as XhsListingImageRow[];

  const existing = rows.at(0);
  const list: string[] = Array.isArray(existing?.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing?.id ?? null,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: Boolean(existing),
    };
  }

  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  list.push(blobPublicUrl);
  await sql`
    update "XhsRentalListing"
    set "imageUrls" = ${JSON.stringify(list)}::jsonb
    where "id" = ${existing.id}
  `;

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}
