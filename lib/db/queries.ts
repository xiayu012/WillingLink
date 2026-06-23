
type ArtifactKind = string; // artifact component removed
  shift,
  xhsRentalListing,
  xhsRentalOther,
  xhsRentalWanted,
        kind: kind as "text" | "code" | "image" | "sheet",
  audioDurationMs?: number | null;
      startTime: typeof startTime === "string" ? new Date(startTime) : (startTime ?? null),
    .where(and(isNotNull(shift.audioUrl), isNotNull(shift.signUpAudioUrl)))
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
  postedAt?: Date | null;
};

export type XhsRecordKind = "listing" | "wanted" | "other";

export async function resolveXhsRecordKind(
  recordId: string
): Promise<XhsRecordKind | null> {
  const listingRows = await db
    .select({ id: xhsRentalListing.id })
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.id, recordId))
    .limit(1);
  if (listingRows[0]) {
    return "listing";
  }

  const wantedRows = await db
    .select({ id: xhsRentalWanted.id })
    .from(xhsRentalWanted)
    .where(eq(xhsRentalWanted.id, recordId))
    .limit(1);
  if (wantedRows[0]) {
    return "wanted";
  }

  const otherRows = await db
    .select({ id: xhsRentalOther.id })
    .from(xhsRentalOther)
    .where(eq(xhsRentalOther.id, recordId))
    .limit(1);
  if (otherRows[0]) {
    return "other";
  }

  return null;
}

export async function updateXhsListingSourceUrl(
  listingId: string,
  sourceUrl: string
) {
  const [row] = await db
    .update(xhsRentalListing)
    .set({ sourceUrl })
    .where(eq(xhsRentalListing.id, listingId))
    .returning({ id: xhsRentalListing.id, sourceUrl: xhsRentalListing.sourceUrl });
  return row ?? null;
}

export async function updateXhsWantedSourceUrl(
  wantedId: string,
  sourceUrl: string
) {
  const [row] = await db
    .update(xhsRentalWanted)
    .set({ sourceUrl })
    .where(eq(xhsRentalWanted.id, wantedId))
    .returning({ id: xhsRentalWanted.id, sourceUrl: xhsRentalWanted.sourceUrl });
  return row ?? null;
}

export async function updateXhsOtherSourceUrl(
  otherId: string,
  sourceUrl: string
) {
  const [row] = await db
    .update(xhsRentalOther)
    .set({ sourceUrl })
    .where(eq(xhsRentalOther.id, otherId))
    .returning({ id: xhsRentalOther.id, sourceUrl: xhsRentalOther.sourceUrl });
  return row ?? null;
}

export async function updateXhsRecordSourceUrl(
  recordId: string,
  sourceUrl: string,
  kind?: XhsRecordKind | null
) {
  const resolvedKind = kind ?? (await resolveXhsRecordKind(recordId));
  if (resolvedKind === "wanted") {
    return updateXhsWantedSourceUrl(recordId, sourceUrl);
  }
  if (resolvedKind === "other") {
    return updateXhsOtherSourceUrl(recordId, sourceUrl);
  }
  if (resolvedKind === "listing") {
    return updateXhsListingSourceUrl(recordId, sourceUrl);
  }
  return null;
}

export async function appendXhsListingImageById(
  listingId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.id, listingId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing.id,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: true,
    };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalListing)
    .set({ imageUrls: list })
    .where(eq(xhsRentalListing.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}

export async function appendXhsWantedImageById(
  wantedId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalWanted)
    .where(eq(xhsRentalWanted.id, wantedId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return {
      id: null,
      imageUrlsLength: 0,
      duplicated: false,
      listingFound: false,
    };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return {
      id: existing.id,
      imageUrlsLength: list.length,
      duplicated: true,
      listingFound: true,
    };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalWanted)
    .set({ imageUrls: list })
    .where(eq(xhsRentalWanted.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}

export async function appendXhsOtherImageById(
  otherId: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalOther)
    .where(eq(xhsRentalOther.id, otherId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    return { id: null, imageUrlsLength: 0, duplicated: false, listingFound: false };
  }

  const list: string[] = Array.isArray(existing.imageUrls)
    ? [...existing.imageUrls]
    : [];

  if (list.includes(blobPublicUrl)) {
    return { id: existing.id, imageUrlsLength: list.length, duplicated: true, listingFound: true };
  }

  list.push(blobPublicUrl);
  await db
    .update(xhsRentalOther)
    .set({ imageUrls: list })
    .where(eq(xhsRentalOther.id, existing.id));

  return { id: existing.id, imageUrlsLength: list.length, duplicated: false, listingFound: true };
}

export async function appendXhsRecordImageById(
  recordId: string,
  blobPublicUrl: string,
  kind?: XhsRecordKind | null
): Promise<AppendXhsListingImageResult> {
  const resolvedKind = kind ?? (await resolveXhsRecordKind(recordId));
  if (resolvedKind === "wanted") {
    return appendXhsWantedImageById(recordId, blobPublicUrl);
  }
  if (resolvedKind === "other") {
    return appendXhsOtherImageById(recordId, blobPublicUrl);
  }
  if (resolvedKind === "listing") {
    return appendXhsListingImageById(recordId, blobPublicUrl);
  }
  return {
    id: null,
    imageUrlsLength: 0,
    duplicated: false,
    listingFound: false,
  };
}

export type CreateXhsRentalOtherInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  aiReason?: string | null;
  postedAt?: Date | null;
};

export async function createXhsRentalOther(input: CreateXhsRentalOtherInput) {
  const [row] = await db
    .insert(xhsRentalOther)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      aiReason: input.aiReason ?? null,
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
    })
    .returning({ id: xhsRentalOther.id });
  return row ?? null;
}

