"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { db } from "@/db";
import { requireWorkspace } from "@/lib/session";
import type { SiteKind } from "@/lib/sites";
import { createSite, deleteSite, recordSiteEvent, saveSite, SiteError, type SiteInput } from "@/server/sites";
import type { ActionState } from "./types";

export async function createSiteAction(workspaceId: string, kind: SiteKind) {
  await requireWorkspace(workspaceId);
  const site = await createSite(db, workspaceId, kind === "funnel" ? "funnel" : "website", "");
  redirect(`/w/${workspaceId}/sites/${site.id}`);
}

/** On success, `message` says so; the saved pages come back so new ones get their ids. */
export async function saveSiteAction(workspaceId: string, siteId: string, input: SiteInput): Promise<ActionState & { pageIds?: string[] }> {
  await requireWorkspace(workspaceId);
  try {
    const { pages } = await saveSite(db, workspaceId, siteId, input);
    refresh();
    return { ok: true, message: "Saved.", pageIds: pages.map((p) => p.id) };
  } catch (err) {
    if (err instanceof SiteError) return { error: err.message };
    throw err;
  }
}

export async function deleteSiteAction(workspaceId: string, siteId: string) {
  await requireWorkspace(workspaceId);
  await deleteSite(db, workspaceId, siteId);
  redirect(`/w/${workspaceId}/sites`);
}

/** From the public pages: someone visited a page or sent its form. */
export async function recordSiteEventAction(pageId: string, kind: "view" | "submit", visitorId: string) {
  await recordSiteEvent(db, { pageId: String(pageId), kind: kind === "submit" ? "submit" : "view", visitorId: String(visitorId) });
}
