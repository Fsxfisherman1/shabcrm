import { db } from "@/db";
import { handleCallEnded } from "@/server/messaging";
import { emailProvider, messagingConfig, smsProvider } from "@/server/messaging/config";
import { forbidden, readTwilioWebhook, twiml } from "@/server/messaging/webhooks";

// Twilio calls this when the forwarded call ends (answered or not).
export async function POST(request: Request) {
  const params = await readTwilioWebhook(request);
  if (!params) return forbidden();
  const { appUrl } = messagingConfig();
  await handleCallEnded(
    db,
    { to: params.To, from: params.From, dialStatus: params.DialCallStatus ?? "" },
    { sms: smsProvider(), email: emailProvider() },
    { appUrl },
  );
  return twiml("<Hangup/>");
}
