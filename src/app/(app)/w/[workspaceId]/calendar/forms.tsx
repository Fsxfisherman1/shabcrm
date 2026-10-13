"use client";

import { useState, useTransition } from "react";
import {
  addCalDavCalendarAction,
  addIcsCalendarAction,
  cancelAppointmentAction,
  removeCalendarAction,
  updateBookingPageAction,
  updateCalendarAction,
} from "@/actions/calendar";
import type { WeeklyHours } from "@/db/schema";
import { Badge, Button, buttonClass, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

export function CancelButton({ workspaceId, appointmentId }: { workspaceId: string; appointmentId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      className="text-slate-400 hover:text-red-600"
      onClick={() => {
        if (confirm("Cancel this appointment?")) startTransition(() => cancelAppointmentAction(workspaceId, appointmentId));
      }}
    >
      Cancel
    </Button>
  );
}

export function CopyField({ label, value, open }: { label: string; value: string; open?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-slate-700">{label}</div>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {open && (
          <a href={value} target="_blank" rel="noreferrer" className={buttonClass("secondary")}>
            Open
          </a>
        )}
      </div>
    </div>
  );
}

const DAYS: [keyof WeeklyHours, string][] = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["7", "Sunday"],
];

type PageSettings = {
  enabled: boolean;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  weeklyHours: WeeklyHours;
  timezone: string;
};

