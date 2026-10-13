import { headers } from "next/headers";
import { db } from "@/db";
import { auth } from "@/lib/auth";
import { messagingConfig } from "@/server/messaging/config";
import { getMembership } from "@/server/workspaces";

export const appUrl = () => messagingConfig().appUrl;

export const callbackUrl = (provider: string) => `${appUrl()}/api/calendars/callback/${provider}`;

/** The signed-in user, if they belong to the workspace. Route handlers can't use requireWorkspace's notFound(). */
export async function memberOf(workspaceId: string | null) {
  if (!workspaceId || !/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const membership = await getMembership(db, session.user.id, workspaceId);
  return membership ? { userId: session.user.id } : null;
}

export function backToCalendar(workspaceId: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return Response.redirect(`${appUrl()}/w/${workspaceId}/calendar${qs ? `?${qs}` : ""}`, 303);
}
