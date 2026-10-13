import { db } from "@/db";
import { calendarFeed } from "@/server/calendars";

// A read-only feed of the account's appointments, for "subscribe to calendar" in any calendar app.
export async function GET(_: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ics = await calendarFeed(db, token.replace(/\.ics$/, ""));
  if (!ics) return new Response("Not found", { status: 404 });
  return new Response(ics, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
}
