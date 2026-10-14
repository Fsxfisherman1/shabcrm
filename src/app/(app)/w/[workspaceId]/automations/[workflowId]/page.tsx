import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { db } from "@/db";
import { Badge, EmptyState } from "@/components/ui";
import { contactName } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { markItemsSeen } from "@/server/badges";
import { listContacts, listTags } from "@/server/contacts";
import { messagingConfig } from "@/server/messaging/config";
import { listForms } from "@/server/forms";
import { listPipelinesWithStages } from "@/server/pipelines";
import { getWorkflow, listRuns } from "@/server/workflows";
import { Builder } from "./builder";

export const metadata: Metadata = { title: "Workflow" };

const STATUS: Record<string, { label: string; tone: "slate" | "green" | "red" | "amber" | "brand" }> = {
  active: { label: "Running", tone: "brand" },
  waiting: { label: "Waiting", tone: "amber" },
  completed: { label: "Finished", tone: "green" },
  stopped: { label: "Stopped", tone: "slate" },
  failed: { label: "Failed", tone: "red" },
};

export default async function WorkflowPage({ params }: { params: Promise<{ workspaceId: string; workflowId: string }> }) {
  const { workspaceId, workflowId } = await params;
  const { workspace, user } = await requireWorkspace(workspaceId);
  if (!/^[0-9a-f-]{36}$/i.test(workflowId)) notFound();
  const workflow = await getWorkflow(db, workspaceId, workflowId);
  if (!workflow) notFound();
  const [pipelines, forms, tags, { rows: contacts }, runs] = await Promise.all([
    listPipelinesWithStages(db, workspaceId),
    listForms(db, workspaceId),
    listTags(db, workspaceId),
    listContacts(db, workspaceId, { limit: 500 }),
    listRuns(db, workspaceId, workflowId),
  ]);
  await markItemsSeen(db, user.id, workspaceId, "run", runs.filter(({ run }) => run.status === "failed").map(({ run }) => run.id));
  const { appUrl } = messagingConfig();
  const tz = workspace.timezone;
  const when = (d: Date) => DateTime.fromJSDate(d, { zone: tz }).toFormat("LLL d, h:mm a");

  const history =
    runs.length === 0 ? (
      <EmptyState title="Nobody has gone through this workflow yet">Try it with a contact from the Settings tab to see each step here.</EmptyState>
    ) : (
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {runs.map(({ run, contact, logs }, i) => (
          <details key={run.id} open={i === 0} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
              <Link href={`/w/${workspaceId}/contacts/${contact.id}`} className="font-medium hover:text-brand-700">
                {contactName({ ...contact, phone: formatPhone(contact.phone) })}
              </Link>
              <Badge tone={STATUS[run.status].tone}>{STATUS[run.status].label}</Badge>
              {run.status === "waiting" && run.wakeAt && <span className="text-xs text-slate-500">until {when(run.wakeAt)}</span>}
              <span className="ml-auto text-xs text-slate-500">Started {when(run.startedAt)}</span>
            </summary>
            <ol className="mt-3 space-y-1.5 border-l border-slate-200 pl-4 text-sm">
              {logs.map((l) => (
                <li key={l.id} className="flex flex-wrap gap-x-3">
                  <span className="w-28 shrink-0 text-xs leading-5 text-slate-400 tabular-nums">{when(l.createdAt)}</span>
                  <span className={l.outcome.startsWith("Failed") ? "text-red-700" : l.outcome.startsWith("Skipped") ? "text-amber-700" : "text-slate-700"}>
                    {l.outcome}
                  </span>
                </li>
              ))}
              {run.note && run.status === "failed" && <li className="text-red-700">{run.note}</li>}
            </ol>
          </details>
        ))}
      </div>
    );

  return (
    <Builder
      workspaceId={workspaceId}
      workflow={{
        id: workflow.id,
        name: workflow.name,
        enabled: workflow.enabled,
        trigger: workflow.trigger,
        steps: workflow.steps,
        stopOnReply: workflow.stopOnReply,
        allowReentry: workflow.allowReentry,
      }}
      hookUrl={`${appUrl}/api/workflows/hooks/${workspaceId}/${workflow.hookToken}`}
      pipelines={pipelines}
      forms={forms.map((f) => ({ id: f.id, name: f.name }))}
      tags={tags.map((t) => t.tag)}
      contacts={contacts.map((c) => ({ id: c.id, name: contactName({ ...c, phone: formatPhone(c.phone) }) }))}
      runCount={runs.length}
      inProgress={runs.filter((r) => r.run.status === "active" || r.run.status === "waiting").length}
      history={history}
    />
  );
}
