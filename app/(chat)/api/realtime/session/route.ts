import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";

/** Realtime GA: create ephemeral client secret for browser WebSocket. */
const OPENAI_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

/** Map BCP 47 (e.g. en-US) to ISO 639-1 (e.g. en) for Realtime API. */
function toLanguageTag(bcp47: string): string {
  const first = bcp47.split("-")[0];
  return first?.toLowerCase() ?? "en";
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key not configured" },
      { status: 500 },
    );
  }

  let body: { language?: string } = {};
  try {
    const contentType = request.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const raw = await request.json();
      body = typeof raw === "object" && raw !== null ? raw : {};
    }
  } catch {
    // optional body
  }

  const language = typeof body.language === "string" ? body.language : "en";
  const languageTag = toLanguageTag(language);

  const payload = {
    session: {
      type: "transcription" as const,
      audio: {
        input: {
          format: { type: "audio/pcm" as const, rate: 24_000 },
          transcription: {
            language: languageTag,
            model: "gpt-4o-transcribe",
          },
          turn_detection: null,
        },
      },
    },
  };

  const response = await fetch(OPENAI_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    let details: string | undefined = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      details = parsed.error?.message ?? text;
    } catch {
      // keep raw text
    }
    const errorMessage =
      typeof details === "string" && details.length > 0
        ? `Realtime error: ${details}`
        : "Failed to create Realtime client secret";
    return NextResponse.json(
      { error: errorMessage, details },
      { status: response.status },
    );
  }

  let data: { value?: string; client_secret?: { value?: string } };
  try {
    data = JSON.parse(text) as { value?: string; client_secret?: { value?: string } };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in Realtime response" },
      { status: 500 },
    );
  }
  const token =
    "value" in data && typeof data.value === "string"
      ? data.value
      : data.client_secret?.value;
  if (!token) {
    return NextResponse.json(
      { error: "No client secret value in Realtime response" },
      { status: 500 },
    );
  }

  return NextResponse.json({ client_secret: token });
}
