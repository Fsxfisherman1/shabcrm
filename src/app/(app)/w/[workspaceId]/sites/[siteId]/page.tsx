import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireWorkspace } from "@/lib/session";
import { getBookingPage } from "@/server/calendars";
import { listForms } from "@/server/forms";
import { messagingConfig } from "@/server/messaging/config";
import { getSite, siteStats } from "@/server/sites";
import { SiteEditor } from "./editor";

export const metadata: Metadata = { title: "Site" };

export default async function SiteEditorPage({ params }: { params: Promise<{ workspaceId: string; siteId: string }> }) {
  const { workspaceId, siteId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) notFound();
  const found = await getSite(db, workspaceId, siteId);
  if (!found) notFound();
  const { site, pages } = found;
  const [forms, booking, stats] = await Promise.all([listForms(db, workspaceId), getBookingPage(db, workspaceId), siteStats(db, workspaceId, siteId)]);

  return (
    <SiteEditor
      workspaceId={workspaceId}
      businessName={workspace.name}
      appUrl={messagingConfig().appUrl}
      bookingOn={booking.enabled}
      forms={forms
        .filter((f) => f.source === "shabcrm")
        .map((f) => ({ id: f.id, name: f.name, enabled: f.enabled, submitLabel: f.submitLabel, fields: f.fields.map((x) => ({ id: x.id, label: x.label, kind: x.kind, required: x.required })) }))}
      stats={stats}
      site={{
        id: site.id,
        kind: site.kind,
        name: site.name,
        slug: site.slug,
        enabled: site.enabled,
        color: site.theme.color,
        font: site.theme.font,
        pages: pages.map((p) => ({ id: p.id, key: p.id, slug: p.slug, title: p.title, blocks: p.blocks })),
      }}
    />
  );
}
