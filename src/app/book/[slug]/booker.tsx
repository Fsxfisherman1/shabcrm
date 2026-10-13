"use client";

import clsx from "clsx";
import { useState } from "react";
import { bookAction } from "@/actions/calendar";
import { Button, Field, FormError, Input, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

type Day = { date: string; label: string; times: { iso: string; label: string }[] };

export function Booker({ slug, days }: { slug: string; days: Day[] }) {
  const [dayIndex, setDayIndex] = useState(0);
  const [time, setTime] = useState<{ iso: string; label: string } | null>(null);
  const [state, onSubmit, pending] = useActionForm(bookAction.bind(null, slug));
  const day = days[Math.min(dayIndex, days.length - 1)];

  if (state.ok) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <div className="text-lg font-semibold text-emerald-900">{state.message || "You're booked."}</div>
        <p className="mt-1 text-sm text-emerald-800">We look forward to seeing you.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="mb-2 text-sm font-medium text-slate-700">Pick a day</h2>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {days.map((d, i) => (
            <button
              key={d.date}
              type="button"
              onClick={() => {
                setDayIndex(i);
                setTime(null);
              }}
              className={clsx(
                "shrink-0 rounded-lg border px-3 py-2 text-sm",
                i === dayIndex ? "border-brand-600 bg-brand-50 font-medium text-brand-700" : "border-slate-200 hover:bg-slate-50",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-slate-700">Pick a time</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {day.times.map((t) => (
            <button
              key={t.iso}
              type="button"
              onClick={() => setTime(t)}
              className={clsx(
                "rounded-lg border px-2 py-2 text-sm tabular-nums",
                time?.iso === t.iso ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 hover:border-brand-300",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {time && (
        <form onSubmit={onSubmit} className="space-y-3 border-t border-slate-100 pt-5">
          <p className="text-sm font-medium">
            {day.label} at {time.label}
          </p>
          <input type="hidden" name="start" value={time.iso} />
          {/* Hidden from people; bots fill it in. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name" name="firstName">
              <Input id="firstName" name="firstName" autoComplete="given-name" required />
            </Field>
            <Field label="Last name" name="lastName">
              <Input id="lastName" name="lastName" autoComplete="family-name" />
            </Field>
            <Field label="Email" name="email">
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label="Mobile phone (optional)" name="phone">
              <Input id="phone" name="phone" type="tel" autoComplete="tel" />
            </Field>
          </div>
          <Field label="Anything we should know? (optional)" name="notes">
            <Textarea id="notes" name="notes" rows={2} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input type="checkbox" name="smsOptIn" className="mt-0.5 h-4 w-4" />
            <span>Text me about this appointment. Message and data rates may apply. Reply STOP to opt out.</span>
          </label>
          <FormError message={state.error} />
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Booking…" : "Confirm booking"}
          </Button>
        </form>
      )}
    </div>
  );
}
