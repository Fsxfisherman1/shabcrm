import { createDAVClient } from "tsdav";
import type { Interval } from "./availability";
import { buildIcs, busyFromIcs } from "./ics";

export type NewEvent = { uid: string; title: string; description: string; start: Date; end: Date; attendeeEmail?: string | null };

/** One connected calendar: read busy times, and (if it can) add and remove events. */
export interface CalendarProvider {
  busy(from: Date, to: Date): Promise<Interval[]>;
  /** Returns the outside calendar's id for the new event. */
  createEvent?(event: NewEvent): Promise<string>;
  deleteEvent?(eventId: string): Promise<void>;
}

export class CalendarError extends Error {}

type Fetch = typeof fetch;

async function json<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | string; error_description?: string };
  if (!res.ok) {
    const detail =
      typeof body.error === "object" ? body.error?.message : (body.error_description ?? body.error ?? `HTTP ${res.status}`);
    throw new CalendarError(`${what}: ${detail}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// OAuth (Google and Microsoft)
// ---------------------------------------------------------------------------

export type OAuthTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export type OAuthApp = {
  provider: "google" | "microsoft";
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
};

export function googleApp(clientId: string, clientSecret: string): OAuthApp {
  return {
    provider: "google",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ],
  };
}

export function microsoftApp(clientId: string, clientSecret: string): OAuthApp {
  return {
    provider: "microsoft",
    clientId,
    clientSecret,
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Calendars.ReadWrite"],
  };
}

export function authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: app.scopes.join(" "),
    state,
  });
  if (app.provider === "google") {
    // Ask for a refresh token every time, so reconnecting always works.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  } else {
    params.set("prompt", "select_account");
  }
  return `${app.authorizeUrl}?${params}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

export async function exchangeCode(app: OAuthApp, code: string, redirectUri: string, f: Fetch = fetch): Promise<OAuthTokens> {
  const res = await f(app.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const t = await json<TokenResponse>(res, "Couldn't finish connecting");
  if (!t.refresh_token) throw new CalendarError("The calendar didn't grant offline access. Please try connecting again.");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/** The signed-in account's email, used to label the connection. */
export async function oauthAccountEmail(app: OAuthApp, accessToken: string, f: Fetch = fetch): Promise<string> {
  const url = app.provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://graph.microsoft.com/v1.0/me";
  const me = await json<{ email?: string; mail?: string; userPrincipalName?: string }>(
    await f(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
    "Couldn't read the account",
  );
  return me.email ?? me.mail ?? me.userPrincipalName ?? "";
}

/** Base for Google and Microsoft: keeps the access token fresh and saves new tokens. */
abstract class OAuthCalendar {
  constructor(
    protected app: OAuthApp,
    protected tokens: OAuthTokens,
    protected saveTokens: (tokens: OAuthTokens) => Promise<void>,
    protected f: Fetch = fetch,
  ) {}

  protected async accessToken(): Promise<string> {
    if (this.tokens.expiresAt - 60_000 > Date.now()) return this.tokens.accessToken;
    const res = await this.f(this.app.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.app.clientId,
        client_secret: this.app.clientSecret,
        refresh_token: this.tokens.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const t = await json<TokenResponse>(res, "Calendar access expired; reconnect it");
    this.tokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    await this.saveTokens(this.tokens);
    return this.tokens.accessToken;
  }

  protected async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.accessToken()}`);
    if (init.body) headers.set("Content-Type", "application/json");
    return this.f(url, { ...init, headers });
  }
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export class GoogleCalendar extends OAuthCalendar implements CalendarProvider {
  private calendarId = "primary";

  async busy(from: Date, to: Date): Promise<Interval[]> {
    const res = await this.call("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: this.calendarId }] }),
    });
    const data = await json<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
      res,
      "Couldn't read Google Calendar",
    );
    return (data.calendars[this.calendarId]?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createEvent(e: NewEvent): Promise<string> {
    const res = await this.call(`https://www.googleapis.com/calendar/v3/calendars/${this.calendarId}/events`, {
      method: "POST",
      body: JSON.stringify({
        summary: e.title,
        description: e.description,
        start: { dateTime: e.start.toISOString() },
        end: { dateTime: e.end.toISOString() },
      }),
    });
    return (await json<{ id: string }>(res, "Couldn't add to Google Calendar")).id;
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await this.call(`https://www.googleapis.com/calendar/v3/calendars/${this.calendarId}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) await json(res, "Couldn't remove from Google Calendar");
  }
}

// ---------------------------------------------------------------------------
// Microsoft 365 / Outlook.com
// ---------------------------------------------------------------------------

export class MicrosoftCalendar extends OAuthCalendar implements CalendarProvider {
  async busy(from: Date, to: Date): Promise<Interval[]> {
    const busy: Interval[] = [];
    let url: string | undefined =
      `https://graph.microsoft.com/v1.0/me/calendarView?${new URLSearchParams({
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $select: "start,end,showAs,isCancelled",
        $top: "500",
      })}`;
    while (url) {
      const res = await this.call(url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      const page: { value: { start: { dateTime: string }; end: { dateTime: string }; showAs: string; isCancelled: boolean }[]; "@odata.nextLink"?: string } =
        await json(res, "Couldn't read the Outlook calendar");
      for (const e of page.value) {
        if (e.isCancelled || e.showAs === "free") continue;
        busy.push({ start: new Date(`${e.start.dateTime}Z`), end: new Date(`${e.end.dateTime}Z`) });
      }
      url = page["@odata.nextLink"];
    }
    return busy;
  }

  async createEvent(e: NewEvent): Promise<string> {
    const res = await this.call("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      body: JSON.stringify({
        subject: e.title,
        body: { contentType: "text", content: e.description },
        start: { dateTime: e.start.toISOString().replace("Z", ""), timeZone: "UTC" },
        end: { dateTime: e.end.toISOString().replace("Z", ""), timeZone: "UTC" },
        transactionId: e.uid,
      }),
    });
    return (await json<{ id: string }>(res, "Couldn't add to the Outlook calendar")).id;
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await this.call(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) await json(res, "Couldn't remove from the Outlook calendar");
  }
}

// ---------------------------------------------------------------------------
// CalDAV (Apple iCloud, Fastmail, Nextcloud, and most others)
// ---------------------------------------------------------------------------

export type CalDavCredentials = { serverUrl: string; username: string; password: string };

async function davClient(creds: CalDavCredentials) {
  try {
    return await createDAVClient({
      serverUrl: creds.serverUrl,
      credentials: { username: creds.username, password: creds.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  } catch (err) {
    throw new CalendarError(
      `Couldn't sign in to the calendar server. Check the address, username and app password. (${err instanceof Error ? err.message : err})`,
    );
  }
}

