import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { Card, PageHeader } from "@/components/ui";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { messagingConfig, replyToAddress } from "@/server/messaging/config";
import { listPipelines } from "@/server/pipelines";
import { MessagingForm, NewPipelineForm, PipelineEditor, RenameAccountForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  const config = messagingConfig();
  const pipelines = await listPipelines(db, workspaceId);
  const stages = pipelines.length
    ? await withWorkspace(db, workspaceId, (tx) =>
        tx
          .select()
          .from(pipelineStages)
          .where(inArray(pipelineStages.pipelineId, pipelines.map((p) => p.id)))
          .orderBy(asc(pipelineStages.position)),
      )
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Account name</h2>
        <RenameAccountForm workspaceId={workspaceId} name={workspace.name} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Texting and email</h2>
        <p className="mb-4 text-sm text-slate-500">
          {config.twilio && config.postmark
            ? "Texting (Twilio) and email (Postmark) are connected."
            : "Test mode: fill these in now and messages are saved without being sent until Twilio and Postmark are connected."}
        </p>
        <MessagingForm
          workspaceId={workspaceId}
          settings={{
            smsNumber: formatPhone(workspace.smsNumber),
            forwardCallsTo: formatPhone(workspace.forwardCallsTo),
            missedCallTextEnabled: workspace.missedCallTextEnabled,
            missedCallText: workspace.missedCallText,
            emailFromName: workspace.emailFromName ?? "",
            emailFromAddress: workspace.emailFromAddress ?? "",
          }}
        />
        <details className="mt-5 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">Connection details for Twilio and Postmark</summary>
          <dl className="mt-3 space-y-3">
            <Hook label="Twilio number: A message comes in (HTTP POST)" value={`${config.appUrl}/api/webhooks/twilio/sms`} />
            <Hook label="Twilio number: A call comes in (HTTP POST)" value={`${config.appUrl}/api/webhooks/twilio/voice`} />
            <Hook
              label="Postmark inbound webhook URL"
              value={`${config.appUrl}/api/webhooks/postmark/inbound?token=${config.inboundEmailSecret ?? "SET_POSTMARK_INBOUND_SECRET"}`}
            />
            <Hook label="Replies to this account's emails go to" value={replyToAddress(workspaceId) ?? "Set POSTMARK_INBOUND_ADDRESS first"} />
          </dl>
        </details>
      </Card>

      <div>
        <h2 className="mb-1 font-semibold">Pipelines</h2>
        <p className="mb-3 text-sm text-slate-500">
          Rename, reorder or add stages. A stage can only be deleted once it has no open deals.
        </p>
        <div className="space-y-4">
          {pipelines.map((p) => (
            <PipelineEditor
              key={p.id}
              workspaceId={workspaceId}
              pipeline={{ id: p.id, name: p.name }}
              stages={stages.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name }))}
            />
          ))}
        </div>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">New pipeline</h2>
        <NewPipelineForm workspaceId={workspaceId} />
      </Card>
    </div>
  );
}

function Hook({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-all rounded bg-slate-50 px-2 py-1 font-mono text-xs">{value}</dd>
    </div>
  );
}