export type CreateXhsRentalWantedInput = {
  sourceUrl: string;
  rawText: string;
  title?: string | null;
  budgetText?: string | null;
  budgetMin?: string | null;
  budgetMax?: string | null;
  preferredLocations?: string | null;
  moveInDate?: string | null;
  leaseDuration?: string | null;
  wantedType?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  furnished?: string | null;
  pets?: string | null;
  occupation?: string | null;
  householdSize?: string | null;
  gender?: string | null;
  requirements?: string | null;
  contactMethod?: string | null;
  aiConfidence?: string | null;
  aiReason?: string | null;
  postedAt?: Date | null;
};

export async function createXhsRentalWanted(input: CreateXhsRentalWantedInput) {
  const [row] = await db
    .insert(xhsRentalWanted)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      budgetText: input.budgetText ?? null,
      budgetMin: input.budgetMin ?? null,
      budgetMax: input.budgetMax ?? null,
      preferredLocations: input.preferredLocations ?? null,
      moveInDate: input.moveInDate ?? null,
      leaseDuration: input.leaseDuration ?? null,
      wantedType: input.wantedType ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      roomType: input.roomType ?? null,
      furnished: input.furnished ?? null,
      pets: input.pets ?? null,
      occupation: input.occupation ?? null,
      householdSize: input.householdSize ?? null,
      gender: input.gender ?? null,
      requirements: input.requirements ?? null,
      contactMethod: input.contactMethod ?? null,
      aiConfidence: input.aiConfidence ?? null,
      aiReason: input.aiReason ?? null,
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
    })
    .returning({ id: xhsRentalWanted.id });
  return row ?? null;
}

export async function createXhsRentalListing(
  input: CreateXhsRentalListingInput
) {
  const [row] = await db
    .insert(xhsRentalListing)
    .values({
      sourceUrl: input.sourceUrl,
      rawText: input.rawText,
      title: input.title ?? null,
      rent: input.rent ?? null,
      deposit: input.deposit ?? null,
      availableFrom: input.availableFrom ?? null,
      leaseEndDate: input.leaseEndDate ?? null,
      listingType: input.listingType ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      roomType: input.roomType ?? null,
      propertyName: input.propertyName ?? null,
      locationText: input.locationText ?? null,
      furnished: input.furnished ?? null,
      contactMethod: input.contactMethod ?? null,
      postedAt: input.postedAt ?? null,
      createdAt: new Date(),
    })
    .returning({ id: xhsRentalListing.id });
  return row ?? null;
}

export type AppendXhsListingImageResult = {
  id: string | null;
  imageUrlsLength: number;
  duplicated: boolean;
  listingFound: boolean;
};

/** 按 sourceUrl 将 Blob 公开 URL 追加到 imageUrls；无记录则返回未命中 */
export async function appendXhsListingImageUrl(
  sourceUrl: string,
  blobPublicUrl: string
): Promise<AppendXhsListingImageResult> {
  const rows = await db
    .select()
    .from(xhsRentalListing)
    .where(eq(xhsRentalListing.sourceUrl, sourceUrl))
    .limit(1);

  const existing = rows[0];
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
  await db
    .update(xhsRentalListing)
    .set({ imageUrls: list })
    .where(eq(xhsRentalListing.id, existing.id));

  return {
    id: existing.id,
    imageUrlsLength: list.length,
    duplicated: false,
    listingFound: true,
  };
}

// --- Rental search (AI chat tool) ---

