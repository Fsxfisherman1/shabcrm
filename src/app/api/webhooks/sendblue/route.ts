import { db } from "@/db";
import { receivePhoneMessage } from "@/server/messaging";
import { messagingConfig } from "@/server/messaging/config";
import { validateSharedSecret } from "@/server/messaging/providers";
import { forbidden } from "@/server/messaging/webhooks";

type SendblueMessage = {
  content?: string;
  is_outbound?: boolean;
  from_number?: string;
  to_number?: string;
  sendblue_number?: string;
  message_handle?: string;
  group_id?: string | null;
  media_url?: string | null;
};

// Sendblue calls this when someone sends an iMessage (or a text) to one of our lines.
// https://docs.sendblue.com/getting-started/webhooks/
export async function POST(request: Request) {
  const { sendblue } = messagingConfig();
  if (!sendblue || !validateSharedSecret(sendblue.webhookSecret, request.headers.get("sb-signing-secret"))) return forbidden();
  const msg = (await request.json().catch(() => null)) as SendblueMessage | null;
  // Our own sends echo back here; group chats aren't supported.
  if (!msg || msg.is_outbound || msg.group_id || !msg.from_number) return new Response(null, { status: 204 });
  const body = [msg.content, msg.media_url].filter(Boolean).join("\n");
  if (!body) return new Response(null, { status: 204 });
  await receivePhoneMessage(db, {
    channel: "imessage",
    from: msg.from_number,
    to: msg.sendblue_number ?? msg.to_number ?? "",
    body,
    providerId: msg.message_handle,
  });
  return new Response(null, { status: 204 });
}
