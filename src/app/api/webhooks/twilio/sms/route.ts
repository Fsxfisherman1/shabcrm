import { db } from "@/db";
import { receivePhoneMessage } from "@/server/messaging";
import { forbidden, readTwilioWebhook, twiml } from "@/server/messaging/webhooks";

// Twilio calls this when someone texts one of our numbers, or messages one of
// our WhatsApp senders (those numbers come as "whatsapp:+1555…").
export async function POST(request: Request) {
  const params = await readTwilioWebhook(request);
  if (!params) return forbidden();
  const whatsapp = params.From?.startsWith("whatsapp:");
  const strip = (n = "") => n.replace(/^whatsapp:/, "");
  await receivePhoneMessage(db, {
    channel: whatsapp ? "whatsapp" : "sms",
    from: strip(params.From),
    to: strip(params.To),
    body: params.Body ?? "",
    providerId: params.MessageSid,
  });
  // Empty reply: Twilio itself answers STOP/START with its standard confirmation text.
  return twiml();
}
