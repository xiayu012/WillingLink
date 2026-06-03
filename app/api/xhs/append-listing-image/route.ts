import { put } from "@vercel/blob";
import { randomUUID } from "crypto";

import {
  appendXhsListingImageById,
  appendXhsListingImageUrl,
} from "@/lib/db/queries";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function extFromMime(mime: string): string {
  if (mime === "image/jpeg") {
    return "jpg";
  }
  if (mime === "image/png") {
    return "png";
  }
  if (mime === "image/webp") {
    return "webp";
  }
  return "bin";
}

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid form data" }, 400);
  }

  const listingIdRaw = formData.get("listingId");
  const listingId =
    typeof listingIdRaw === "string" ? listingIdRaw.trim() : "";
  const sourceUrlRaw = formData.get("sourceUrl");
  const sourceUrl =
    typeof sourceUrlRaw === "string" ? sourceUrlRaw.trim() : "";
  if (!listingId && !sourceUrl) {
    return jsonWithCors(
      { ok: false, error: "listingId or sourceUrl is required" },
      400
    );
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return jsonWithCors({ ok: false, error: "file is required" }, 400);
  }

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(mime)) {
    return jsonWithCors(
      { ok: false, error: "File type must be JPEG, PNG, or WebP" },
      400
    );
  }

  if (file.size > MAX_BYTES) {
    return jsonWithCors(
      { ok: false, error: "File too large (max 25MB)" },
      400
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = extFromMime(mime);
  const path = `xhs-listing-images/${randomUUID()}.${ext}`;

  let blobUrl: string;
  try {
    const data = await put(path, buffer, { access: "public" });
    blobUrl = data.url;
  } catch (error) {
    return jsonWithCors(
      {
        ok: false,
        error: "Upload failed",
        stage: "blob-put",
        detail: errorMessage(error),
      },
      500
    );
  }

  let result;
  try {
    result = listingId
      ? await appendXhsListingImageById(listingId, blobUrl)
      : await appendXhsListingImageUrl(sourceUrl, blobUrl);
  } catch (error) {
    return jsonWithCors(
      {
        ok: false,
        error: "Failed to append image URL",
        stage: "db-append-image",
        detail: errorMessage(error),
      },
      500
    );
  }
  if (!result.listingFound) {
    return jsonWithCors(
      {
        ok: false,
        error: "Listing not found for sourceUrl; ingest raw text first",
        code: "LISTING_NOT_FOUND",
      },
      409
    );
  }

  return jsonWithCors({
    ok: true,
    url: blobUrl,
    id: result.id,
    imageUrlsLength: result.imageUrlsLength,
    duplicated: result.duplicated,
  });
}
