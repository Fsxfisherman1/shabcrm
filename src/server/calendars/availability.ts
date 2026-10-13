import { DateTime } from "luxon";
import type { WeeklyHours } from "@/db/schema";

export type Interval = { start: Date; end: Date };

export type AvailabilityRules = {
  timezone: string;
  weeklyHours: WeeklyHours;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
};

export const DEFAULT_HOURS: WeeklyHours = Object.fromEntries(
  ["1", "2", "3", "4", "5"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]),
);

/** Minutes between offered start times. */
export function slotStep(durationMinutes: number) {
  return durationMinutes < 30 ? 15 : 30;
}

/**
 * Open start times within the weekly hours (in the account's time zone),
 * at least `minNoticeHours` from now, that don't overlap anything busy
 * (with the buffer kept clear on both sides).
 */
export function availableSlots(rules: AvailabilityRules, busy: Interval[], now = new Date()): Date[] {
  const step = slotStep(rules.durationMinutes);
  const earliest = now.getTime() + rules.minNoticeHours * 3600_000;
  const buffer = rules.bufferMinutes * 60_000;
  const length = rules.durationMinutes * 60_000;
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const today = DateTime.fromJSDate(now, { zone: rules.timezone }).startOf("day");
  const slots: Date[] = [];

  for (let i = 0; i <= rules.maxDaysAhead; i++) {
    const day = today.plus({ days: i });
    for (const window of rules.weeklyHours[String(day.weekday) as keyof WeeklyHours] ?? []) {
      const [sh, sm] = window.start.split(":").map(Number);
      const [eh, em] = window.end.split(":").map(Number);
      const windowEnd = day.set({ hour: eh, minute: em }).toMillis();
      for (let t = day.set({ hour: sh, minute: sm }); t.toMillis() + length <= windowEnd; t = t.plus({ minutes: step })) {
        const start = t.toMillis();
        if (start < earliest) continue;
        const clash = sorted.some((b) => b.start.getTime() < start + length + buffer && b.end.getTime() > start - buffer);
        if (!clash) slots.push(new Date(start));
      }
    }
  }
  return slots;
}

export function isValidTimezone(zone: string) {
  return DateTime.local().setZone(zone).isValid;
}
