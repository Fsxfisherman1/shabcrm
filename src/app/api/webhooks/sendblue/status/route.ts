import { db } from "@/db";
import { updateIMessageStatus } from "@/server/messaging";
import { statusToken } from "@/server/messaging/config";
import { validateSharedSecret } from "@/server/messaging/providers";
import { forbidden } from "@/server/messaging/webhooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sendblue calls this as an iMessage we sent moves through sent, delivered or failed.
// The URL carries a token we made when sending, since these calls may not include the webhook secret.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("w") ?? "";
  if (!UUID.test(workspaceId) || !validateSharedSecret(statusToken(workspaceId), url.searchParams.get("t"))) return forbidden();
  const msg = (await request.json().catch(() => null)) as { message_handle?: string; status?: string; error_message?: string } | null;
  if (msg?.message_handle && msg.status) {
    await updateIMessageStatus(db, workspaceId, msg.message_handle, msg.status, msg.error_message);
  }
  return new Response(null, { status: 204 });
}
