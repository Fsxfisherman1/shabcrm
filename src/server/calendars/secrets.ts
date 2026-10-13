import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Calendar tokens and passwords are encrypted at rest with a key derived from
// BETTER_AUTH_SECRET. Changing that secret means reconnecting calendars.
function key(purpose: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("calendar-credentials"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decryptJson<T>(payload: string): T {
  const [iv, tag, body] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key("calendar-credentials"), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
}

/** Signs a small payload (e.g. OAuth state) so it can't be forged or replayed after it expires. */
export function signState(data: Record<string, string>, ttlSeconds = 600): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", key("oauth-state")).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string | null): Record<string, string> | null {
  if (!state) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", key("oauth-state")).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, string> & { exp: number };
  if (data.exp < Date.now() / 1000) return null;
  return data;
}
