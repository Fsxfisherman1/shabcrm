import { db } from "@/db";
import { updateSmsStatus } from "@/server/messaging";
import { forbidden, readTwilioWebhook } from "@/server/messaging/webhooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Twilio calls this as a text we sent moves through sent, delivered or failed.
export async function POST(request: Request) {
  const params = await readTwilioWebhook(request);
  if (!params) return forbidden();
  const workspaceId = new URL(request.url).searchParams.get("w") ?? "";
  if (UUID.test(workspaceId) && params.MessageSid) {
    await updateSmsStatus(db, workspaceId, params.MessageSid, params.MessageStatus ?? "", params.ErrorCode);
  }
  return new Response(null, { status: 204 });
}
