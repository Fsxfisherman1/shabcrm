import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { TRIGGER_LABEL } from "@/lib/workflows";
import { listWorkflows } from "@/server/workflows";
import { TEMPLATES } from "@/server/workflows/templates";
import { NewWorkflow } from "./forms";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspace(workspaceId);
  const list = await listWorkflows(db, workspaceId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description="Workflows that text, email, tag and follow up for you when something happens."
        actions={<NewWorkflow workspaceId={workspaceId} templates={TEMPLATES.map(({ key, name, description }) => ({ key, name, description }))} />}
      />

      {list.length === 0 ? (
        <EmptyState title="No workflows yet">Click New workflow and start from a template, like texting back missed calls.</EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Workflow</th>
                <th className="px-4 py-3 font-medium">Starts when</th>
                <th className="px-4 py-3 text-right font-medium">In progress</th>
                <th className="px-4 py-3 text-right font-medium">Finished</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((wf) => (
                <tr key={wf.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/w/${workspaceId}/automations/${wf.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {wf.name}
                    </Link>
                    <span className="ml-2">{wf.enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{TRIGGER_LABEL[wf.trigger.type]}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{wf.inProgress}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{wf.finished}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(wf.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
