import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { db } from "@/db";
import { bookingPageBySlug, openSlots } from "@/server/calendars";
import { realProviders } from "@/server/calendars/config";
import { Booker } from "./booker";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const found = await bookingPageBySlug(db, (await params).slug);
  return { title: found ? found.page.title : "Book" };
}

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const found = await bookingPageBySlug(db, (await params).slug);
  if (!found) notFound();
  const { page, workspace } = found;
  const tz = workspace.timezone;
  const slots = page.enabled ? await openSlots(db, page, workspace, realProviders) : [];

  const days: { date: string; label: string; times: { iso: string; label: string }[] }[] = [];
  for (const slot of slots) {
    const local = DateTime.fromJSDate(slot, { zone: tz });
    const date = local.toISODate()!;
    if (days.at(-1)?.date !== date) days.push({ date, label: local.toFormat("ccc, LLL d"), times: [] });
    days.at(-1)!.times.push({ iso: slot.toISOString(), label: local.toFormat("h:mm a") });
  }
  const zoneName = DateTime.now().setZone(tz).toFormat("ZZZZZ");

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-10">
      <div className="mb-6">
        <div className="text-sm font-medium text-slate-500">{workspace.name}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{page.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {page.durationMinutes} minutes · times shown in {zoneName}
        </p>
        {page.description && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{page.description}</p>}
      </div>
      {!page.enabled ? (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600">This page isn&apos;t taking bookings right now.</p>
      ) : days.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600">
          No open times right now. Please check back soon.
        </p>
      ) : (
        <Booker slug={page.slug} days={days} />
      )}
    </main>
  );
}
