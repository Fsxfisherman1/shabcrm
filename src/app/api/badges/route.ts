import { headers } from "next/headers";
import { db } from "@/db";
import { auth } from "@/lib/auth";
import { allBadges } from "@/server/badges";

// The sidebar polls this to keep its red counts current.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response(null, { status: 401 });
  const badges = await allBadges(db, session.user.id, new Date().toISOString().slice(0, 10));
  return Response.json(badges, { headers: { "Cache-Control": "no-store" } });
}