export type SearchXhsRentalListingsArgs = {
  /** ??????????????????????????? */
  bedrooms?: string | null;
  bathrooms?: string | null;
  roomType?: string | null;
  listingType?: string | null;
  furnished?: string | null;
  propertyName?: string | null;
  locationText?: string | null;
  /** ???????????rent / bathrooms ??text ????????????????????? */
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsMin?: number | null;
  bathroomsMin?: number | null;
  /** ???????????SO ???????????vailableFrom ??text ??? */
  availableFromAfter?: string | null;
  availableFromBefore?: string | null;
  /**
   * ???????????????"???"?????????"??????/??????/?????????   * ??rawText/title/locationText/propertyName ?????OR ????????   * ????????AND????????????????????   */
  keywords?: string[] | null;
};

export type XhsRentalSearchResultRow = {
  id: string;
  sourceUrl: string;
  title: string | null;
  rawText: string;
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
  imageUrls: string[] | null;
  createdAt: Date;
};

const RENTAL_RESULT_LIMIT = 20;

/** pgvector ????????? embedding ????????*/
export async function vectorSearchXhsRentalListings(
  queryEmbedding: number[],
  candidateLimit = 20,
  excludeIds: string[] = []
): Promise<XhsRentalSearchResultRow[]> {
  try {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const rows =
      excludeIds.length > 0
        ? await client`
            SELECT
              "id", "sourceUrl", "title", "rawText", "rent", "deposit",
              "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
              "roomType", "propertyName", "locationText", "furnished", "contactMethod",
              "imageUrls", "createdAt"
            FROM "XhsRentalListing"
            WHERE embedding IS NOT NULL
              AND "id" != ALL(${excludeIds}::uuid[])
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${candidateLimit}
          `
        : await client`
            SELECT
              "id", "sourceUrl", "title", "rawText", "rent", "deposit",
              "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
              "roomType", "propertyName", "locationText", "furnished", "contactMethod",
              "imageUrls", "createdAt"
            FROM "XhsRentalListing"
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${candidateLimit}
          `;

    return rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      rent: (row.rent as string | null) ?? null,
      deposit: (row.deposit as string | null) ?? null,
      availableFrom: (row.availableFrom as string | null) ?? null,
      leaseEndDate: (row.leaseEndDate as string | null) ?? null,
      listingType: (row.listingType as string | null) ?? null,
      bedrooms: (row.bedrooms as string | null) ?? null,
      bathrooms: (row.bathrooms as string | null) ?? null,
      roomType: (row.roomType as string | null) ?? null,
      propertyName: (row.propertyName as string | null) ?? null,
      locationText: (row.locationText as string | null) ?? null,
      furnished: (row.furnished as string | null) ?? null,
      contactMethod: (row.contactMethod as string | null) ?? null,
      imageUrls: Array.isArray(row.imageUrls)
        ? (row.imageUrls as string[])
        : null,
      createdAt: row.createdAt as Date,
    }));
  } catch (error) {
    console.error("Failed to vector search XhsRentalListing:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to vector search rental listings"
    );
  }
}

/** ????????????????????????????????? */
export async function updateListingEmbedding(
  id: string,
  embedding: number[]
): Promise<void> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  await client`
    UPDATE "XhsRentalListing"
    SET embedding = ${vectorLiteral}::vector
    WHERE id = ${id}::uuid
  `;
}

