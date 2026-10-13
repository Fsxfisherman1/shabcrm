"use client";

import clsx from "clsx";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { WorkflowCondition, WorkflowStep, WorkflowTrigger } from "@/db/schema";
import { deleteWorkflowAction, enrollAction, saveWorkflowAction, stopAllRunsAction } from "@/actions/workflows";
import { Button, Card, FormError, Input, Label, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";
import {
  blankStep,
  blankTrigger,
  CONDITION_LABEL,
  MERGE_FIELDS,
  STEP_GROUPS,
  STEP_LABEL,
  STEP_TONE,
  stepTitle,
  summarizeStep,
  summarizeTrigger,
  TRIGGER_HELP,
  TRIGGER_LABEL,
  type StepTone,
  type StepType,
} from "@/lib/workflows";

type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };
type State = {
  name: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  stopOnReply: boolean;
  allowReentry: boolean;
};
type Branch = "then" | "else";
/** Where a new step goes: a branch of an if step (or the top level when ifId is null), at an index. */
type Slot = { ifId: string | null; branch: Branch; index: number };

// ---------------------------------------------------------------------------
// Editing the step tree
// ---------------------------------------------------------------------------

function mapTree(steps: WorkflowStep[], fn: (list: WorkflowStep[], ifId: string | null, branch: Branch) => WorkflowStep[], ifId: string | null = null, branch: Branch = "then"): WorkflowStep[] {
  return fn(steps, ifId, branch).map((s) => (s.type === "if" ? { ...s, then: mapTree(s.then, fn, s.id, "then"), else: mapTree(s.else, fn, s.id, "else") } : s));
}

const insertAt = (steps: WorkflowStep[], slot: Slot, step: WorkflowStep) =>
  mapTree(steps, (list, ifId, branch) => (ifId === slot.ifId && (ifId === null || branch === slot.branch) ? [...list.slice(0, slot.index), step, ...list.slice(slot.index)] : list));

const removeStep = (steps: WorkflowStep[], id: string) => mapTree(steps, (list) => list.filter((s) => s.id !== id));

const replaceStep = (steps: WorkflowStep[], step: WorkflowStep) => mapTree(steps, (list) => list.map((s) => (s.id === step.id ? (s.type === "if" && step.type === "if" ? { ...step, then: s.then, else: s.else } : step) : s)));

function moveStep(steps: WorkflowStep[], id: string, by: -1 | 1) {
  return mapTree(steps, (list) => {
    const i = list.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const copy = [...list];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });
}

function findStep(steps: WorkflowStep[], id: string): WorkflowStep | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === "if") {
      const found = findStep(s.then, id) ?? findStep(s.else, id);
      if (found) return found;
    }
  }
  return null;
}

/** What's still missing from a step, so it can be flagged before saving. */
function problem(step: WorkflowStep): string | null {
  switch (step.type) {
    case "send_sms":
      return step.body.trim() ? null : "Write the text.";
    case "send_email":
      return !step.subject.trim() ? "Add a subject." : !step.body.trim() ? "Write the email." : null;
    case "notify":
      return !step.to.trim() ? "Say who to notify." : !step.message.trim() ? "Write the message." : null;
    case "add_tag":
    case "remove_tag":
      return step.tag.trim() ? null : "Choose a tag.";
    case "add_note":
      return step.body.trim() ? null : "Write the note.";
    case "create_deal":
      return !step.stageId ? "Pick a stage." : !step.title.trim() ? "Name the deal." : null;
    case "move_deal":
      return step.stageId ? null : "Pick a stage.";
    case "create_todo":
      return step.title.trim() ? null : "Write the to-do.";
    case "webhook":
      return /^https:\/\/\S+$/.test(step.url) ? null : "Paste an address starting with https://.";
    case "if":
      return step.condition.type === "has_tag" && !step.condition.tag.trim() ? "Choose a tag." : null;
    default:
      return null;
  }
}

