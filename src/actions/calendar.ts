"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { DateTime } from "luxon";
import { db } from "@/db";
import { workspaces, type WeeklyHours } from "@/db/schema";
import { requireWorkspace } from "@/lib/session";
import { markItemsSeen } from "@/server/badges";
import {
  addCalendar,
  bookAppointment,
  BookingError,
  cancelAppointment,
  createAppointment,
  formatWhen,
  removeCalendar,
  updateBookingPage,
  updateCalendarSettings,
} from "@/server/calendars";
import { isValidTimezone } from "@/server/calendars/availability";
import { realProviders } from "@/server/calendars/config";
import { CalendarError, discoverCalDavCalendars, IcsCalendar, normalizeIcsUrl } from "@/server/calendars/providers";
import type { ActionState } from "./types";

const DAYS = ["1", "2", "3", "4", "5", "6", "7"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function int(form: FormData, name: string, min: number, max: number) {
  const n = Number(form.get(name));
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function updateBookingPageAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "Give the booking page a title." };
  const durationMinutes = int(form, "durationMinutes", 5, 480);
  const bufferMinutes = int(form, "bufferMinutes", 0, 240);
  const minNoticeHours = int(form, "minNoticeHours", 0, 24 * 14);
  const maxDaysAhead = int(form, "maxDaysAhead", 1, 365);
  if (durationMinutes === null) return { error: "Appointment length must be between 5 and 480 minutes." };
  if (bufferMinutes === null || minNoticeHours === null || maxDaysAhead === null) return { error: "Check the numbers in the scheduling rules." };
  const timezone = String(form.get("timezone") ?? "");
  if (!isValidTimezone(timezone)) return { error: "Pick a time zone." };

  const weeklyHours: WeeklyHours = {};
  for (const day of DAYS) {
    if (form.get(`day${day}`) !== "on") continue;
    const start = String(form.get(`start${day}`) ?? "");
    const end = String(form.get(`end${day}`) ?? "");
    if (!TIME.test(start) || !TIME.test(end) || start >= end) return { error: "Each open day needs a start time before its end time." };
    weeklyHours[day] = [{ start, end }];
  }

  try {
    await updateBookingPage(db, workspaceId, {
      enabled: form.get("enabled") === "on",
      slug: String(form.get("slug") ?? ""),
      title,
      description: String(form.get("description") ?? "").trim(),
      durationMinutes,
      bufferMinutes,
      minNoticeHours,
      maxDaysAhead,
      weeklyHours,
    });
  } catch (err) {
    if (err instanceof BookingError) return { error: err.message };
    throw err;
  }
  await db.update(workspaces).set({ timezone }).where(eq(workspaces.id, workspaceId));
  refresh();
  return { ok: true, message: "Saved." };
}

export async function addIcsCalendarAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { workspace } = await requireWorkspace(workspaceId);
  const url = normalizeIcsUrl(String(form.get("url") ?? ""));
  if (!url) return { error: "Paste the calendar's secret address. It starts with https:// or webcal://." };
  // Make sure it loads before saving it.
  try {
    await new IcsCalendar(url, workspace.timezone).busy(new Date(), new Date(Date.now() + 86400_000));
  } catch (err) {
    return { error: err instanceof CalendarError ? err.message : "Couldn't load that link." };
  }
  const name = String(form.get("name") ?? "").trim() || new URL(url).hostname.replace(/^www\./, "");
  await addCalendar(db, workspaceId, { kind: "ics", name, externalId: url });
  refresh();
  return { ok: true };
}

export async function addCalDavCalendarAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const serverUrl = String(form.get("serverUrl") ?? "").trim() || "https://caldav.icloud.com/";
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "").replace(/\s/g, "");
  if (!/^https:\/\//.test(serverUrl)) return { error: "The server address must start with https://." };
  if (!username || !password) return { error: "Enter the username and app password." };
  try {
    const found = await discoverCalDavCalendars({ serverUrl, username, password });
    if (!found.length) return { error: "Signed in, but found no calendars." };
    const host = new URL(serverUrl).hostname.includes("icloud") ? "iCloud" : new URL(serverUrl).hostname;
    for (const cal of found) {
      await addCalendar(db, workspaceId, {
        kind: "caldav",
        name: `${cal.name} (${host})`,
        externalId: cal.url,
        credentials: { serverUrl, username, password },
      });
    }
  } catch (err) {
    if (err instanceof CalendarError) return { error: err.message };
    return { error: `Couldn't connect: ${err instanceof Error ? err.message : err}` };
  }
  refresh();
  return { ok: true };
}

export async function updateCalendarAction(workspaceId: string, calendarId: string, input: { checkConflicts?: boolean; addBookings?: boolean }): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await updateCalendarSettings(db, workspaceId, calendarId, input);
  } catch (err) {
    if (err instanceof BookingError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true };
}

export async function removeCalendarAction(workspaceId: string, calendarId: string) {
  await requireWorkspace(workspaceId);
  await removeCalendar(db, workspaceId, calendarId);
  refresh();
}

export async function createAppointmentAction(workspaceId: string, contactId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { user, workspace } = await requireWorkspace(workspaceId);
  const start = DateTime.fromISO(`${form.get("date")}T${form.get("time")}`, { zone: workspace.timezone });
  if (!start.isValid) return { error: "Pick a date and time." };
  const durationMinutes = int(form, "durationMinutes", 5, 24 * 60);
  if (durationMinutes === null) return { error: "Pick a length." };
  try {
    await createAppointment(
      db,
      workspaceId,
      { contactId, start: start.toJSDate(), durationMinutes, title: String(form.get("title") ?? ""), notes: String(form.get("notes") ?? "") },
      user.id,
      realProviders,
    );
  } catch (err) {
    if (err instanceof BookingError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true, message: `Booked for ${formatWhen(start.toJSDate(), workspace.timezone)}.` };
}

export async function cancelAppointmentAction(workspaceId: string, appointmentId: string) {
  const { user } = await requireWorkspace(workspaceId);
  await cancelAppointment(db, workspaceId, appointmentId, user.id, realProviders);
  await markItemsSeen(db, user.id, workspaceId, "appointment", [appointmentId]);
  refresh();
}

/** From the public booking page: no sign-in. */
export async function bookAction(slug: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (String(form.get("website") ?? "")) return { ok: true, message: "" }; // honeypot: bots fill every field
  const start = new Date(String(form.get("start") ?? ""));
  if (Number.isNaN(start.getTime())) return { error: "Pick a time." };
  try {
    const { appointment, workspace } = await bookAppointment(
      db,
      slug,
      {
        start,
        firstName: String(form.get("firstName") ?? ""),
        lastName: String(form.get("lastName") ?? ""),
        email: String(form.get("email") ?? ""),
        phone: String(form.get("phone") ?? ""),
        notes: String(form.get("notes") ?? "").slice(0, 2000),
        smsOptIn: form.get("smsOptIn") === "on",
      },
      realProviders,
    );
    return { ok: true, message: `You're booked for ${formatWhen(appointment.startsAt, workspace.timezone)}.` };
  } catch (err) {
    if (err instanceof BookingError) {
      refresh(); // show the latest open times
      return { error: err.message };
    }
    throw err;
  }
}