export async function searchXhsRentalListings({
  bedrooms,
  bathrooms,
  roomType,
  listingType,
  furnished,
  propertyName,
  locationText,
  rentMin,
  rentMax,
  bedroomsMin,
  bathroomsMin,
  availableFromAfter,
  availableFromBefore,
  keywords,
}: SearchXhsRentalListingsArgs) {
  try {
    const cleanKeywords = (keywords ?? [])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k.length > 0);

    const rows = await client`
      SELECT
        "id", "sourceUrl", "title", "rawText", "rent", "deposit",
        "availableFrom", "leaseEndDate", "listingType", "bedrooms", "bathrooms",
        "roomType", "propertyName", "locationText", "furnished", "contactMethod",
        "imageUrls", "createdAt",
        COUNT(*) OVER() AS total_count
      FROM "XhsRentalListing"
      WHERE
            (${bedrooms ?? null}::text     IS NULL OR "bedrooms"     ILIKE '%' || ${bedrooms ?? null} || '%')
        AND (${bathrooms ?? null}::text    IS NULL OR "bathrooms"    ILIKE '%' || ${bathrooms ?? null} || '%')
        AND (${roomType ?? null}::text     IS NULL OR "roomType"     ILIKE '%' || ${roomType ?? null} || '%')
        AND (${listingType ?? null}::text  IS NULL OR "listingType"  ILIKE '%' || ${listingType ?? null} || '%')
        AND (${furnished ?? null}::text    IS NULL OR "furnished"    ILIKE '%' || ${furnished ?? null} || '%')
        AND (${propertyName ?? null}::text IS NULL OR "propertyName" ILIKE '%' || ${propertyName ?? null} || '%')
        AND (${locationText ?? null}::text IS NULL OR "locationText" ILIKE '%' || ${locationText ?? null} || '%')
        AND (${rentMin ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("rent" from '\\d+'), '')::int, 0)  >= ${rentMin ?? null}::int)
        AND (${rentMax ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("rent" from '\\d+'), '')::int, 999999) <= ${rentMax ?? null}::int)
        AND (${bedroomsMin ?? null}::int  IS NULL OR COALESCE(NULLIF(substring("bedrooms"  from '\\d+'), '')::int, 0) >= ${bedroomsMin ?? null}::int)
        AND (${bathroomsMin ?? null}::int IS NULL OR COALESCE(NULLIF(substring("bathrooms" from '\\d+'), '')::int, 0) >= ${bathroomsMin ?? null}::int)
        AND (${availableFromAfter ?? null}::text  IS NULL OR "availableFrom" >= ${availableFromAfter ?? null})
        AND (${availableFromBefore ?? null}::text IS NULL OR "availableFrom" <= ${availableFromBefore ?? null})
        AND (
          ${cleanKeywords.length === 0}::boolean
          OR (
            SELECT bool_and(
              "rawText"      ILIKE '%' || kw || '%'
              OR COALESCE("title", '')        ILIKE '%' || kw || '%'
              OR COALESCE("locationText", '') ILIKE '%' || kw || '%'
              OR COALESCE("propertyName", '') ILIKE '%' || kw || '%'
            )
            FROM unnest(${cleanKeywords}::text[]) AS kw
          )
        )
      ORDER BY "createdAt" DESC
      LIMIT ${RENTAL_RESULT_LIMIT}
    `;

    const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;

    const results: XhsRentalSearchResultRow[] = rows.map((row) => ({
      id: row.id as string,
      sourceUrl: row.sourceUrl as string,
      title: (row.title as string | null) ?? null,
      rawText: row.rawText as string,
      rent: (row.rent as string | null) ?? null,
      deposit: (row.deposit as string | null) ?? null,
      availableFrom: (row.availableFrom as string | null) ?? null,
      leaseEndDate: (row.leaseEndDate as string | null) ?? null,
      listingType: (row.listingType as string | null) ?? null,
      bedrooms: (row.bedrooms as string | null) ?? null,
      bathrooms: (row.bathrooms as string | null) ?? null,
      roomType: (row.roomType as string | null) ?? null,
      propertyName: (row.propertyName as string | null) ?? null,
      locationText: (row.locationText as string | null) ?? null,
      furnished: (row.furnished as string | null) ?? null,
      contactMethod: (row.contactMethod as string | null) ?? null,
      imageUrls: Array.isArray(row.imageUrls)
        ? (row.imageUrls as string[])
        : null,
      createdAt: row.createdAt as Date,
    }));

    return { totalCount, results };
  } catch (error) {
    console.error("Failed to search XhsRentalListing:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to search rental listings"
    );
  }
}

export type ListingForTransit = {
  id: string;
  locationText: string | null;
  propertyName: string | null;
  title: string | null;
  rent: string | null;
  roomType: string | null;
  bedrooms: string | null;
  sourceUrl: string;
  lat: number | null;
  lng: number | null;
};

/** ????????????????????????????????????? */
export async function getListingsForTransitSearch(): Promise<
  ListingForTransit[]
> {
  try {
    const rows = await client`
      SELECT
        "id", "locationText", "propertyName", "title",
        "rent", "roomType", "bedrooms", "sourceUrl",
        "lat", "lng"
      FROM "XhsRentalListing"
      WHERE "locationText" IS NOT NULL
         OR ("lat" IS NOT NULL AND "lng" IS NOT NULL)
      ORDER BY "createdAt" DESC
    `;
    return rows.map((r) => ({
      id: r.id as string,
      locationText: (r.locationText as string | null) ?? null,
      propertyName: (r.propertyName as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      rent: (r.rent as string | null) ?? null,
      roomType: (r.roomType as string | null) ?? null,
      bedrooms: (r.bedrooms as string | null) ?? null,
      sourceUrl: r.sourceUrl as string,
      lat: r.lat !== null && r.lat !== undefined ? Number(r.lat) : null,
      lng: r.lng !== null && r.lng !== undefined ? Number(r.lng) : null,
    }));
  } catch (error) {
    console.error("Failed to get listings for transit search:", error);
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get listings for transit search"
    );
  }
}

/** ????????????????????*/
export async function updateListingGeocode(
  id: string,
  lat: number,
  lng: number
): Promise<void> {
  try {
    // lat/lng may not exist in current Drizzle schema; use raw SQL to stay forward-compatible
    await client`
      UPDATE "XhsRentalListing"
      SET lat = ${lat}, lng = ${lng}
      WHERE id = ${id}::uuid
    `;
  } catch (error) {
    console.error("Failed to update listing geocode:", error);
  }
}