import { randomUUID } from "node:crypto";

import { put } from "@vercel/blob";
import { appendXhsListingImageUrl } from "@/lib/db/xhs-queries";

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

  const sourceUrlRaw = formData.get("sourceUrl");
  const sourceUrl = typeof sourceUrlRaw === "string" ? sourceUrlRaw.trim() : "";
  if (!sourceUrl) {
    return jsonWithCors({ ok: false, error: "sourceUrl is required" }, 400);
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
    return jsonWithCors({ ok: false, error: "File too large (max 25MB)" }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = extFromMime(mime);
  const path = `xhs-listing-images/${randomUUID()}.${ext}`;

  let blobUrl: string;
  try {
    const data = await put(path, buffer, { access: "public" });
    blobUrl = data.url;
  } catch {
    return jsonWithCors({ ok: false, error: "Upload failed" }, 500);
  }

  const result = await appendXhsListingImageUrl(sourceUrl, blobUrl);
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
