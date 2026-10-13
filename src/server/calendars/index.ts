import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db, Tx } from "@/db/client";
import {
  activities,
  appointments,
  bookingPages,
  calendars,
  contacts,
  workspaces,
  type Appointment,
  type BookingPage,
  type Calendar,
  type Contact,
  type WeeklyHours,
  type Workspace,
} from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { contactName } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { findExisting } from "@/server/contacts";
import { availableSlots, DEFAULT_HOURS, type Interval } from "./availability";
import type { ProviderFactory } from "./config";
import { buildIcs } from "./ics";
import { CalendarError, type OAuthTokens } from "./providers";
import { encryptJson } from "./secrets";

export class BookingError extends Error {}

const WRITABLE: Calendar["kind"][] = ["google", "microsoft", "caldav"];

export function formatWhen(date: Date, timezone: string) {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat("ccc, LLL d 'at' h:mm a");
}

// ---------------------------------------------------------------------------
// Booking page settings
// ---------------------------------------------------------------------------

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "book"
  );
}

/** The account's booking page, created with sensible defaults the first time. */
export async function getBookingPage(db: Db, workspaceId: string): Promise<BookingPage> {
  const [existing] = await db.select().from(bookingPages).where(eq(bookingPages.workspaceId, workspaceId));
  if (existing) return existing;
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const [created] = await db
    .insert(bookingPages)
    .values({
      workspaceId,
      slug: `${slugify(workspace.name)}-${randomBytes(2).toString("hex")}`,
      title: `Book with ${workspace.name}`,
      weeklyHours: DEFAULT_HOURS,
      feedToken: randomBytes(24).toString("base64url"),
    })
    .onConflictDoNothing({ target: bookingPages.workspaceId })
    .returning();
  return created ?? (await getBookingPage(db, workspaceId));
}

export type BookingPageInput = {
  enabled: boolean;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  weeklyHours: WeeklyHours;
};

export async function updateBookingPage(db: Db, workspaceId: string, input: BookingPageInput) {
  const slug = slugify(input.slug);
  if (slug.length < 3) throw new BookingError("The page address needs at least 3 letters or numbers.");
  const [taken] = await db.select({ id: bookingPages.id }).from(bookingPages).where(and(eq(bookingPages.slug, slug), ne(bookingPages.workspaceId, workspaceId)));
  if (taken) throw new BookingError("That page address is taken. Try another.");
  await getBookingPage(db, workspaceId);
  await db
    .update(bookingPages)
    .set({ ...input, slug })
    .where(eq(bookingPages.workspaceId, workspaceId));
}

export async function bookingPageBySlug(db: Db, slug: string): Promise<{ page: BookingPage; workspace: Workspace } | null> {
  const [row] = await db
    .select({ page: bookingPages, workspace: workspaces })
    .from(bookingPages)
    .innerJoin(workspaces, eq(workspaces.id, bookingPages.workspaceId))
    .where(eq(bookingPages.slug, slug.toLowerCase()));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Connected calendars
// ---------------------------------------------------------------------------

export async function listCalendars(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) => tx.select().from(calendars).orderBy(asc(calendars.createdAt)));
}

export async function addCalendar(
  db: Db,
  workspaceId: string,
  input: { kind: Calendar["kind"]; name: string; externalId: string; credentials?: unknown },
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [dupe] = await tx
      .select()
      .from(calendars)
      .where(and(eq(calendars.kind, input.kind), eq(calendars.externalId, input.externalId), eq(calendars.name, input.name)));
    const credentials = input.credentials === undefined ? null : encryptJson(input.credentials);
    if (dupe) {
      // Reconnecting the same calendar refreshes its credentials.
      const [updated] = await tx.update(calendars).set({ credentials, lastError: null }).where(eq(calendars.id, dupe.id)).returning();
      return updated;
    }
    const writable = WRITABLE.includes(input.kind);
    const [current] = writable
      ? await tx.select({ id: calendars.id }).from(calendars).where(eq(calendars.addBookings, true))
      : [];
    const [created] = await tx
      .insert(calendars)
      .values({ workspaceId, ...input, credentials, addBookings: writable && !current })
      .returning();
    return created;
  });
}

