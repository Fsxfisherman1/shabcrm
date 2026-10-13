import { messagingConfig } from "./config";
import { validateTwilioSignature } from "./providers";

/**
 * Reads a Twilio webhook and checks its signature. Twilio signs the public URL
 * it called, so we rebuild it from BETTER_AUTH_URL rather than trusting the
 * Host header, which can differ behind a proxy.
 * Returns null (reject) when Twilio isn't configured or the signature is wrong.
 */
export async function readTwilioWebhook(request: Request): Promise<Record<string, string> | null> {
  const { twilio, appUrl } = messagingConfig();
  if (!twilio) return null;
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form) params[key] = String(value);
  const url = new URL(request.url);
  const publicUrl = `${appUrl}${url.pathname}${url.search}`;
  const ok = validateTwilioSignature(twilio.authToken, request.headers.get("x-twilio-signature"), publicUrl, params);
  return ok ? params : null;
}

export function twiml(body = ""): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

export const forbidden = () => new Response("Forbidden", { status: 403 });

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);
}
