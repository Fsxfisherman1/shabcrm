import type { Metadata } from "next";
import Link from "next/link";
import { DateTime } from "luxon";
import { db } from "@/db";
import { Badge, Card, PageHeader } from "@/components/ui";
import { contactName } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { getBookingPage, listAppointments, listCalendars } from "@/server/calendars";
import { oauthApp } from "@/server/calendars/config";
import { messagingConfig } from "@/server/messaging/config";
import { AddCalendar, BookingPageForm, CalendarRow, CancelButton, CopyField } from "./forms";

export const metadata: Metadata = { title: "Calendar" };

const KIND: Record<string, string> = { google: "Google", microsoft: "Outlook", caldav: "CalDAV", ics: "Link (read-only)" };

const US_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const { connected, error } = await searchParams;
  const { workspace } = await requireWorkspace(workspaceId);
  const [page, cals, upcoming] = await Promise.all([
    getBookingPage(db, workspaceId),
    listCalendars(db, workspaceId),
    listAppointments(db, workspaceId, { from: new Date() }),
  ]);
  const { appUrl } = messagingConfig();
  const tz = workspace.timezone;
  const zones = [...US_ZONES, ...Intl.supportedValuesOf("timeZone").filter((z) => !US_ZONES.includes(z))];

  const days = new Map<string, typeof upcoming>();
  for (const row of upcoming) {
    const key = DateTime.fromJSDate(row.appointment.startsAt, { zone: tz }).toISODate()!;
    days.set(key, [...(days.get(key) ?? []), row]);
  }
  const time = (d: Date) => DateTime.fromJSDate(d, { zone: tz }).toFormat("h:mm a");

  return (
    <div className="space-y-6">
      <PageHeader title="Calendar" description={`Appointments and online booking. Times are in ${tz.replace(/_/g, " ")}.`} />

      {connected && (
        <Card className="border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {connected === "google" ? "Google Calendar" : "Outlook"} is connected.
        </Card>
      )}
      {error && (
        <Card className="border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error === "not-configured"
            ? "That calendar can't be connected until it's set up on the server (see the setup guide)."
            : error === "cancelled" || error === "access_denied"
              ? "Connecting was cancelled."
              : `Couldn't connect: ${error}`}
        </Card>
      )}

      <section>
        <h2 className="mb-3 font-semibold">Upcoming</h2>
        {days.size === 0 ? (
          <Card className="p-6 text-center text-sm text-slate-500">
            No upcoming appointments. Share your booking page below, or book one from a contact&apos;s page.
          </Card>
        ) : (
          <div className="space-y-4">
            {[...days].map(([day, rows]) => (
              <Card key={day} className="overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-medium">
                  {DateTime.fromISO(day, { zone: tz }).toFormat("cccc, LLLL d")}
                </div>
                <ul className="divide-y divide-slate-100">
                  {rows.map(({ appointment: a, contact }) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                      <span className="w-36 shrink-0 tabular-nums text-slate-600">
                        {time(a.startsAt)} – {time(a.endsAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{a.title}</span> with{" "}
                        <Link href={`/w/${workspaceId}/contacts/${contact.id}`} className="text-brand-600 hover:underline">
                          {contactName(contact)}
                        </Link>
                        {a.notes && <span className="block truncate text-slate-500">{a.notes}</span>}
                      </span>
                      {a.source === "Booking page" && <Badge tone="brand">Booked online</Badge>}
                      <CancelButton workspaceId={workspaceId} appointmentId={a.id} />
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Booking page</h2>
        <p className="mb-4 text-sm text-slate-500">
          A page customers use to book a time. It only offers times inside your hours that are free on every calendar set to check
          for conflicts.
        </p>
        <div className="mb-4">
          <CopyField label="Your booking page" value={`${appUrl}/book/${page.slug}`} open={page.enabled} />
          {!page.enabled && <p className="mt-1 text-xs text-amber-700">Turned off. Tick &ldquo;Accept bookings&rdquo; below to start taking bookings.</p>}
        </div>
        <BookingPageForm
          workspaceId={workspaceId}
          zones={zones}
          page={{
            enabled: page.enabled,
            slug: page.slug,
            title: page.title,
            description: page.description,
            durationMinutes: page.durationMinutes,
            bufferMinutes: page.bufferMinutes,
            minNoticeHours: page.minNoticeHours,
            maxDaysAhead: page.maxDaysAhead,
            weeklyHours: page.weeklyHours,
            timezone: tz,
          }}
        />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Connected calendars</h2>
        <p className="mb-4 text-sm text-slate-500">
          Connect the calendars this business already uses, so bookings avoid busy times and show up where they look.
        </p>
        {cals.length > 0 && (
          <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {cals.map((c) => (
              <CalendarRow
                key={c.id}
                workspaceId={workspaceId}
                calendar={{ id: c.id, name: c.name, kind: KIND[c.kind], writable: c.kind !== "ics", checkConflicts: c.checkConflicts, addBookings: c.addBookings, lastError: c.lastError }}
              />
            ))}
          </ul>
        )}
        <AddCalendar workspaceId={workspaceId} google={Boolean(oauthApp("google"))} microsoft={Boolean(oauthApp("microsoft"))} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">See appointments in your calendar app</h2>
        <p className="mb-3 text-sm text-slate-500">
          Works with any calendar app: in Google Calendar choose <strong>Other calendars → From URL</strong>; on iPhone or Mac,
          choose <strong>Add Subscription Calendar</strong>; in Outlook, <strong>Add calendar → Subscribe from web</strong>. Keep this
          link private.
        </p>
        <CopyField label="Calendar feed" value={`${appUrl}/api/calendars/feed/${page.feedToken}.ics`} />
      </Card>
    </div>
  );
}
