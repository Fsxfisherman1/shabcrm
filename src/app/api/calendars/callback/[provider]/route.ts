import { db } from "@/db";
import { addCalendar } from "@/server/calendars";
import { oauthApp } from "@/server/calendars/config";
import { backToCalendar, callbackUrl, memberOf } from "@/server/calendars/oauth-routes";
import { exchangeCode, oauthAccountEmail } from "@/server/calendars/providers";
import { verifyState } from "@/server/calendars/secrets";

// Google or Microsoft sends the person back here after they approve access.
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const url = new URL(request.url);
  const state = verifyState(url.searchParams.get("state"));
  const member = state && state.p === provider ? await memberOf(state.w) : null;
  // The state must be ours, recent, and issued to the person who's signed in now.
  if (!state || !member || member.userId !== state.u) return new Response("This link has expired. Please try connecting again.", { status: 400 });
  const app = oauthApp(provider);
  const code = url.searchParams.get("code");
  if (!app || !code) return backToCalendar(state.w, { error: url.searchParams.get("error") ?? "cancelled" });

  try {
    const tokens = await exchangeCode(app, code, callbackUrl(provider));
    const email = await oauthAccountEmail(app, tokens.accessToken);
    const label = provider === "google" ? "Google Calendar" : "Outlook Calendar";
    await addCalendar(db, state.w, {
      kind: provider as "google" | "microsoft",
      name: email ? `${label} (${email})` : label,
      externalId: "primary",
      credentials: tokens,
    });
  } catch (err) {
    return backToCalendar(state.w, { error: err instanceof Error ? err.message.slice(0, 200) : "failed" });
  }
  return backToCalendar(state.w, { connected: provider });
}