export async function updateCalendarSettings(
  db: Db,
  workspaceId: string,
  calendarId: string,
  input: { checkConflicts?: boolean; addBookings?: boolean },
) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const [cal] = await tx.select().from(calendars).where(eq(calendars.id, calendarId));
    if (!cal) throw new BookingError("Calendar not found.");
    if (input.addBookings && !WRITABLE.includes(cal.kind)) {
      throw new BookingError("A calendar link is read-only, so bookings can't be added to it.");
    }
    // Bookings go to one calendar at most.
    if (input.addBookings) await tx.update(calendars).set({ addBookings: false }).where(ne(calendars.id, calendarId));
    await tx.update(calendars).set(input).where(eq(calendars.id, calendarId));
  });
}

export async function removeCalendar(db: Db, workspaceId: string, calendarId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(calendars).where(eq(calendars.id, calendarId)));
}

function tokenSaver(db: Db, workspaceId: string, calendarId: string) {
  return async (tokens: OAuthTokens) => {
    await withWorkspace(db, workspaceId, (tx) =>
      tx.update(calendars).set({ credentials: encryptJson(tokens) }).where(eq(calendars.id, calendarId)),
    );
  };
}

async function recordError(db: Db, workspaceId: string, calendarId: string, error: string | null) {
  await withWorkspace(db, workspaceId, (tx) => tx.update(calendars).set({ lastError: error }).where(eq(calendars.id, calendarId)));
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Everything that blocks a booking between `from` and `to`: this account's
 * own appointments, plus busy times on calendars set to check for conflicts.
 * A calendar that can't be read is skipped (and its error shown in the app)
 * rather than taking the booking page down.
 */
export async function busyTimes(db: Db, workspace: Workspace, from: Date, to: Date, providers: ProviderFactory): Promise<Interval[]> {
  const { own, cals } = await withWorkspace(db, workspace.id, async (tx) => ({
    own: await tx
      .select({ start: appointments.startsAt, end: appointments.endsAt })
      .from(appointments)
      .where(and(eq(appointments.status, "booked"), lt(appointments.startsAt, to), gt(appointments.endsAt, from))),
    cals: await tx.select().from(calendars).where(eq(calendars.checkConflicts, true)),
  }));
  const outside = await Promise.all(
    cals.map(async (cal) => {
      try {
        const busy = await providers(cal, workspace.timezone, tokenSaver(db, workspace.id, cal.id)).busy(from, to);
        if (cal.lastError) await recordError(db, workspace.id, cal.id, null);
        return busy;
      } catch (err) {
        await recordError(db, workspace.id, cal.id, errorText(err));
        return [];
      }
    }),
  );
  return [...own, ...outside.flat()];
}

export async function openSlots(db: Db, page: BookingPage, workspace: Workspace, providers: ProviderFactory, now = new Date()) {
  const to = new Date(now.getTime() + (page.maxDaysAhead + 2) * 86400_000);
  const busy = await busyTimes(db, workspace, now, to, providers);
  return availableSlots({ ...page, timezone: workspace.timezone }, busy, now);
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export async function listAppointments(
  db: Db,
  workspaceId: string,
  opts: { from?: Date; contactId?: string; includeCanceled?: boolean } = {},
) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({
        appointment: appointments,
        contact: { id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone },
      })
      .from(appointments)
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .where(
        and(
          opts.from ? gt(appointments.endsAt, opts.from) : undefined,
          opts.contactId ? eq(appointments.contactId, opts.contactId) : undefined,
          opts.includeCanceled ? undefined : eq(appointments.status, "booked"),
        ),
      )
      .orderBy(asc(appointments.startsAt)),
  );
}

async function hasOverlap(tx: Tx, start: Date, end: Date) {
  const [clash] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.status, "booked"), lt(appointments.startsAt, end), gt(appointments.endsAt, start)))
    .limit(1);
  return Boolean(clash);
}

