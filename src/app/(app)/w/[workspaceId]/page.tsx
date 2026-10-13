import Link from "next/link";
import { db } from "@/db";
import { ConsentBadge } from "@/components/consent-badge";
import { buttonClass, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { contactName, formatDate, formatMoney } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { listContacts } from "@/server/contacts";
import { getWorkspaceStats } from "@/server/pipelines";

export default async function WorkspaceOverview({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  const [stats, recent] = await Promise.all([
    getWorkspaceStats(db, workspaceId),
    listContacts(db, workspaceId, { limit: 8 }),
  ]);
  const base = `/w/${workspaceId}`;

  return (
    <>
      <PageHeader
        title={workspace.name}
        actions={
          <>
            <Link href={`${base}/contacts/import`} className={buttonClass("secondary")}>
              Import CSV
            </Link>
            <Link href={`${base}/contacts/new`} className={buttonClass()}>
              Add contact
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Contacts" value={stats.contacts.toLocaleString()} hint={`${stats.newContacts30d} new in 30 days`} />
        <Stat label="Open deals" value={stats.openDeals} />
        <Stat label="Open pipeline" value={formatMoney(stats.openValueCents)} />
        <Stat label="Won (30 days)" value={formatMoney(stats.wonValueCents30d)} hint={`${stats.wonDeals30d} deals`} />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Newest contacts</h2>
          <Link href={`${base}/contacts`} className="text-sm font-medium text-brand-600 hover:underline">
            View all
          </Link>
        </div>
        {recent.rows.length === 0 ? (
          <EmptyState title="No contacts yet">
            <Link href={`${base}/contacts/import`} className="font-medium text-brand-600 hover:underline">
              Import a CSV
            </Link>{" "}
            or{" "}
            <Link href={`${base}/contacts/new`} className="font-medium text-brand-600 hover:underline">
              add one by hand
            </Link>
            .
          </EmptyState>
        ) : (
          <Card>
            <ul className="divide-y divide-slate-100">
              {recent.rows.map((c) => (
                <li key={c.id}>
                  <Link href={`${base}/contacts/${c.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{contactName(c)}</div>
                      <div className="truncate text-xs text-slate-500">
                        {[c.email, formatPhone(c.phone)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <ConsentBadge consent={c.smsConsent} />
                    <div className="hidden w-28 text-right text-xs text-slate-400 sm:block">{formatDate(c.createdAt)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
