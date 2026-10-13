import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalizes a phone number to E.164 (+15551234567). Returns null if invalid. */
export function normalizePhone(raw: string | null | undefined, country = "US"): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const parsed = parsePhoneNumberFromString(value, country as "US");
  return parsed?.isValid() ? parsed.number : null;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatNational() : e164;
}
