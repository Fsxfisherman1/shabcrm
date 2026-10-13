import { db } from "@/db";
import { handleCallEnded, workspaceBySmsNumber } from "@/server/messaging";
import { messagingConfig, smsProvider, emailProvider } from "@/server/messaging/config";
import { escapeXml, forbidden, readTwilioWebhook, twiml } from "@/server/messaging/webhooks";

// Twilio calls this when someone phones one of our numbers. We ring the
// business's real phone; if nobody answers, voice-status texts the caller back.
export async function POST(request: Request) {
  const params = await readTwilioWebhook(request);
  if (!params) return forbidden();
  const { appUrl } = messagingConfig();
  const workspace = await workspaceBySmsNumber(db, params.To);
  if (workspace?.forwardCallsTo) {
    const action = `${appUrl}/api/webhooks/twilio/voice-status`;
    return twiml(
      `<Dial timeout="20" callerId="${escapeXml(params.To)}" action="${escapeXml(action)}">${escapeXml(workspace.forwardCallsTo)}</Dial>`,
    );
  }
  // Nowhere to forward to, so the call counts as missed straight away.
  await handleCallEnded(db, { to: params.To, from: params.From, dialStatus: "no-answer" }, { sms: smsProvider(), email: emailProvider() }, { appUrl });
  return twiml(`<Say>Sorry, we can't take your call right now. We'll text you shortly.</Say><Hangup/>`);
}
