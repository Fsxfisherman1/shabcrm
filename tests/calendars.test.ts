import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaces, type Calendar } from "@/db/schema";
import { getContact } from "@/server/contacts";
import { availableSlots } from "@/server/calendars/availability";
import { busyFromIcs, buildIcs } from "@/server/calendars/ics";
import {
  addCalendar,
  bookAppointment,
  BookingError,
  calendarFeed,
  cancelAppointment,
  createAppointment,
  getBookingPage,
  listAppointments,
  listCalendars,
  updateBookingPage,
  updateCalendarSettings,
} from "@/server/calendars";
import type { ProviderFactory } from "@/server/calendars/config";
import { GoogleCalendar, googleApp, MicrosoftCalendar, microsoftApp, type CalendarProvider, type NewEvent } from "@/server/calendars/providers";
import { decryptJson, encryptJson, signState, verifyState } from "@/server/calendars/secrets";
import { createContact } from "@/server/contacts";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
});

const TZ = "America/Chicago";
const at = (iso: string) => new Date(iso);
const weekdays9to5 = Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));

describe("availability", () => {
  const rules = { timezone: TZ, weeklyHours: weekdays9to5, durationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxDaysAhead: 0 };

  it("offers half-hourly starts inside open hours, in the account's time zone", () => {
    // Monday Oct 12 2026, 7am in Chicago.
    const slots = availableSlots(rules, [], at("2026-10-12T12:00:00Z"));
    expect(slots[0].toISOString()).toBe("2026-10-12T14:00:00.000Z"); // 9:00 CDT
    expect(slots.at(-1)!.toISOString()).toBe("2026-10-12T21:00:00.000Z"); // 4:00 CDT, ends 5:00
    expect(slots).toHaveLength(15);
  });

  it("skips busy times (with the buffer), short notice and closed days", () => {
    const busy = [{ start: at("2026-10-12T15:00:00Z"), end: at("2026-10-12T16:00:00Z") }]; // 10-11am
    const slots = availableSlots({ ...rules, bufferMinutes: 15, minNoticeHours: 2 }, busy, at("2026-10-12T13:00:00Z"));
    const times = slots.map((s) => s.toISOString().slice(11, 16));
    expect(times[0]).toBe("16:30"); // 11:30am: 2h notice moves past 9-10, buffer blocks 11:00
    expect(times).not.toContain("14:00");
    // Saturday has no hours.
    expect(availableSlots(rules, [], at("2026-10-17T12:00:00Z"))).toEqual([]);
  });

  it("keeps local hours across a daylight-saving change", () => {
    // Nov 2 2026 is the Monday after US clocks fall back.
    const slots = availableSlots({ ...rules, maxDaysAhead: 7 }, [], at("2026-10-30T12:00:00Z"));
    const nov2 = slots.filter((s) => s.toISOString().startsWith("2026-11-02"));
    expect(nov2[0].toISOString()).toBe("2026-11-02T15:00:00.000Z"); // 9:00 CST
  });
});

