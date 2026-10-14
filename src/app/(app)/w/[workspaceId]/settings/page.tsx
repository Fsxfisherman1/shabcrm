import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { Card, PageHeader } from "@/components/ui";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { getBadgePrefs } from "@/server/badges";
import { messagingConfig, replyToAddress } from "@/server/messaging/config";
import { listPipelines } from "@/server/pipelines";
import { getAiSettings } from "@/server/ai";
import { leadAlertProblems } from "@/server/lead-alerts";
import { AiSettingsForm, ClearCountsSetting, LeadAlertsForm, MessagingForm, NewPipelineForm, PipelineEditor, RenameAccountForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace, user } = await requireWorkspace(workspaceId);
  const prefs = await getBadgePrefs(db, user.id);
  const ai = await getAiSettings(db, workspaceId);
  const alertProblems = leadAlertProblems(workspace);
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
        <h2 className="mb-1 font-semibold">Red counts in the sidebar</h2>
        <p className="mb-4 text-sm text-slate-500">Just for you, in every account.</p>
        <ClearCountsSetting workspaceId={workspaceId} clearPerItem={prefs.clearPerItem} />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Messaging</h2>
        <p className="mb-4 text-sm text-slate-500">
          Text, iMessage, WhatsApp and email all land in the Inbox. Leave a number blank to not use that channel.
        </p>
        <ul className="mb-4 grid gap-1 text-sm sm:grid-cols-2">
          <Status ok={Boolean(config.twilio)} label="Text and WhatsApp (Twilio)" />
          <Status ok={Boolean(config.sendblue)} label="iMessage (Sendblue)" />
          <Status ok={Boolean(config.postmark)} label="Email (Postmark)" />
        </ul>
        <MessagingForm
          workspaceId={workspaceId}
          settings={{
            smsNumber: formatPhone(workspace.smsNumber),
            forwardCallsTo: formatPhone(workspace.forwardCallsTo),
            missedCallTextEnabled: workspace.missedCallTextEnabled,
            missedCallText: workspace.missedCallText,
            emailFromName: workspace.emailFromName ?? "",
            emailFromAddress: workspace.emailFromAddress ?? "",
            whatsappNumber: formatPhone(workspace.whatsappNumber),
            imessageNumber: formatPhone(workspace.imessageNumber),
          }}
        />
        <details className="mt-5 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">Connection details for Twilio, Sendblue and Postmark</summary>
          <dl className="mt-3 space-y-3">
            <Hook label="Twilio number and WhatsApp sender: A message comes in (HTTP POST)" value={`${config.appUrl}/api/webhooks/twilio/sms`} />
            <Hook label="Twilio number: A call comes in (HTTP POST)" value={`${config.appUrl}/api/webhooks/twilio/voice`} />
            <Hook
              label="Postmark inbound webhook URL"
              value={`${config.appUrl}/api/webhooks/postmark/inbound?token=${config.inboundEmailSecret ?? "SET_POSTMARK_INBOUND_SECRET"}`}
            />
            <Hook
              label="Sendblue receive webhook (set its secret to SENDBLUE_WEBHOOK_SECRET)"
              value={`${config.appUrl}/api/webhooks/sendblue`}
            />
            <Hook label="Replies to this account's emails go to" value={replyToAddress(workspaceId) ?? "Set POSTMARK_INBOUND_ADDRESS first"} />
          </dl>
        </details>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Speed-to-lead alerts</h2>
        <p className="mb-4 text-sm text-slate-500">
          When someone texts, emails or fills in a form and nobody has replied in time, you get an email or text. Replies sent by automations don&apos;t count, only a
          person answering. One alert per wait.
        </p>
        {alertProblems.map((p) => (
          <p key={p} className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {p}
          </p>
        ))}
        <LeadAlertsForm
          workspaceId={workspaceId}
          settings={{ minutes: workspace.leadAlertMinutes, email: workspace.leadAlertEmail ?? "", phone: formatPhone(workspace.leadAlertPhone) }}
        />
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">AI</h2>
        <p className="mb-4 text-sm text-slate-500">
          Connect the AI of your choice to draft replies in the Inbox and tag what messages are about. It never sends anything by itself: you read and send every
          draft.
        </p>
        <AiSettingsForm
          workspaceId={workspaceId}
          settings={
            ai
              ? { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl ?? "", about: ai.about, tagMessages: ai.tagMessages, keyEnding: ai.hasKey ? ai.keyEnding : null }
              : null
          }
        />
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

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={ok ? "h-2 w-2 rounded-full bg-emerald-500" : "h-2 w-2 rounded-full bg-amber-400"} />
      {label}: <span className={ok ? "text-emerald-700" : "text-amber-700"}>{ok ? "connected" : "test mode"}</span>
    </li>
  );
}
