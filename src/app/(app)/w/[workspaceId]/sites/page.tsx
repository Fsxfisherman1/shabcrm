import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { SITE_KIND_LABEL } from "@/lib/sites";
import { listSites } from "@/server/sites";
import { NewSiteButtons } from "./new-site";

export const metadata: Metadata = { title: "Sites" };

export default async function SitesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspace(workspaceId);
  const list = await listSites(db, workspaceId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sites"
        description="Websites and funnels built from ready-made sections. Their forms put leads straight into Contacts."
        actions={<NewSiteButtons workspaceId={workspaceId} />}
      />
      {list.length === 0 ? (
        <EmptyState title="No sites yet">
          A website has a few pages with a menu. A funnel walks people through steps in order, like a free-quote page and then a booking page. Both start
          filled in, so you only change the words.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 text-right font-medium">Pages</th>
                <th className="px-4 py-3 text-right font-medium">Visitors, 30 days</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/w/${workspaceId}/sites/${s.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {s.name}
                    </Link>
                    <span className="ml-2">{s.enabled ? <Badge tone="green">Published</Badge> : <Badge>Draft</Badge>}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{SITE_KIND_LABEL[s.kind]}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.pages}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.visitors}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(s.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