describe("iCalendar", () => {
  const feed = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:weekly",
    "DTSTART;TZID=America/Chicago:20261005T100000",
    "DTEND;TZID=America/Chicago:20261005T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "EXDATE;TZID=America/Chicago:20261019T100000",
    "SUMMARY:Staff meeting",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly",
    "RECURRENCE-ID;TZID=America/Chicago:20261026T100000",
    "DTSTART;TZID=America/Chicago:20261026T140000",
    "DTEND;TZID=America/Chicago:20261026T150000",
    "SUMMARY:Staff meeting (moved)",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:birthday",
    "DTSTART;VALUE=DATE:20261013",
    "DTEND;VALUE=DATE:20261014",
    "TRANSP:TRANSPARENT",
    "SUMMARY:Birthday",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:dentist",
    "DTSTART:20261014T200000Z",
    "DTEND:20261014T203000Z",
    "SUMMARY:Dentist",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("expands recurring events with their exceptions and skips free time", () => {
    const busy = busyFromIcs(feed, at("2026-10-11T00:00:00Z"), at("2026-11-01T00:00:00Z"), TZ);
    const starts = busy.map((b) => b.start.toISOString()).sort();
    expect(starts).toEqual([
      "2026-10-12T15:00:00.000Z", // Mon 10am CDT
      "2026-10-14T20:00:00.000Z", // dentist
      "2026-10-26T19:00:00.000Z", // moved to 2pm; Oct 19 was removed
    ]);
  });

  it("round-trips the feed it writes", () => {
    const ics = buildIcs([
      { uid: "a@shabcrm", title: "Cleaning: Jane, Doe; Jr.", start: at("2026-10-14T15:00:00Z"), end: at("2026-10-14T15:30:00Z"), description: "x".repeat(200) },
    ]);
    expect(ics).toContain("SUMMARY:Cleaning: Jane\\, Doe\; Jr.");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(busyFromIcs(ics, at("2026-10-14T00:00:00Z"), at("2026-10-15T00:00:00Z"), TZ)).toEqual([
      { start: at("2026-10-14T15:00:00Z"), end: at("2026-10-14T15:30:00Z") },
    ]);
  });
});

describe("secrets", () => {
  it("encrypts credentials and signs OAuth state", () => {
    const sealed = encryptJson({ password: "hunter2" });
    expect(sealed).not.toContain("hunter2");
    expect(decryptJson(sealed)).toEqual({ password: "hunter2" });
    const state = signState({ w: "abc" });
    expect(verifyState(state)).toMatchObject({ w: "abc" });
    expect(verifyState(state.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifyState(signState({ w: "abc" }, -1))).toBeNull();
  });
});

// A stand-in for outside calendars: busy times per calendar name, and a record of added events.
function fakeCalendars() {
  const busy = new Map<string, { start: Date; end: Date }[]>();
  const added: (NewEvent & { calendar: string })[] = [];
  const removed: string[] = [];
  const broken = new Set<string>();
  const factory: ProviderFactory = (cal: Calendar) => {
    const provider: CalendarProvider = {
      async busy() {
        if (broken.has(cal.name)) throw new Error("401 Unauthorized");
        return busy.get(cal.name) ?? [];
      },
    };
    if (cal.kind !== "ics") {
      provider.createEvent = async (e) => {
        if (broken.has(cal.name)) throw new Error("401 Unauthorized");
        added.push({ ...e, calendar: cal.name });
        return `evt-${added.length}`;
      };
      provider.deleteEvent = async (id) => void removed.push(id);
    }
    return provider;
  };
  return { busy, added, removed, broken, factory };
}

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id, "Bright Smile Dental");
  await db.update(workspaces).set({ timezone: TZ }).where(eq(workspaces.id, ws.id));
  const page = await getBookingPage(db, ws.id);
  await updateBookingPage(db, ws.id, {
    enabled: true,
    slug: "bright-smile",
    title: "Cleaning",
    description: "",
    durationMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 1,
    maxDaysAhead: 14,
    weeklyHours: weekdays9to5,
  });
  return { alex, ws: { ...ws, timezone: TZ }, page };
}

const NOW = at("2026-10-12T12:00:00Z"); // Monday 7am Chicago
const guest = { firstName: "Jane", lastName: "Doe", email: "Jane@Example.com", phone: "(415) 555-0101", notes: "First visit", smsOptIn: true };

