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
import { renameAccount } from "@/actions/workspaces";
import { Button, Card, Field, FormError, Input, Textarea } from "@/components/ui";
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
