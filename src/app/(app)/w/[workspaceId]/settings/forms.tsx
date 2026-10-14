"use client";

import { useState, useTransition } from "react";
import {
  addStageAction,
  createPipelineAction,
  deleteStageAction,
  renamePipelineAction,
  renameStageAction,
  reorderStagesAction,
} from "@/actions/pipelines";
import { removeAiSettingsAction, saveAiSettingsAction, testAiAction } from "@/actions/ai";
import { saveLeadAlertsAction, updateMessagingSettingsAction } from "@/actions/messaging";
import type { ActionState } from "@/actions/types";
import { renameAccount, setClearPerItemAction } from "@/actions/workspaces";
import { Button, Card, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import type { AiProvider } from "@/db/schema";
import { AI_PROVIDERS } from "@/lib/ai";
import { useActionForm } from "@/components/use-action-form";
import { DEFAULT_STAGES } from "@/lib/default-stages";

export function RenameAccountForm({ workspaceId, name }: { workspaceId: string; name: string }) {
  const [state, onSubmit, pending] = useActionForm(renameAccount.bind(null, workspaceId));
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex gap-2">
        <Input name="name" defaultValue={name} aria-label="Account name" required />
        <Button type="submit" variant="secondary" disabled={pending}>
          Save
        </Button>
      </div>
      <FormError message={state.error} />
      {state.ok && <p className="text-sm text-emerald-600">{state.message}</p>}
    </form>
  );
}

type Stage = { id: string; name: string };

