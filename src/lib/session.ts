import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { auth } from "@/lib/auth";
import { getMembership } from "@/server/workspaces";

export type CurrentUser = { id: string; name: string; email: string };

/** The signed-in user, or a redirect to /login. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const { id, name, email } = session.user;
  return { id, name, email };
});

/**
 * Confirms the signed-in user belongs to the workspace. Every page and action
 * that touches a workspace's data goes through this first.
 */
export const requireWorkspace = cache(async (workspaceId: string) => {
  const user = await getCurrentUser();
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) notFound();
  const membership = await getMembership(db, user.id, workspaceId);
  if (!membership) notFound();
  return { user, workspace: membership.workspace, role: membership.role };
});
