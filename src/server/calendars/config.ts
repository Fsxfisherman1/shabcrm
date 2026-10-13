import type { Calendar } from "@/db/schema";
import { CalDavCalendar, GoogleCalendar, IcsCalendar, MicrosoftCalendar, googleApp, microsoftApp, type CalDavCredentials, type CalendarProvider, type OAuthApp, type OAuthTokens } from "./providers";
import { decryptJson } from "./secrets";

/** Google and Microsoft need an OAuth app (client id and secret) before they can be connected. */
export function oauthApp(provider: string): OAuthApp | null {
  const env = process.env;
  if (provider === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return googleApp(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  }
  if (provider === "microsoft" && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    return microsoftApp(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET);
  }
  return null;
}

export type ProviderFactory = (calendar: Calendar, timezone: string, saveTokens: (tokens: OAuthTokens) => Promise<void>) => CalendarProvider;

export const realProviders: ProviderFactory = (calendar, timezone, saveTokens) => {
  switch (calendar.kind) {
    case "ics":
      return new IcsCalendar(calendar.externalId, timezone);
    case "caldav":
      return new CalDavCalendar(decryptJson<CalDavCredentials>(calendar.credentials!), calendar.externalId, timezone);
    case "google":
    case "microsoft": {
      const app = oauthApp(calendar.kind);
      if (!app) throw new Error(`${calendar.kind === "google" ? "Google" : "Microsoft"} isn't set up on this server anymore.`);
      const tokens = decryptJson<OAuthTokens>(calendar.credentials!);
      return calendar.kind === "google" ? new GoogleCalendar(app, tokens, saveTokens) : new MicrosoftCalendar(app, tokens, saveTokens);
    }
  }
};
