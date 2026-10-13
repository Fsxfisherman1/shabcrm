import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { receiveEmail } from "@/server/messaging";
import { messagingConfig } from "@/server/messaging/config";
import { forbidden } from "@/server/messaging/webhooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InboundEmail = {
  MessageID?: string;
  From?: string;
  FromName?: string;
  FromFull?: { Email?: string; Name?: string };
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  MailboxHash?: string;
};

function secretMatches(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Postmark calls this when someone replies to an email we sent. The reply-to
// address carries the account id after a "+", which Postmark hands us as MailboxHash.
export async function POST(request: Request) {
  const { inboundEmailSecret } = messagingConfig();
  if (!inboundEmailSecret || !secretMatches(new URL(request.url).searchParams.get("token"), inboundEmailSecret)) {
    return forbidden();
  }
  const email = (await request.json().catch(() => null)) as InboundEmail | null;
  const from = email?.FromFull?.Email ?? email?.From;
  // Postmark retries on errors, so anything we can't route is acknowledged and dropped.
  if (!email || !from || !UUID.test(email.MailboxHash ?? "")) return new Response(null, { status: 204 });
  await receiveEmail(db, {
    workspaceId: email.MailboxHash!,
    from,
    fromName: email.FromFull?.Name ?? email.FromName,
    subject: email.Subject ?? "",
    text: (email.StrippedTextReply || email.TextBody || "").trim(),
    providerId: email.MessageID,
  });
  return new Response(null, { status: 204 });
}