describe("booking", () => {
  beforeEach(resetDb);

  it("creates a booking page with a unique address and a private feed", async () => {
    const { ws, page } = await setup();
    expect(page.slug).toMatch(/^bright-smile-dental-[0-9a-f]{4}$/);
    expect(page.feedToken.length).toBeGreaterThan(20);
    const other = await makeWorkspace((await makeUser()).id, "Other");
    await expect(
      updateBookingPage(db, other.id, { ...(await getBookingPage(db, other.id)), slug: "Bright Smile" }),
    ).rejects.toThrow(/taken/);
    expect((await getBookingPage(db, ws.id)).slug).toBe("bright-smile");
  });

  it("books an open slot, adds the contact with consent and copies it to the calendar", async () => {
    const { ws } = await setup();
    const cals = fakeCalendars();
    const google = await addCalendar(db, ws.id, { kind: "google", name: "Google", externalId: "primary", credentials: { accessToken: "x" } });
    expect(google.addBookings).toBe(true);

    const { appointment } = await bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-12T15:00:00Z") }, cals.factory, NOW);
    expect(appointment).toMatchObject({ title: "Cleaning", status: "booked", calendarId: google.id, source: "Booking page" });
    expect(cals.added).toMatchObject([{ calendar: "Google", title: "Cleaning: Jane Doe", start: at("2026-10-12T15:00:00Z") }]);

    const detail = await getContact(db, ws.id, appointment.contactId);
    expect(detail!.contact).toMatchObject({ email: "jane@example.com", phone: "+14155550101", smsConsent: "granted", smsConsentSource: "Booking page" });
    expect(detail!.timeline.map((a) => a.body)).toContain("Booked online for Mon, Oct 12 at 10:00 AM");

    // The same slot can't be booked twice.
    await expect(
      bookAppointment(db, "bright-smile", { ...guest, email: "sam@example.com", phone: "", start: at("2026-10-12T15:00:00Z") }, cals.factory, NOW),
    ).rejects.toThrow(BookingError);
  });

  it("respects busy times on connected calendars and keeps working when one breaks", async () => {
    const { ws } = await setup();
    const cals = fakeCalendars();
    await addCalendar(db, ws.id, { kind: "ics", name: "Personal", externalId: "https://example.com/a.ics" });
    await addCalendar(db, ws.id, { kind: "caldav", name: "iCloud", externalId: "https://caldav.example.com/cal/", credentials: {} });
    cals.busy.set("Personal", [{ start: at("2026-10-12T15:00:00Z"), end: at("2026-10-12T16:00:00Z") }]);
    cals.broken.add("iCloud");

    await expect(
      bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-12T15:30:00Z") }, cals.factory, NOW),
    ).rejects.toThrow(/just taken/);
    await bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-12T16:00:00Z") }, cals.factory, NOW);

    const list = await listCalendars(db, ws.id);
    expect(list.find((c) => c.name === "iCloud")).toMatchObject({ lastError: "401 Unauthorized", addBookings: true });
    // Times outside open hours are refused too.
    await expect(
      bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-12T23:00:00Z") }, cals.factory, NOW),
    ).rejects.toThrow(BookingError);
  });

  it("never turns an opted-out contact's texts back on", async () => {
    const { ws, alex } = await setup();
    await createContact(db, ws.id, { firstName: "Jane", email: "jane@example.com", consent: { smsConsent: "revoked" } }, alex.id);
    const { appointment } = await bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-13T15:00:00Z") }, fakeCalendars().factory, NOW);
    const detail = await getContact(db, ws.id, appointment.contactId);
    expect(detail!.contact).toMatchObject({ smsConsent: "revoked", phone: "+14155550101", firstName: "Jane" });
  });

  it("refuses bookings while the page is off", async () => {
    const { ws, page } = await setup();
    await updateBookingPage(db, ws.id, { ...page, slug: "bright-smile", enabled: false });
    await expect(
      bookAppointment(db, "bright-smile", { ...guest, start: at("2026-10-12T15:00:00Z") }, fakeCalendars().factory, NOW),
    ).rejects.toThrow(/isn't taking bookings/);
  });

  it("adds, cancels and publishes appointments", async () => {
    const { ws, alex } = await setup();
    const cals = fakeCalendars();
    const outlook = await addCalendar(db, ws.id, { kind: "microsoft", name: "Outlook", externalId: "primary", credentials: {} });
    const ical = await addCalendar(db, ws.id, { kind: "ics", name: "Link", externalId: "https://example.com/b.ics" });
    expect(ical.addBookings).toBe(false);
    await expect(updateCalendarSettings(db, ws.id, ical.id, { addBookings: true })).rejects.toThrow(/read-only/);

    const c = await createContact(db, ws.id, { firstName: "Maria", lastName: "Lopez" }, alex.id);
    const start = new Date(Date.now() + 86400_000);
    const appt = await createAppointment(db, ws.id, { contactId: c.id, start, durationMinutes: 45, title: "Consult" }, alex.id, cals.factory);
    expect(appt.endsAt.getTime() - start.getTime()).toBe(45 * 60_000);
    expect(cals.added).toMatchObject([{ calendar: "Outlook", title: "Consult: Maria Lopez" }]);

    const page = await getBookingPage(db, ws.id);
    let feed = await calendarFeed(db, page.feedToken);
    expect(feed).toContain("SUMMARY:Consult: Maria Lopez");
    expect(feed).toContain("STATUS:CONFIRMED");
    expect(await calendarFeed(db, "x".repeat(32))).toBeNull();

    await cancelAppointment(db, ws.id, appt.id, alex.id, cals.factory);
    expect(cals.removed).toEqual(["evt-1"]);
    expect(await listAppointments(db, ws.id, { contactId: c.id })).toHaveLength(0);
    feed = await calendarFeed(db, page.feedToken);
    expect(feed).toContain("STATUS:CANCELLED");
    expect(outlook.addBookings).toBe(true);
  });
});

describe("Google and Microsoft", () => {
  it("refreshes an expired token, saves it, and reads busy times", async () => {
    const calls: string[] = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).split("?")[0]}`);
      if (String(url).includes("token")) return Response.json({ access_token: "new", expires_in: 3600 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new");
      return Response.json({ calendars: { primary: { busy: [{ start: "2026-10-12T15:00:00Z", end: "2026-10-12T16:00:00Z" }] } } });
    }) as unknown as typeof fetch;
    const saved: unknown[] = [];
    const google = new GoogleCalendar(googleApp("id", "secret"), { accessToken: "old", refreshToken: "r", expiresAt: 0 }, async (t) => void saved.push(t), fetchStub);
    const busy = await google.busy(at("2026-10-12T00:00:00Z"), at("2026-10-13T00:00:00Z"));
    expect(busy).toEqual([{ start: at("2026-10-12T15:00:00Z"), end: at("2026-10-12T16:00:00Z") }]);
    expect(calls).toEqual(["POST https://oauth2.googleapis.com/token", "POST https://www.googleapis.com/calendar/v3/freeBusy"]);
    expect(saved).toMatchObject([{ accessToken: "new", refreshToken: "r" }]);
  });

  it("reads Outlook busy times across pages and ignores free and canceled events", async () => {
    const pages = [
      { value: [{ start: { dateTime: "2026-10-12T15:00:00.0000000" }, end: { dateTime: "2026-10-12T16:00:00.0000000" }, showAs: "busy", isCancelled: false }], "@odata.nextLink": "https://graph.microsoft.com/next" },
      { value: [
        { start: { dateTime: "2026-10-12T17:00:00.0000000" }, end: { dateTime: "2026-10-12T18:00:00.0000000" }, showAs: "free", isCancelled: false },
        { start: { dateTime: "2026-10-12T19:00:00.0000000" }, end: { dateTime: "2026-10-12T20:00:00.0000000" }, showAs: "busy", isCancelled: true },
      ] },
    ];
    const fetchStub = vi.fn(async () => Response.json(pages.shift())) as unknown as typeof fetch;
    const ms = new MicrosoftCalendar(microsoftApp("id", "secret"), { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 }, async () => {}, fetchStub);
    expect(await ms.busy(at("2026-10-12T00:00:00Z"), at("2026-10-13T00:00:00Z"))).toEqual([
      { start: at("2026-10-12T15:00:00Z"), end: at("2026-10-12T16:00:00Z") },
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
