import { NextResponse } from "next/server";
import { z } from "zod";

import { updateShiftSignUp } from "@/lib/db/queries";

const SignUpBodySchema = z.object({
  name: z.string().min(1, "Name is required"),
  audioUrl: z.string().url("Valid audio URL is required"),
  audioDurationMs: z.number().int().nonnegative().optional(),
  audioMimeType: z.string().optional(),
  audioSizeBytes: z.number().int().nonnegative().optional(),
});

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: shiftId } = await params;

  if (!shiftId) {
    return NextResponse.json(
      { error: "Shift id is required" },
      { status: 400 }
    );
  }

  let body: z.infer<typeof SignUpBodySchema>;
  try {
    const raw = await _request.json();
    const parsed = SignUpBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.errors.map((e) => e.message).join("; ");
      return NextResponse.json({ error: message }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  try {
    const updated = await updateShiftSignUp({
      shiftId,
      signUpUserName: body.name,
      signUpAudioUrl: body.audioUrl,
      signUpAudioDurationMs: body.audioDurationMs ?? null,
      signUpAudioMimeType: body.audioMimeType ?? null,
      signUpAudioSizeBytes: body.audioSizeBytes ?? null,
    });

    if (!updated) {
      return NextResponse.json({ error: "Shift not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to update shift sign-up" },
      { status: 500 }
    );
  }
}
