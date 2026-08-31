/** 把各种写法统一成 E.164：5551230001 / (555) 123-0001 / +1 555 123 0001 → +15551230001 */
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return digits;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return digits ? `+${digits}` : "";
}