export function PipelineEditor({
  workspaceId,
  pipeline,
  stages,
}: {
  workspaceId: string;
  pipeline: { id: string; name: string };
  stages: Stage[];
}) {
  const [renameState, onRename] = useActionForm(renamePipelineAction.bind(null, workspaceId, pipeline.id));
  const [addState, onAdd, adding] = useActionForm(addStageAction.bind(null, workspaceId, pipeline.id), {
    resetOnSuccess: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function move(index: number, delta: number) {
    const ids = stages.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    startTransition(() => reorderStagesAction(workspaceId, pipeline.id, ids));
  }

  return (
    <Card className="p-5">
      <form onSubmit={onRename} className="mb-4 flex gap-2">
        <Input name="name" defaultValue={pipeline.name} aria-label="Pipeline name" className="font-medium" />
        <Button type="submit" variant="secondary">
          Rename
        </Button>
      </form>
      <FormError message={renameState.error} />

      <ol className={`divide-y divide-slate-100 rounded-lg border border-slate-200 ${pending ? "opacity-60" : ""}`}>
        {stages.map((stage, i) => (
          <li key={stage.id} className="flex items-center gap-2 px-3 py-2">
            <span className="w-5 text-xs tabular-nums text-slate-400">{i + 1}</span>
            <input
              defaultValue={stage.name}
              aria-label={`Stage ${i + 1} name`}
              onBlur={(e) => e.target.value.trim() !== stage.name && startTransition(() => renameStageAction(workspaceId, stage.id, e.target.value))}
              className="min-w-0 flex-1 rounded px-1 py-1 text-sm hover:bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
            <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
              ↑
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
              ↓
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-slate-400 hover:text-red-600"
              onClick={() =>
                startTransition(async () => {
                  const res = await deleteStageAction(workspaceId, stage.id);
                  setError(res.error ?? null);
                })
              }
            >
              Delete
            </Button>
          </li>
        ))}
      </ol>
      <div className="mt-2">
        <FormError message={error} />
      </div>

      <form onSubmit={onAdd} className="mt-3 flex gap-2">
        <Input name="name" placeholder="New stage name" aria-label="New stage name" />
        <Button type="submit" variant="secondary" disabled={adding}>
          Add stage
        </Button>
      </form>
      <FormError message={addState.error} />
    </Card>
  );
}

export function NewPipelineForm({ workspaceId }: { workspaceId: string }) {
  const [state, onSubmit, pending] = useActionForm(createPipelineAction.bind(null, workspaceId));
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="Name" name="name">
        <Input id="name" name="name" placeholder="e.g. Recruiting" required />
      </Field>
      <Field label="Stages (one per line)" name="stages">
        <Textarea id="stages" name="stages" rows={5} defaultValue={DEFAULT_STAGES.join("\n")} />
      </Field>
      <FormError message={state.error} />
      <Button type="submit" disabled={pending}>
        Create pipeline
      </Button>
    </form>
  );
}

export function MessagingForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: {
    smsNumber: string;
    forwardCallsTo: string;
    missedCallTextEnabled: boolean;
    missedCallText: string;
    emailFromName: string;
    emailFromAddress: string;
    whatsappNumber: string;
    imessageNumber: string;
  };
}) {
  const [state, onSubmit, pending] = useActionForm(updateMessagingSettingsAction.bind(null, workspaceId));
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Texting number" name="smsNumber">
          <Input id="smsNumber" name="smsNumber" defaultValue={settings.smsNumber} placeholder="The Twilio number for this account" />
        </Field>
        <Field label="Forward calls to" name="forwardCallsTo">
          <Input id="forwardCallsTo" name="forwardCallsTo" defaultValue={settings.forwardCallsTo} placeholder="The business's real phone" />
        </Field>
        <Field label="WhatsApp number" name="whatsappNumber">
          <Input id="whatsappNumber" name="whatsappNumber" defaultValue={settings.whatsappNumber} placeholder="The approved WhatsApp sender in Twilio" />
        </Field>
        <Field label="iMessage number" name="imessageNumber">
          <Input id="imessageNumber" name="imessageNumber" defaultValue={settings.imessageNumber} placeholder="The Sendblue line for this account" />
        </Field>
        <Field label="Send emails from (name)" name="emailFromName">
          <Input id="emailFromName" name="emailFromName" defaultValue={settings.emailFromName} placeholder="e.g. Acme Plumbing" />
        </Field>
        <Field label="Send emails from (address)" name="emailFromAddress">
          <Input id="emailFromAddress" name="emailFromAddress" type="email" defaultValue={settings.emailFromAddress} placeholder="hello@acme.com" />
        </Field>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" name="missedCallTextEnabled" defaultChecked={settings.missedCallTextEnabled} className="h-4 w-4" />
          Text people back when you miss their call
        </label>
        <Textarea name="missedCallText" aria-label="Missed-call text" rows={2} defaultValue={settings.missedCallText} className="mt-2" />
      </div>
      <FormError message={state.error} />
      {state.ok && <p className="text-sm text-emerald-600">{state.message}</p>}
      <Button type="submit" variant="secondary" disabled={pending}>
        Save messaging
      </Button>
    </form>
  );
}

export function ClearCountsSetting({ workspaceId, clearPerItem }: { workspaceId: string; clearPerItem: boolean }) {
  const [on, setOn] = useState(clearPerItem);
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex gap-3">
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-4 w-4 accent-brand-600"
        checked={on}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          startTransition(() => setClearPerItemAction(workspaceId, next));
        }}
      />
      <span>
        <span className="block text-sm font-medium">Clear each red count when I open that item</span>
        <span className="block text-sm text-slate-500">
          {on
            ? "On: a new contact counts until you open their page, a booking until you open the person, a deal until you open its contact or move it, a form response until you open the form or the person, and a failed run until you open its workflow."
            : "Off: opening a tab clears its whole count."}{" "}
          Inbox clears as you read conversations and To-do as you check things off, either way.
        </span>
      </span>
    </label>
  );
}

