import ICAL from "ical.js";
import { DateTime } from "luxon";
import type { Interval } from "./availability";

type IcalTime = InstanceType<typeof ICAL.Time>;

function toDate(time: IcalTime, component: InstanceType<typeof ICAL.Component>, prop: "dtstart" | "dtend", fallbackZone: string): Date {
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toJSDate();
  // A zone defined by a VTIMEZONE in the file (e.g. Outlook's "Eastern Standard Time").
  if (time.zone && time.zone !== ICAL.Timezone.localTimezone && time.zone.component) {
    return new Date(time.toUnixTime() * 1000);
  }
  // A bare IANA name, a floating time or an all-day date: read it in that zone,
  // else the account's own zone.
  // (ical.js drops a TZID it has no VTIMEZONE for, so read it off the property.)
  const param = (component.getFirstProperty(prop) ?? component.getFirstProperty("dtstart"))?.getParameter("tzid");
  const tzid = typeof param === "string" ? param : undefined;
  const zone = tzid && DateTime.local().setZone(tzid).isValid ? tzid : fallbackZone;
  return DateTime.fromObject(
    { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second },
    { zone },
  ).toJSDate();
}

/**
 * Busy times between `from` and `to` from an iCalendar file: recurring events
 * are expanded (with their exceptions), and events marked free (TRANSP:
 * TRANSPARENT, as Google exports free all-day events) or canceled are skipped.
 */
export function busyFromIcs(texts: string | string[], from: Date, to: Date, timezone: string): Interval[] {
  const busy: Interval[] = [];
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const root = new ICAL.Component(ICAL.parse(text));
    for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

    const vevents = root.getAllSubcomponents("vevent");
    const masters = new Map<string, InstanceType<typeof ICAL.Event>>();
    const exceptions: InstanceType<typeof ICAL.Event>[] = [];
    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);
      if (event.isRecurrenceException()) exceptions.push(event);
      else masters.set(event.uid, event);
    }
    for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

    const blocks = (component: InstanceType<typeof ICAL.Component>) =>
      String(component.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase() !== "TRANSPARENT" &&
      String(component.getFirstPropertyValue("status") ?? "").toUpperCase() !== "CANCELLED";

    const add = (start: Date, end: Date) => {
      if (start < to && end > from) busy.push({ start, end });
    };

    for (const event of masters.values()) {
      if (!event.startDate) continue;
      if (!event.isRecurring()) {
        if (blocks(event.component)) add(toDate(event.startDate, event.component, "dtstart", timezone), toDate(event.endDate, event.component, "dtend", timezone));
        continue;
      }
      const it = event.iterator();
      for (let i = 0, next = it.next(); next && i < 5000; i++, next = it.next()) {
        const details = event.getOccurrenceDetails(next);
        const start = toDate(details.startDate, details.item.component, "dtstart", timezone);
        if (start >= to) break;
        if (blocks(details.item.component)) add(start, toDate(details.endDate, details.item.component, "dtend", timezone));
      }
    }
  }
  return busy;
}

// ---------------------------------------------------------------------------
// Writing iCalendar
// ---------------------------------------------------------------------------

export type IcsEvent = {
  uid: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  canceled?: boolean;
  updatedAt?: Date;
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds lines longer than 75 octets, as RFC 5545 requires. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
    }
    current += ch;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildIcs(events: IcsEvent[], calendarName?: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShabCRM//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (calendarName) lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(e.updatedAt ?? new Date())}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${escapeText(e.title)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    lines.push(`STATUS:${e.canceled ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