/** Signs in and lists the calendars that hold events. */
export async function discoverCalDavCalendars(creds: CalDavCredentials): Promise<{ url: string; name: string }[]> {
  const client = await davClient(creds);
  const calendars = await client.fetchCalendars();
  return calendars
    .filter((c) => !c.components || c.components.includes("VEVENT"))
    .map((c) => ({ url: c.url, name: typeof c.displayName === "string" && c.displayName ? c.displayName : "Calendar" }));
}

export class CalDavCalendar implements CalendarProvider {
  constructor(
    private creds: CalDavCredentials,
    private calendarUrl: string,
    private timezone: string,
  ) {}

  async busy(from: Date, to: Date): Promise<Interval[]> {
    const client = await davClient(this.creds);
    const objects = await client.fetchCalendarObjects({
      calendar: { url: this.calendarUrl },
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
    return busyFromIcs(
      objects.map((o) => String(o.data ?? "")).filter(Boolean),
      from,
      to,
      this.timezone,
    );
  }

  async createEvent(e: NewEvent): Promise<string> {
    const client = await davClient(this.creds);
    const filename = `${e.uid}.ics`;
    const res = await client.createCalendarObject({
      calendar: { url: this.calendarUrl },
      filename,
      iCalString: buildIcs([e]),
    });
    if (!res.ok) throw new CalendarError(`Couldn't add to the calendar (HTTP ${res.status})`);
    return new URL(filename, this.calendarUrl.endsWith("/") ? this.calendarUrl : `${this.calendarUrl}/`).toString();
  }

  async deleteEvent(eventUrl: string): Promise<void> {
    const client = await davClient(this.creds);
    const res = await client.deleteCalendarObject({ calendarObject: { url: eventUrl, etag: "" } });
    if (!res.ok && res.status !== 404) throw new CalendarError(`Couldn't remove from the calendar (HTTP ${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Read-only iCal link (works with nearly any calendar)
// ---------------------------------------------------------------------------

export function normalizeIcsUrl(raw: string): string | null {
  const value = raw.trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export class IcsCalendar implements CalendarProvider {
  constructor(
    private url: string,
    private timezone: string,
    private f: Fetch = fetch,
  ) {}

  async busy(from: Date, to: Date): Promise<Interval[]> {
    const res = await this.f(this.url, { headers: { Accept: "text/calendar" }, redirect: "follow" });
    if (!res.ok) throw new CalendarError(`Couldn't load the calendar link (HTTP ${res.status})`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new CalendarError("That link isn't a calendar feed.");
    return busyFromIcs(text, from, to, this.timezone);
  }
}
