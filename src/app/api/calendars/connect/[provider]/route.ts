import { oauthApp } from "@/server/calendars/config";
import { backToCalendar, callbackUrl, memberOf } from "@/server/calendars/oauth-routes";
import { authorizeUrl } from "@/server/calendars/providers";
import { signState } from "@/server/calendars/secrets";

// Starts "Connect Google Calendar" / "Connect Outlook": sends the person to sign in there.
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const workspaceId = new URL(request.url).searchParams.get("w");
  const member = await memberOf(workspaceId);
  if (!member) return new Response("Not found", { status: 404 });
  const app = oauthApp(provider);
  if (!app) return backToCalendar(workspaceId!, { error: "not-configured" });
  const state = signState({ w: workspaceId!, u: member.userId, p: provider });
  return Response.redirect(authorizeUrl(app, callbackUrl(provider), state), 303);
}
