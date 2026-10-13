import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { getCurrentUser } from "@/lib/session";
import { getWorkspaceStats } from "@/server/pipelines";
import { listWorkspacesForUser } from "@/server/workspaces";
import { NewClientForm } from "./new-client-form";

export const metadata: Metadata = { title: "All accounts" };

export default async function AgencyPage() {
  const user = await getCurrentUser();
  const workspaces = await listWorkspacesForUser(db, user.id);
  const stats = await Promise.all(workspaces.map((w) => getWorkspaceStats(db, w.id)));
  const rows = workspaces.map((w, i) => ({ ...w, stats: stats[i] }));
  const totals = stats.reduce(
    (acc, s) => ({
      contacts: acc.contacts + s.contacts,
      openValue: acc.openValue + s.openValueCents,
      won: acc.won + s.wonValueCents30d,
    }),
    { contacts: 0, openValue: 0, won: 0 },
  );

  return (
    <>
      <PageHeader
        title="All accounts"
        description={`${rows.length} accounts · ${totals.contacts.toLocaleString()} contacts · ${formatMoney(totals.openValue)} open pipeline · ${formatMoney(totals.won)} won in the last 30 days`}
      />

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Account</th>
              <th className="px-4 py-3 text-right font-medium">Contacts</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">New (30 days)</th>
              <th className="px-4 py-3 text-right font-medium">Open pipeline</th>
              <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">Won (30 days)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((w) => (
              <tr key={w.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/w/${w.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                    {w.name}
                  </Link>{" "}
                  {w.kind === "agency" && <Badge tone="brand">Your agency</Badge>}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{w.stats.contacts.toLocaleString()}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{w.stats.newContacts30d}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoney(w.stats.openValueCents)}
                  <span className="ml-1 text-xs text-slate-400">({w.stats.openDeals})</span>
                </td>
                <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{formatMoney(w.stats.wonValueCents30d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="mt-6 max-w-xl p-5">
        <h2 className="font-semibold">Add a client account</h2>
        <p className="mb-4 mt-1 text-sm text-slate-500">
          Each client gets their own contacts and pipeline, kept completely separate from other clients.
        </p>
        <NewClientForm />
      </Card>
    </>
  );
}
