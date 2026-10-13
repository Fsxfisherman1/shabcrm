import { db } from "@/db";
import { receiveSms } from "@/server/messaging";
import { forbidden, readTwilioWebhook, twiml } from "@/server/messaging/webhooks";

// Twilio calls this when someone texts one of our numbers.
export async function POST(request: Request) {
  const params = await readTwilioWebhook(request);
  if (!params) return forbidden();
  await receiveSms(db, { from: params.From, to: params.To, body: params.Body ?? "", providerId: params.MessageSid });
  // Empty reply: Twilio itself answers STOP/START with its standard confirmation text.
  return twiml();
}