/** Copies an appointment to the account's "add bookings" calendar, if it has one. Best effort. */
async function copyToCalendar(db: Db, workspace: Workspace, appt: Appointment, contact: Contact, providers: ProviderFactory): Promise<Appointment> {
  const [cal] = await withWorkspace(db, workspace.id, (tx) => tx.select().from(calendars).where(eq(calendars.addBookings, true)));
  if (!cal) return appt;
  try {
    const provider = providers(cal, workspace.timezone, tokenSaver(db, workspace.id, cal.id));
    if (!provider.createEvent) return appt;
    const description = [
      contactName(contact),
      contact.email,
      contact.phone,
      appt.notes && `Notes: ${appt.notes}`,
      `Booked through ShabCRM (${appt.source})`,
    ]
      .filter(Boolean)
      .join("\n");
    const eventId = await provider.createEvent({
      uid: `${appt.id}@shabcrm`,
      title: `${appt.title}: ${contactName(contact)}`,
      description,
      start: appt.startsAt,
      end: appt.endsAt,
      attendeeEmail: contact.email,
    });
    const [updated] = await withWorkspace(db, workspace.id, (tx) =>
      tx.update(appointments).set({ calendarId: cal.id, externalEventId: eventId }).where(eq(appointments.id, appt.id)).returning(),
    );
    if (cal.lastError) await recordError(db, workspace.id, cal.id, null);
    return updated;
  } catch (err) {
    await recordError(db, workspace.id, cal.id, errorText(err));
    return appt;
  }
}

export type BookingInput = {
  start: Date;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
  smsOptIn: boolean;
};

/** A booking from the public booking page. */
export async function bookAppointment(db: Db, slug: string, input: BookingInput, providers: ProviderFactory, now = new Date()) {
  const found = await bookingPageBySlug(db, slug);
  if (!found || !found.page.enabled) throw new BookingError("This booking page isn't taking bookings right now.");
  const { page, workspace } = found;

  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  if (!input.firstName.trim()) throw new BookingError("Please enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BookingError("Please enter a valid email address.");
  if (input.phone.trim() && !phone) throw new BookingError("That phone number doesn't look right.");

  const slots = await openSlots(db, page, workspace, providers, now);
  if (!slots.some((s) => s.getTime() === input.start.getTime())) {
    throw new BookingError("Sorry, that time was just taken. Please pick another.");
  }
  const start = input.start;
  const end = new Date(start.getTime() + page.durationMinutes * 60_000);
  const buffer = page.bufferMinutes * 60_000;

  const { appointment, contact } = await withWorkspace(db, workspace.id, async (tx) => {
    // One booking at a time per account, so two people can't grab the same slot.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspace.id}))`);
    if (await hasOverlap(tx, new Date(start.getTime() - buffer), new Date(end.getTime() + buffer))) {
      throw new BookingError("Sorry, that time was just taken. Please pick another.");
    }

    let contact = await findExisting(tx, email, phone);
    if (!contact) {
      [contact] = await tx
        .insert(contacts)
        .values({
          workspaceId: workspace.id,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email,
          phone,
          source: "Booking page",
        })
        .returning();
      await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "created", body: "Added from booking page" });
    } else {
      // Fill in what we didn't have; never overwrite what's there.
      const fill: Partial<Contact> = {};
      if (!contact.firstName && !contact.lastName) Object.assign(fill, { firstName: input.firstName.trim(), lastName: input.lastName.trim() });
      if (!contact.email) fill.email = email;
      if (!contact.phone && phone) fill.phone = phone;
      if (Object.keys(fill).length) [contact] = await tx.update(contacts).set({ ...fill, updatedAt: new Date() }).where(eq(contacts.id, contact.id)).returning();
    }

    // Ticking "text me" records consent, but never overrides an opt-out.
    if (input.smsOptIn && contact.phone && contact.smsConsent === "none") {
      [contact] = await tx
        .update(contacts)
        .set({ smsConsent: "granted", smsConsentSource: "Booking page", smsConsentAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, contact.id))
        .returning();
      await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "consent_changed", body: "Agreed to texts on the booking page" });
    }

    const [appointment] = await tx
      .insert(appointments)
      .values({ workspaceId: workspace.id, contactId: contact.id, title: page.title, notes: input.notes.trim(), startsAt: start, endsAt: end, source: "Booking page" })
      .returning();
    await tx.insert(activities).values({
      workspaceId: workspace.id,
      contactId: contact.id,
      kind: "appointment",
      body: `Booked online for ${formatWhen(start, workspace.timezone)}`,
    });
    return { appointment, contact };
  });

  return { appointment: await copyToCalendar(db, workspace, appointment, contact, providers), workspace, page };
}

