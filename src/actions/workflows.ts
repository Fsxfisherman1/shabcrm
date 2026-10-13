"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { db } from "@/db";
import { requireWorkspace } from "@/lib/session";
import {
  createWorkflow,
  deleteWorkflow,
  enrollByHand,
  saveWorkflow,
  setWorkflowEnabled,
  WorkflowError,
  type WorkflowInput,
} from "@/server/workflows";
import { stopAllRuns } from "@/server/workflows/engine";
import { TEMPLATES } from "@/server/workflows/templates";
import type { ActionState } from "./types";

function failed(err: unknown): ActionState {
  if (err instanceof WorkflowError) return { error: err.message };
  throw err;
}

export async function createWorkflowAction(workspaceId: string, templateKey: string) {
  const { user } = await requireWorkspace(workspaceId);
  const template = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0];
  const wf = await createWorkflow(
    db,
    workspaceId,
    { name: template.key === "blank" ? "New workflow" : template.name, trigger: template.trigger, steps: template.steps },
    user.id,
  );
  redirect(`/w/${workspaceId}/automations/${wf.id}`);
}

export async function saveWorkflowAction(workspaceId: string, workflowId: string, input: WorkflowInput): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await saveWorkflow(db, workspaceId, workflowId, input);
  } catch (err) {
    return failed(err);
  }
  refresh();
  return { ok: true, message: input.enabled ? "Saved. It's on." : "Saved. It's off until you turn it on." };
}

export async function setWorkflowEnabledAction(workspaceId: string, workflowId: string, enabled: boolean): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await setWorkflowEnabled(db, workspaceId, workflowId, enabled);
  } catch (err) {
    return failed(err);
  }
  refresh();
  return { ok: true };
}

export async function deleteWorkflowAction(workspaceId: string, workflowId: string) {
  await requireWorkspace(workspaceId);
  await deleteWorkflow(db, workspaceId, workflowId);
  redirect(`/w/${workspaceId}/automations`);
}

export async function enrollAction(workspaceId: string, workflowId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const contactId = String(form.get("contactId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) return { error: "Pick a contact." };
  try {
    await enrollByHand(db, workspaceId, workflowId, contactId);
  } catch (err) {
    return failed(err);
  }
  refresh();
  return { ok: true, message: "Added. Their first steps run within a few seconds. See History." };
}

export async function stopAllRunsAction(workspaceId: string, workflowId: string): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const n = await stopAllRuns(db, workspaceId, workflowId);
  refresh();
  return { ok: true, message: n ? `Stopped ${n} ${n === 1 ? "contact" : "contacts"}.` : "Nobody was in progress." };
}