function triggerProblem(t: WorkflowTrigger): string | null {
  if (t.type === "tag_added" && !t.tag.trim()) return "Choose a tag.";
  if (t.type === "deal_stage_changed" && !t.stageId) return "Pick a stage.";
  if (t.type === "form_submitted" && !t.formId) return "Pick a form.";
  return null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function Builder({
  workspaceId,
  workflow,
  hookUrl,
  pipelines,
  forms,
  tags,
  contacts,
  runCount,
  inProgress,
  history,
}: {
  workspaceId: string;
  workflow: State & { id: string };
  hookUrl: string;
  pipelines: Pipeline[];
  forms: { id: string; name: string }[];
  tags: string[];
  contacts: { id: string; name: string }[];
  runCount: number;
  inProgress: number;
  history: ReactNode;
}) {
  const { id, ...initial } = workflow;
  const [state, setState] = useState<State>(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [selected, setSelected] = useState<string>("trigger");
  const [inserting, setInserting] = useState<Slot | null>(null);
  const [tab, setTab] = useState<"builder" | "history" | "settings">("builder");
  const [notice, setNotice] = useState<{ error?: string | null; message?: string | null }>({});
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(state) !== saved;

  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, label: pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name, pipelineId: p.id })));
  const stageName = (stageId: string) => stages.find((s) => s.id === stageId)?.label;
  const formName = (formId: string) => forms.find((f) => f.id === formId)?.name;
  const firstStage = pipelines[0]?.stages[0];

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function save(next: State, after?: () => void) {
    startTransition(async () => {
      const result = await saveWorkflowAction(workspaceId, id, next);
      setNotice(result);
      if (result.ok) {
        setSaved(JSON.stringify(next));
        after?.();
      } else if (next.enabled !== state.enabled) {
        setState((s) => ({ ...s, enabled: !next.enabled }));
      }
    });
  }

  const update = (patch: Partial<State>) => {
    setNotice({});
    setState((s) => ({ ...s, ...patch }));
  };
  const setSteps = (fn: (steps: WorkflowStep[]) => WorkflowStep[]) => update({ steps: fn(state.steps) });

  function add(type: StepType) {
    if (!inserting) return;
    const step = blankStep(type, { pipelineId: firstStage ? pipelines[0].id : undefined, stageId: firstStage?.id });
    setSteps((steps) => insertAt(steps, inserting, step));
    setInserting(null);
    select(step.id);
  }

  const selectedStep = selected === "trigger" ? null : findStep(state.steps, selected);

  // On narrow screens the flow scrolls sideways; start it centered on the trigger.
  const canvas = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [tab]);
  function select(stepId: string) {
    setSelected(stepId);
    // The editor sits under the flow on phones; bring it into view.
    if (window.innerWidth < 1024) requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/automations`} className="text-sm text-slate-500 hover:text-slate-800">
          Automations /
        </Link>
        <input
          aria-label="Workflow name"
          value={state.name}
          onChange={(e) => update({ name: e.target.value })}
          className="min-w-48 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-tight hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label="Turn workflow on"
            disabled={pending}
            onClick={() => {
              const next = { ...state, enabled: !state.enabled };
              setState(next);
              save(next);
            }}
            className={clsx("relative h-6 w-11 rounded-full transition-colors", state.enabled ? "bg-emerald-500" : "bg-slate-300")}
          >
            <span className={clsx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", state.enabled ? "left-[22px]" : "left-0.5")} />
          </button>
          {state.enabled ? "On" : "Off"}
        </label>
        <Button variant="secondary" onClick={() => setTab("settings")}>
          Test with a contact
        </Button>
        <Button onClick={() => save(state)} disabled={pending || !dirty}>
          {pending ? "Saving…" : dirty ? "Save" : "Saved"}
        </Button>
      </div>

      {notice.error && <FormError message={notice.error} />}
      {notice.message && !dirty && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice.message}</p>}

      <div className="flex gap-1 border-b border-slate-200 text-sm" role="tablist">
        {(
          [
            ["builder", "Builder"],
            ["history", `History (${runCount}${runCount >= 50 ? "+" : ""})`],
            ["settings", "Settings"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx("-mb-px border-b-2 px-3 py-2 font-medium", tab === key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "builder" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div ref={canvas} className="min-w-0 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 [background-image:radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:18px_18px]">
            <div className="mx-auto flex w-max min-w-full flex-col items-center">
              <StepCard
                tone="trigger"
                label="Trigger"
                title={TRIGGER_LABEL[state.trigger.type]}
                summary={summarizeTrigger(state.trigger, stageName, formName)}
                selected={selected === "trigger"}
                warning={triggerProblem(state.trigger)}
                onClick={() => select("trigger")}
              />
              <StepList
                steps={state.steps}
                ifId={null}
                branch="then"
                selected={selected}
                inserting={inserting}
                stageName={stageName}
                onSelect={select}
                onInsert={setInserting}
                onAdd={add}
              />
            </div>
          </div>

          <aside ref={panel} className="scroll-mt-4 lg:sticky lg:top-4 lg:self-start">
            <Card className="p-5">
              {selected === "trigger" || !selectedStep ? (
                <TriggerEditor trigger={state.trigger} onChange={(trigger) => update({ trigger })} stages={stages} forms={forms} tags={tags} hookUrl={hookUrl} />
              ) : (
                <StepEditor
                  key={selectedStep.id}
                  step={selectedStep}
                  pipelines={pipelines}
                  stages={stages}
                  tags={tags}
                  onChange={(step) => setSteps((steps) => replaceStep(steps, step))}
                  onMove={(by) => setSteps((steps) => moveStep(steps, selectedStep.id, by))}
                  onDelete={() => {
                    setSteps((steps) => removeStep(steps, selectedStep.id));
                    setSelected("trigger");
                  }}
                />
              )}
            </Card>
          </aside>
        </div>
      )}

      {tab === "history" && history}

      {tab === "settings" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Rules</h2>
            <Check
              checked={state.stopOnReply}
              onChange={(v) => update({ stopOnReply: v })}
              label="Stop when the contact replies"
              hint="If they text or email back, they leave this workflow so you can take over."
            />
            <Check
              checked={state.allowReentry}
              onChange={(v) => update({ allowReentry: v })}
              label="Let a contact go through more than once"
              hint="Off means each contact only ever goes through once. Turn on for things like appointment reminders."
            />
            <p className="text-xs text-slate-500">Changes here are saved with the Save button above.</p>
          </Card>

          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Test with a contact</h2>
            <p className="text-sm text-slate-500">Puts one contact through the saved workflow now, even while it&apos;s off. Texts and emails are really sent if your accounts are connected.</p>
            {dirty && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Save your changes first, so the test uses them.</p>}
            <EnrollForm workspaceId={workspaceId} workflowId={id} contacts={contacts} />
          </Card>

          <Card className="space-y-3 p-5 lg:col-span-2">
            <h2 className="font-semibold">Danger zone</h2>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                label={`Stop everyone in progress (${inProgress})`}
                confirm="Stop all of them?"
                disabled={inProgress === 0}
                onConfirm={() => startTransition(async () => setNotice(await stopAllRunsAction(workspaceId, id)))}
              />
              <ConfirmButton label="Delete workflow" confirm="Delete it and its history?" onConfirm={() => startTransition(() => deleteWorkflowAction(workspaceId, id))} />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const TONE: Record<StepTone | "trigger", { card: string; icon: string }> = {
  trigger: { card: "border-brand-200", icon: "bg-brand-600 text-white" },
  msg: { card: "border-slate-200", icon: "bg-sky-100 text-sky-700" },
  wait: { card: "border-slate-200", icon: "bg-amber-100 text-amber-700" },
  do: { card: "border-slate-200", icon: "bg-emerald-100 text-emerald-700" },
  if: { card: "border-slate-200", icon: "bg-violet-100 text-violet-700" },
};

const ICON: Record<StepTone | "trigger", ReactNode> = {
  trigger: <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" fill="currentColor" />,
  msg: <path d="M2 3h12v8H6l-3 3v-3H2z" fill="currentColor" />,
  wait: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" />
    </g>
  ),
  do: <path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />,
  if: <path d="M8 2v5M8 7 4 12M8 7l4 5" fill="none" stroke="currentColor" strokeWidth="1.8" />,
};

function StepCard({
  tone,
  label,
  title,
  summary,
  selected,
  warning,
  onClick,
}: {
  tone: StepTone | "trigger";
  label?: string;
  title: string;
  summary: string;
  selected: boolean;
  warning?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-72 items-start gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition-shadow hover:shadow-md",
        TONE[tone].card,
        selected && "ring-2 ring-brand-500",
        warning && "border-amber-300",
      )}
    >
      <span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", TONE[tone].icon)}>
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
          {ICON[tone]}
        </svg>
      </span>
      <span className="min-w-0">
        {label && <span className="block text-[11px] font-semibold uppercase tracking-wide text-brand-700">{label}</span>}
        <span className="block font-medium">{title}</span>
        <span className={clsx("block truncate text-sm", warning ? "text-amber-700" : "text-slate-500")}>{warning ?? summary}</span>
      </span>
    </button>
  );
}

const Wire = () => <div className="h-4 w-px bg-slate-300" />;

function StepList({
  steps,
  ifId,
  branch,
  selected,
  inserting,
  stageName,
  onSelect,
  onInsert,
  onAdd,
}: {
  steps: WorkflowStep[];
  ifId: string | null;
  branch: Branch;
  selected: string;
  inserting: Slot | null;
  stageName: (id: string) => string | undefined;
  onSelect: (id: string) => void;
  onInsert: (slot: Slot | null) => void;
  onAdd: (type: StepType) => void;
}) {
  const slotOpen = (index: number) => inserting?.ifId === ifId && inserting.branch === branch && inserting.index === index;
  const plus = (index: number) => (
    <>
      <Wire />
      <button
        type="button"
        aria-label="Add a step"
        onClick={() => onInsert(slotOpen(index) ? null : { ifId, branch, index })}
        className={clsx(
          "flex h-7 w-7 items-center justify-center rounded-full border text-base leading-none transition-colors",
          slotOpen(index) ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-500 hover:border-brand-500 hover:text-brand-700",
        )}
      >
        +
      </button>
      {slotOpen(index) && <AddMenu onAdd={onAdd} onClose={() => onInsert(null)} />}
      <Wire />
    </>
  );

  return (
    <>
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          {plus(i)}
          <StepCard
            tone={STEP_TONE[step.type]}
            title={stepTitle(step)}
            summary={summarizeStep(step, stageName)}
            selected={selected === step.id}
            warning={problem(step)}
            onClick={() => onSelect(step.id)}
          />
          {step.type === "if" && (
            <div className="mt-4 flex items-start gap-6 border-t border-slate-300 pt-0">
              {(["then", "else"] as const).map((b) => (
                <div key={b} className="flex flex-col items-center">
                  <Wire />
                  <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", b === "then" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800")}>
                    {b === "then" ? "Yes" : "No"}
                  </span>
                  <StepList
                    steps={step[b]}
                    ifId={step.id}
                    branch={b}
                    selected={selected}
                    inserting={inserting}
                    stageName={stageName}
                    onSelect={onSelect}
                    onInsert={onInsert}
                    onAdd={onAdd}
                  />
                </div>
              ))}
            </div>
          )}
        </Fragment>
      ))}
      {plus(steps.length)}
      <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">{ifId ? "Then continue" : "End"}</span>
    </>
  );
}

function AddMenu({ onAdd, onClose }: { onAdd: (type: StepType) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div ref={ref} className="mt-2 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-lg" role="menu">
      {STEP_GROUPS.map((g) => (
        <div key={g.label} className="py-1">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g.label}</div>
          {g.types.map((t) => (
            <button key={t} role="menuitem" type="button" onClick={() => onAdd(t)} className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-brand-50 hover:text-brand-800">
              {STEP_LABEL[t]}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function TriggerEditor({
  trigger,
  onChange,
  stages,
  forms,
  tags,
  hookUrl,
}: {
  trigger: WorkflowTrigger;
  onChange: (t: WorkflowTrigger) => void;
  stages: { id: string; label: string }[];
  forms: { id: string; name: string }[];
  tags: string[];
  hookUrl: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Trigger</div>
        <h2 className="font-semibold">Start this workflow when…</h2>
      </div>
      <div>
        <Label htmlFor="trigger-type">Event</Label>
        <Select id="trigger-type" value={trigger.type} onChange={(e) => onChange(blankTrigger(e.target.value as WorkflowTrigger["type"], { stageId: stages[0]?.id, formId: forms[0]?.id }))}>
          {(Object.keys(TRIGGER_LABEL) as WorkflowTrigger["type"][]).map((t) => (
            <option key={t} value={t}>
              {TRIGGER_LABEL[t]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-slate-500">{TRIGGER_HELP[trigger.type]}</p>
      </div>
      {trigger.type === "tag_added" && <TagInput id="trigger-tag" value={trigger.tag} tags={tags} onChange={(tag) => onChange({ ...trigger, tag })} />}
      {trigger.type === "sms_received" && (
        <div>
          <Label htmlFor="trigger-keyword">Only if the text contains (optional)</Label>
          <Input id="trigger-keyword" value={trigger.keyword ?? ""} placeholder="e.g. QUOTE" onChange={(e) => onChange({ ...trigger, keyword: e.target.value })} />
        </div>
      )}
      {trigger.type === "form_submitted" &&
        (forms.length ? (
          <div>
            <Label htmlFor="trigger-form">Form</Label>
            <Select id="trigger-form" value={trigger.formId} onChange={(e) => onChange({ ...trigger, formId: e.target.value })}>
              {!trigger.formId && <option value="">Pick a form</option>}
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              Answers to your own questions can go in messages, like <code>{"{{data.how_can_we_help}}"}</code>.
            </p>
          </div>
        ) : (
          <p className="text-sm text-amber-700">Make a form on the Forms tab first.</p>
        ))}
      {trigger.type === "deal_stage_changed" && <StagePicker id="trigger-stage" value={trigger.stageId} stages={stages} onChange={(stageId) => onChange({ ...trigger, stageId })} />}
      {trigger.type === "deal_status_changed" && (
        <div>
          <Label htmlFor="trigger-status">Marked as</Label>
          <Select id="trigger-status" value={trigger.status} onChange={(e) => onChange({ ...trigger, status: e.target.value as "won" | "lost" })}>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </Select>
        </div>
      )}
      {trigger.type === "webhook" && (
        <div className="space-y-2 text-sm">
          <Label>Send leads to this address</Label>
          <code className="block break-all rounded-lg bg-slate-100 p-2 text-xs">{hookUrl}</code>
          <p className="text-xs text-slate-500">
            Paste it into your website form, Zapier or Make as a POST &ldquo;webhook&rdquo;. Include an <b>email</b> or <b>phone</b>, and optionally <b>name</b>. Anything else you send can be used in messages as{" "}
            <code>{"{{data.field_name}}"}</code>. Keep the address private. The workflow must be on to accept leads.
          </p>
        </div>
      )}
    </div>
  );
}

function StepEditor({
  step,
  pipelines,
  stages,
  tags,
  onChange,
  onMove,
  onDelete,
}: {
  step: WorkflowStep;
  pipelines: Pipeline[];
  stages: { id: string; label: string; pipelineId: string }[];
  tags: string[];
  onChange: (s: WorkflowStep) => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{STEP_LABEL[step.type]}</h2>
        <div className="flex gap-1">
          <IconButton label="Move up" onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label="Move down" onClick={() => onMove(1)}>
            ↓
          </IconButton>
        </div>
      </div>

      {step.type === "send_sms" && (
        <>
          <TemplateField id="sms-body" label="Text" rows={5} value={step.body} onChange={(body) => onChange({ ...step, body })} />
          <p className="text-xs text-slate-500">Only sent to contacts who agreed to texts, or who texted or called you in the last 24 hours. Others are skipped.</p>
        </>
      )}
      {step.type === "send_email" && (
        <>
          <TemplateField id="email-subject" label="Subject" value={step.subject} onChange={(subject) => onChange({ ...step, subject })} single />
          <TemplateField id="email-body" label="Email" rows={8} value={step.body} onChange={(body) => onChange({ ...step, body })} />
        </>
      )}
      {step.type === "notify" && (
        <>
          <div>
            <Label htmlFor="notify-channel">How</Label>
            <Select id="notify-channel" value={step.channel} onChange={(e) => onChange({ ...step, channel: e.target.value as "email" | "sms" })}>
              <option value="email">Email</option>
              <option value="sms">Text</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="notify-to">{step.channel === "email" ? "Your email" : "Your phone"}</Label>
            <Input id="notify-to" value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value })} placeholder={step.channel === "email" ? "you@example.com" : "(555) 555-1234"} />
          </div>
          <TemplateField id="notify-message" label="Message" rows={3} value={step.message} onChange={(message) => onChange({ ...step, message })} />
        </>
      )}
      {step.type === "wait" && (
        <div className="flex items-end gap-2">
          <div className="w-24">
            <Label htmlFor="wait-amount">Wait</Label>
            <Input id="wait-amount" type="number" min={1} max={365} value={step.amount} onChange={(e) => onChange({ ...step, amount: Math.max(1, Math.min(365, Math.round(Number(e.target.value)) || 1)) })} />
          </div>
          <div className="w-32">
            <Select aria-label="Unit" value={step.unit} onChange={(e) => onChange({ ...step, unit: e.target.value as "minutes" | "hours" | "days" })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
          </div>
        </div>
      )}
      {step.type === "wait_until_appointment" && (
        <div>
          <Label htmlFor="appt-hours">Hours before the appointment</Label>
          <div className="w-28">
            <Input id="appt-hours" type="number" min={0} max={720} value={step.hoursBefore} onChange={(e) => onChange({ ...step, hoursBefore: Math.max(0, Math.min(720, Number(e.target.value) || 0)) })} />
          </div>
          <p className="mt-1 text-xs text-slate-500">If there&apos;s no upcoming appointment, or it&apos;s sooner than this, the workflow carries straight on.</p>
        </div>
      )}
      {(step.type === "add_tag" || step.type === "remove_tag") && <TagInput id="step-tag" value={step.tag} tags={tags} onChange={(tag) => onChange({ ...step, tag })} />}
      {step.type === "add_note" && <TemplateField id="note-body" label="Note" rows={4} value={step.body} onChange={(body) => onChange({ ...step, body })} />}
      {step.type === "create_deal" && (
        <>
          <TemplateField id="deal-title" label="Deal name" value={step.title} onChange={(title) => onChange({ ...step, title })} single />
          <StagePicker
            id="deal-stage"
            value={step.stageId}
            stages={stages}
            onChange={(stageId) => onChange({ ...step, stageId, pipelineId: stages.find((s) => s.id === stageId)?.pipelineId ?? step.pipelineId })}
          />
          <div className="w-36">
            <Label htmlFor="deal-value">Value ($)</Label>
            <Input id="deal-value" type="number" min={0} value={step.value} onChange={(e) => onChange({ ...step, value: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
          {pipelines.length === 0 && <p className="text-xs text-amber-700">Create a pipeline first.</p>}
        </>
      )}
      {step.type === "move_deal" && (
        <>
          <StagePicker id="move-stage" value={step.stageId} stages={stages} onChange={(stageId) => onChange({ ...step, stageId })} />
          <p className="text-xs text-slate-500">Moves the contact&apos;s most recent open deal in that pipeline.</p>
        </>
      )}
      {step.type === "create_todo" && (
        <>
          <TemplateField id="todo-title" label="To-do" value={step.title} onChange={(title) => onChange({ ...step, title })} single />
          <div className="w-36">
            <Label htmlFor="todo-due">Due in (days)</Label>
            <Input id="todo-due" type="number" min={0} max={365} value={step.dueInDays} onChange={(e) => onChange({ ...step, dueInDays: Math.max(0, Math.min(365, Math.round(Number(e.target.value)) || 0)) })} />
          </div>
          <p className="text-xs text-slate-500">Lands on your To-do tab. 0 means due today.</p>
        </>
      )}
      {step.type === "webhook" && (
        <>
          <div>
            <Label htmlFor="webhook-url">Address</Label>
            <Input id="webhook-url" value={step.url} placeholder="https://hooks.zapier.com/…" onChange={(e) => onChange({ ...step, url: e.target.value.trim() })} />
          </div>
          <p className="text-xs text-slate-500">Sends the contact&apos;s details to another app (Zapier, Make, n8n…) as JSON.</p>
        </>
      )}
      {step.type === "if" && <ConditionEditor condition={step.condition} tags={tags} onChange={(condition) => onChange({ ...step, condition })} />}

      <div className="border-t border-slate-100 pt-3">
        {confirming ? (
          <div className="flex items-center gap-2 text-sm">
            <span>{step.type === "if" ? "Delete it and both branches?" : "Delete this step?"}</span>
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            Delete step
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionEditor({ condition, tags, onChange }: { condition: WorkflowCondition; tags: string[]; onChange: (c: WorkflowCondition) => void }) {
  return (
    <>
      <div>
        <Label htmlFor="condition-type">Check whether the contact…</Label>
        <Select
          id="condition-type"
          value={condition.type}
          onChange={(e) => {
            const type = e.target.value as WorkflowCondition["type"];
            onChange(type === "has_tag" ? { type, tag: "" } : { type });
          }}
        >
          {(Object.keys(CONDITION_LABEL) as WorkflowCondition["type"][]).map((t) => (
            <option key={t} value={t}>
              {CONDITION_LABEL[t]}
            </option>
          ))}
        </Select>
      </div>
      {condition.type === "has_tag" && <TagInput id="condition-tag" value={condition.tag} tags={tags} onChange={(tag) => onChange({ ...condition, tag })} />}
      <p className="text-xs text-slate-500">Contacts who match follow the Yes path; everyone else follows No. Both paths then carry on with the steps after.</p>
    </>
  );
}

function TagInput({ id, value, tags, onChange }: { id: string; value: string; tags: string[]; onChange: (tag: string) => void }) {
  return (
    <div>
      <Label htmlFor={id}>Tag</Label>
      <Input id={id} list={`${id}-list`} value={value} placeholder="e.g. vip" onChange={(e) => onChange(e.target.value.toLowerCase())} />
      <datalist id={`${id}-list`}>
        {tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

function StagePicker({ id, value, stages, onChange }: { id: string; value: string; stages: { id: string; label: string }[]; onChange: (id: string) => void }) {
  return (
    <div>
      <Label htmlFor={id}>Stage</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {!value && <option value="">Pick a stage</option>}
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** A text box with buttons that insert {{merge fields}} where the cursor is. */
function TemplateField({ id, label, value, onChange, rows = 3, single }: { id: string; label: string; value: string; onChange: (v: string) => void; rows?: number; single?: boolean }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  function insert(key: string) {
    const el = ref.current;
    const token = `{{${key}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen((o) => !o)}>
          {"{{ }}"} Insert field
        </button>
      </div>
      {open && (
        <div className="mb-2 flex flex-wrap gap-1">
          {MERGE_FIELDS.map((f) => (
            <button key={f.key} type="button" onClick={() => insert(f.key)} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs hover:border-brand-500 hover:bg-brand-50">
              {f.label}
            </button>
          ))}
        </div>
      )}
      {single ? (
        <Input id={id} ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Textarea id={id} ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {!single && <p className="mt-1 text-xs text-slate-500">Tip: {"{{first_name|there}}"} uses &ldquo;there&rdquo; when the name is missing.</p>}
    </div>
  );
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
      {children}
    </button>
  );
}

function ConfirmButton({ label, confirm, onConfirm, disabled }: { label: string; confirm: string; onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant="danger" size="sm" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span className="flex items-center gap-2 text-sm">
      {confirm}
      <Button
        variant="danger"
        size="sm"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

function EnrollForm({ workspaceId, workflowId, contacts }: { workspaceId: string; workflowId: string; contacts: { id: string; name: string }[] }) {
  const [state, onSubmit, pending] = useActionForm(enrollAction.bind(null, workspaceId, workflowId));
  if (!contacts.length) return <p className="text-sm text-slate-500">Add a contact first.</p>;
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2">
        <Select name="contactId" aria-label="Contact" defaultValue="" className="flex-1">
          <option value="" disabled>
            Pick a contact
          </option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </div>
      <FormError message={state.error} />
      {state.message && <p className="text-sm text-emerald-700">{state.message}</p>}
    </form>
  );
}
