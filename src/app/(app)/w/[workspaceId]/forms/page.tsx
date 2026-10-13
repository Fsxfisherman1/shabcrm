import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { listForms } from "@/server/forms";
import { NewFormButton } from "./new-form";

export const metadata: Metadata = { title: "Forms" };

export default async function FormsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspace(workspaceId);
  const list = await listForms(db, workspaceId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forms"
        description="Lead forms for websites, ads and social links. Everyone who fills one in lands in Contacts."
        actions={<NewFormButton workspaceId={workspaceId} />}
      />
      {list.length === 0 ? (
        <EmptyState title="No forms yet">Click New form to make a contact or quote form you can put on a website.</EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Form</th>
                <th className="px-4 py-3 text-right font-medium">Responses</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/w/${workspaceId}/forms/${f.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {f.name}
                    </Link>
                    <span className="ml-2">{f.enabled ? <Badge tone="green">Live</Badge> : <Badge>Off</Badge>}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{f.submissions}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