export function BookingPageForm({ workspaceId, page, zones }: { workspaceId: string; page: PageSettings; zones: string[] }) {
  const [state, onSubmit, pending] = useActionForm(updateBookingPageAction.bind(null, workspaceId));
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" name="enabled" defaultChecked={page.enabled} className="h-4 w-4" />
        Accept bookings
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" name="title">
          <Input id="title" name="title" defaultValue={page.title} required />
        </Field>
        <Field label="Page address" name="slug">
          <Input id="slug" name="slug" defaultValue={page.slug} required />
        </Field>
      </div>
      <Field label="Description (optional)" name="description">
        <Textarea id="description" name="description" rows={2} defaultValue={page.description} placeholder="What to expect, where to park, etc." />
      </Field>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Length (minutes)" name="durationMinutes">
          <Input id="durationMinutes" name="durationMinutes" type="number" min={5} max={480} defaultValue={page.durationMinutes} />
        </Field>
        <Field label="Gap between (minutes)" name="bufferMinutes">
          <Input id="bufferMinutes" name="bufferMinutes" type="number" min={0} max={240} defaultValue={page.bufferMinutes} />
        </Field>
        <Field label="Notice (hours)" name="minNoticeHours">
          <Input id="minNoticeHours" name="minNoticeHours" type="number" min={0} defaultValue={page.minNoticeHours} />
        </Field>
        <Field label="Days ahead" name="maxDaysAhead">
          <Input id="maxDaysAhead" name="maxDaysAhead" type="number" min={1} max={365} defaultValue={page.maxDaysAhead} />
        </Field>
      </div>
      <Field label="Time zone" name="timezone">
        <Select id="timezone" name="timezone" defaultValue={page.timezone}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Open hours</legend>
        <div className="space-y-2">
          {DAYS.map(([day, label]) => {
            const hours = page.weeklyHours[day]?.[0];
            return (
              <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex w-32 items-center gap-2">
                  <input type="checkbox" name={`day${day}`} defaultChecked={Boolean(hours)} className="h-4 w-4" />
                  {label}
                </label>
                <div className="w-36">
                  <Input type="time" name={`start${day}`} defaultValue={hours?.start ?? "09:00"} aria-label={`${label} opens`} />
                </div>
                <span className="text-slate-400">to</span>
                <div className="w-36">
                  <Input type="time" name={`end${day}`} defaultValue={hours?.end ?? "17:00"} aria-label={`${label} closes`} />
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
      <FormError message={state.error} />
      {state.ok && <p className="text-sm text-emerald-600">{state.message}</p>}
      <Button type="submit" disabled={pending}>
        Save booking page
      </Button>
    </form>
  );
}

type CalendarInfo = { id: string; name: string; kind: string; writable: boolean; checkConflicts: boolean; addBookings: boolean; lastError: string | null };

export function CalendarRow({ workspaceId, calendar: c }: { workspaceId: string; calendar: CalendarInfo }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const update = (input: { checkConflicts?: boolean; addBookings?: boolean }) =>
    startTransition(async () => {
      const res = await updateCalendarAction(workspaceId, c.id, input);
      setError(res.error ?? null);
    });
  return (
    <li className={`space-y-2 px-4 py-3 text-sm ${pending ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.name}</span>
        <Badge>{c.kind}</Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-slate-400 hover:text-red-600"
          onClick={() => confirm(`Disconnect ${c.name}?`) && startTransition(() => removeCalendarAction(workspaceId, c.id))}
        >
          Disconnect
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-600">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={c.checkConflicts} onChange={(e) => update({ checkConflicts: e.target.checked })} className="h-4 w-4" />
          Check for conflicts
        </label>
        {c.writable && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.addBookings} onChange={(e) => update({ addBookings: e.target.checked })} className="h-4 w-4" />
            Add new appointments here
          </label>
        )}
      </div>
      {c.lastError && <p className="text-xs text-red-600">Last problem: {c.lastError}</p>}
      <FormError message={error} />
    </li>
  );
}

export function AddCalendar({ workspaceId, google, microsoft }: { workspaceId: string; google: boolean; microsoft: boolean }) {
  const [open, setOpen] = useState<"caldav" | "ics" | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <OAuthButton workspaceId={workspaceId} provider="google" label="Connect Google Calendar" ready={google} />
        <OAuthButton workspaceId={workspaceId} provider="microsoft" label="Connect Outlook / Microsoft 365" ready={microsoft} />
        <Button type="button" variant="secondary" onClick={() => setOpen(open === "caldav" ? null : "caldav")}>
          Connect Apple iCloud or other
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(open === "ics" ? null : "ics")}>
          Add a calendar link
        </Button>
      </div>
      {(!google || !microsoft) && (
        <p className="text-xs text-slate-500">
          {!google && !microsoft ? "Google and Outlook buttons work" : !google ? "The Google button works" : "The Outlook button works"} once
          they&apos;re set up on the server (a one-time step in the setup guide). Until then, a calendar link works for any of them.
        </p>
      )}
      {open === "caldav" && <CalDavForm workspaceId={workspaceId} onDone={() => setOpen(null)} />}
      {open === "ics" && <IcsForm workspaceId={workspaceId} onDone={() => setOpen(null)} />}
    </div>
  );
}

function OAuthButton({ workspaceId, provider, label, ready }: { workspaceId: string; provider: string; label: string; ready: boolean }) {
  if (!ready) {
    return (
      <Button type="button" variant="secondary" disabled title="Needs one-time setup on the server">
        {label}
      </Button>
    );
  }
  return (
    // A full page load: the browser goes to Google or Microsoft to sign in.
    <a href={`/api/calendars/connect/${provider}?w=${workspaceId}`} className={buttonClass("secondary")}>
      {label}
    </a>
  );
}

function CalDavForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [server, setServer] = useState("icloud");
  const [state, onSubmit, pending] = useActionForm(addCalDavCalendarAction.bind(null, workspaceId), { onSuccess: onDone });
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-200 p-4">
      <p className="text-sm text-slate-600">
        For iCloud, use your Apple ID email and an <strong>app-specific password</strong> (make one at account.apple.com → Sign-In and
        Security → App-Specific Passwords). Fastmail, Nextcloud, Zoho and other CalDAV calendars work the same way with their server
        address.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Calendar service" name="service">
          <Select id="service" value={server} onChange={(e) => setServer(e.target.value)}>
            <option value="icloud">Apple iCloud</option>
            <option value="other">Other (CalDAV)</option>
          </Select>
        </Field>
        <Field label="Username or email" name="username">
          <Input id="username" name="username" autoComplete="off" required />
        </Field>
        <Field label="App password" name="password">
          <Input id="password" name="password" type="password" autoComplete="new-password" required />
        </Field>
      </div>
      {server === "icloud" ? (
        <input type="hidden" name="serverUrl" value="https://caldav.icloud.com/" />
      ) : (
        <Field label="Server address" name="serverUrl">
          <Input id="serverUrl" name="serverUrl" placeholder="https://caldav.fastmail.com/" required />
        </Field>
      )}
      <FormError message={state.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

function IcsForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [state, onSubmit, pending] = useActionForm(addIcsCalendarAction.bind(null, workspaceId), { onSuccess: onDone });
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-200 p-4">
      <p className="text-sm text-slate-600">
        Paste a calendar&apos;s private iCal link and ShabCRM will avoid its busy times. It can&apos;t add appointments to it. In Google
        Calendar: <strong>Settings → your calendar → Integrate calendar → Secret address in iCal format</strong>. In Outlook:{" "}
        <strong>Settings → Shared calendars → Publish a calendar → ICS</strong>.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Field label="Name" name="name">
          <Input id="name" name="name" placeholder="e.g. Alex's Google Calendar" />
        </Field>
        <Field label="Calendar link" name="url">
          <Input id="url" name="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" required />
        </Field>
      </div>
      <FormError message={state.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Add"}
      </Button>
    </form>
  );
}