export function LeadAlertsForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: { minutes: number | null; email: string; phone: string };
}) {
  const [on, setOn] = useState(settings.minutes !== null);
  const [state, onSubmit, pending] = useActionForm(saveLeadAlertsAction.bind(null, workspaceId));
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input type="checkbox" name="enabled" checked={on} onChange={(e) => setOn(e.target.checked)} className="h-4 w-4" />
        Alert me when a lead waits too long for a reply
      </label>
      {on && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="After (minutes)" name="minutes">
            <Input id="minutes" name="minutes" type="number" min={1} max={1440} defaultValue={settings.minutes ?? 15} />
          </Field>
          <Field label="Email the alert to" name="email">
            <Input id="email" name="email" type="email" defaultValue={settings.email} placeholder="you@agency.com" />
          </Field>
          <Field label="Text the alert to" name="phone">
            <Input id="phone" name="phone" defaultValue={settings.phone} placeholder="Your cell number" />
          </Field>
        </div>
      )}
      <FormError message={state.error} />
      {state.ok && <p className="text-sm text-emerald-600">{state.message}</p>}
      <Button type="submit" variant="secondary" disabled={pending}>
        Save alerts
      </Button>
    </form>
  );
}

export function AiSettingsForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: { provider: AiProvider; model: string; baseUrl: string; about: string; tagMessages: boolean; keyEnding: string | null } | null;
}) {
  const [provider, setProvider] = useState<AiProvider>(settings?.provider ?? "anthropic");
  const [model, setModel] = useState(settings?.model ?? AI_PROVIDERS[0].model);
  const [state, onSubmit, pending] = useActionForm(saveAiSettingsAction.bind(null, workspaceId));
  const [check, setCheck] = useState<ActionState>({});
  const [checking, startCheck] = useTransition();
  const info = AI_PROVIDERS.find((p) => p.id === provider)!;
  const savedKey = settings?.provider === provider ? settings.keyEnding : null;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="AI service" name="provider">
          <Select
            id="provider"
            name="provider"
            value={provider}
            onChange={(e) => {
              const next = e.target.value as AiProvider;
              setProvider(next);
              setModel(settings?.provider === next ? settings.model : (AI_PROVIDERS.find((p) => p.id === next)?.model ?? ""));
            }}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" name="model">
          <Input
            id="model"
            name="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider === "anthropic" ? "claude-opus-5-5" : "The model's exact name from the service"}
          />
        </Field>
        {provider === "openai_compatible" && (
          <Field label="API address" name="baseUrl">
            <Input id="baseUrl" name="baseUrl" defaultValue={settings?.baseUrl} placeholder="https://openrouter.ai/api/v1" />
          </Field>
        )}
        <Field label={savedKey !== null && savedKey !== undefined ? `API key (saved, ends in ${savedKey || "…"})` : "API key"} name="apiKey">
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={savedKey !== null && savedKey !== undefined ? "Leave blank to keep the saved key" : provider === "openai_compatible" ? "Leave blank if it needs none" : "Paste the key"}
          />
        </Field>
      </div>
      <p className="text-xs text-slate-500">{info.hint} The key is stored encrypted and never shown again.</p>
      <Field label="About the business, for drafting replies" name="about">
        <Textarea
          id="about"
          name="about"
          rows={4}
          defaultValue={settings?.about}
          placeholder="What you do, your hours, prices you're happy to quote, how you like to sound. e.g. Family dentist in Oakland. Open Mon–Fri 8–5. Cleanings $120 without insurance. Friendly, never pushy."
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="tagMessages" defaultChecked={settings?.tagMessages ?? true} className="mt-0.5 h-4 w-4" />
        <span>
          <span className="block font-medium text-slate-700">Tag what each incoming message is about</span>
          <span className="block text-slate-500">
            Like &ldquo;Wants to book&rdquo; or &ldquo;Asking about price&rdquo;. Shows in the Inbox, and workflows can start from a tag. Uses one small AI request per message.
          </span>
        </span>
      </label>
      <FormError message={state.error ?? check.error} />
      {(state.ok || check.ok) && <p className="text-sm text-emerald-600">{check.ok ? check.message : state.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={pending}>
          Save AI
        </Button>
        {settings && (
          <>
            <Button type="button" variant="ghost" disabled={checking} onClick={() => startCheck(async () => setCheck(await testAiAction(workspaceId)))}>
              {checking ? "Testing…" : "Test"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => startCheck(async () => setCheck(await removeAiSettingsAction(workspaceId)))}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
