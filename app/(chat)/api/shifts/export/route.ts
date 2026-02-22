import { NextResponse } from "next/server";

import { getShiftsForExport } from "@/lib/db/queries";

const CSV_COLUMNS = [
  "whattodo",
  "startTime",
  "location",
  "skillsNeeded",
  "whoIsBeingHelped",
  "laborCredits",
  "audioUrl",
  "createdAt",
  "signUpUserName",
  "signUpAudioUrl",
  "signUpCreatedAt",
] as const;

function escapeCsvValue(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = value instanceof Date ? value.toISOString() : String(value);
  const needsQuotes = /[",\r\n]/.test(str);
  const escaped = str.replaceAll('"', '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function toCsvRow(row: Record<string, string | number | Date | null | undefined>): string {
  return CSV_COLUMNS.map((col) => escapeCsvValue(row[col])).join(",");
}

export async function GET() {
  try {
    const rows = await getShiftsForExport();
    const header = CSV_COLUMNS.join(",");
    const body = rows.map((row) => toCsvRow(row)).join("\r\n");
    const csv = `\uFEFF${header}\r\n${body}`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="labor-records-twin-oaks.csv"',
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to export labor records" },
      { status: 500 }
    );
  }
}
