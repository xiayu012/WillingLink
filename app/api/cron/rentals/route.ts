import { NextResponse } from "next/server";
import { crawlChineseInSfBayRentals } from "@/lib/rental/crawler";

export const runtime = "nodejs";

function hasValidCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return false;
  }

  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) {
    return false;
  }

  const providedSecret = authHeader.slice(prefix.length);
  return providedSecret === secret;
}

export async function GET(request: Request) {
  if (!hasValidCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await crawlChineseInSfBayRentals();
    return NextResponse.json(
      {
        ok: true,
        sourceSite: "chineseinsfbay",
        sourceForum: "f_5",
        ...result,
      },
      { status: 200 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown crawler error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