/** An appointment added by hand from the CRM. */
export async function createAppointment(
  db: Db,
  workspaceId: string,
  input: { contactId: string; start: Date; durationMinutes: number; title: string; notes?: string },
  userId: string | null,
  providers: ProviderFactory,
) {
  if (!input.title.trim()) throw new BookingError("Give the appointment a title.");
  if (!(input.durationMinutes > 0 && input.durationMinutes <= 24 * 60)) throw new BookingError("Pick a length.");
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const end = new Date(input.start.getTime() + input.durationMinutes * 60_000);
  const { appointment, contact } = await withWorkspace(db, workspaceId, async (tx) => {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, input.contactId));
    if (!contact) throw new BookingError("Contact not found.");
    const [appointment] = await tx
      .insert(appointments)
      .values({ workspaceId, contactId: contact.id, title: input.title.trim(), notes: input.notes?.trim() ?? "", startsAt: input.start, endsAt: end, createdBy: userId })
      .returning();
    await tx.insert(activities).values({
      workspaceId,
      contactId: contact.id,
      kind: "appointment",
      body: `"${appointment.title}" booked for ${formatWhen(input.start, workspace.timezone)}`,
      createdBy: userId,
    });
    return { appointment, contact };
  });
  return copyToCalendar(db, workspace, appointment, contact, providers);
}

export async function cancelAppointment(db: Db, workspaceId: string, appointmentId: string, userId: string | null, providers: ProviderFactory) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const { appt, cal } = await withWorkspace(db, workspaceId, async (tx) => {
    const [appt] = await tx
      .update(appointments)
      .set({ status: "canceled" })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "booked")))
      .returning();
    if (!appt) return { appt: null, cal: null };
    await tx.insert(activities).values({
      workspaceId,
      contactId: appt.contactId,
      kind: "appointment",
      body: `Canceled "${appt.title}" on ${formatWhen(appt.startsAt, workspace.timezone)}`,
      createdBy: userId,
    });
    const [cal] = appt.calendarId ? await tx.select().from(calendars).where(eq(calendars.id, appt.calendarId)) : [];
    return { appt, cal: cal ?? null };
  });
  if (appt?.externalEventId && cal) {
    try {
      await providers(cal, workspace.timezone, tokenSaver(db, workspaceId, cal.id)).deleteEvent?.(appt.externalEventId);
    } catch (err) {
      await recordError(db, workspaceId, cal.id, `Couldn't remove a canceled appointment: ${errorText(err)}`);
    }
  }
  return appt;
}

// ---------------------------------------------------------------------------
// Subscribe-able feed
// ---------------------------------------------------------------------------

/** The account's appointments as an iCalendar feed any calendar app can subscribe to. */
export async function calendarFeed(db: Db, token: string): Promise<string | null> {
  if (token.length < 20) return null;
  const [row] = await db
    .select({ page: bookingPages, workspace: workspaces })
    .from(bookingPages)
    .innerJoin(workspaces, eq(workspaces.id, bookingPages.workspaceId))
    .where(eq(bookingPages.feedToken, token));
  if (!row) return null;
  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = await listAppointments(db, row.workspace.id, { from: since, includeCanceled: true });
  return buildIcs(
    rows.map(({ appointment: a, contact }) => ({
      uid: `${a.id}@shabcrm`,
      title: `${a.title}: ${contactName(contact)}`,
      description: [contact.email, contact.phone, a.notes].filter(Boolean).join("\n"),
      start: a.startsAt,
      end: a.endsAt,
      canceled: a.status === "canceled",
    })),
    `ShabCRM: ${row.workspace.name}`,
  );
}

export { CalendarError };
