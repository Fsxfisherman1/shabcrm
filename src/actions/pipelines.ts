"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { parseMoneyToCents } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { markItemsSeen } from "@/server/badges";
import {
  addStage,
  createDeal,
  createPipeline,
  deleteDeal,
  deleteStage,
  moveDeal,
  renamePipeline,
  renameStage,
  reorderStages,
  StageNotEmptyError,
  updateDeal,
} from "@/server/pipelines";
import type { ActionState } from "./types";

export async function createDealAction(
  workspaceId: string,
  pipelineId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { user } = await requireWorkspace(workspaceId);
  const title = String(form.get("title") ?? "").trim();
  const stageId = String(form.get("stageId") ?? "");
  if (!title) return { error: "Give the deal a name." };
  if (!stageId) return { error: "Pick a stage." };
  await createDeal(
    db,
    workspaceId,
    {
      pipelineId,
      stageId,
      title,
      valueCents: parseMoneyToCents(String(form.get("value") ?? "")),
      contactId: String(form.get("contactId") ?? "") || null,
    },
    user.id,
  );
  refresh();
  return { ok: true };
}

export async function moveDealAction(workspaceId: string, dealId: string, stageId: string, index: number) {
  const { user } = await requireWorkspace(workspaceId);
  await moveDeal(db, workspaceId, dealId, stageId, index, user.id);
  await markItemsSeen(db, user.id, workspaceId, "deal", [dealId]);
  refresh();
}

export async function setDealStatusAction(workspaceId: string, dealId: string, status: "open" | "won" | "lost") {
  const { user } = await requireWorkspace(workspaceId);
  await updateDeal(db, workspaceId, dealId, { status });
  await markItemsSeen(db, user.id, workspaceId, "deal", [dealId]);
  refresh();
}

export async function deleteDealAction(workspaceId: string, dealId: string) {
  await requireWorkspace(workspaceId);
  await deleteDeal(db, workspaceId, dealId);
  refresh();
}

export async function createPipelineAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Give the pipeline a name." };
  const stages = String(form.get("stages") ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!stages.length) return { error: "Add at least one stage." };
  const pipeline = await createPipeline(db, workspaceId, name, stages);
  redirect(`/w/${workspaceId}/pipeline?p=${pipeline.id}`);
}

export async function renamePipelineAction(workspaceId: string, pipelineId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name can't be blank." };
  await renamePipeline(db, workspaceId, pipelineId, name);
  refresh();
  return { ok: true };
}

export async function addStageAction(workspaceId: string, pipelineId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the stage." };
  await addStage(db, workspaceId, pipelineId, name);
  refresh();
  return { ok: true };
}

export async function renameStageAction(workspaceId: string, stageId: string, name: string) {
  await requireWorkspace(workspaceId);
  if (!name.trim()) return;
  await renameStage(db, workspaceId, stageId, name);
  refresh();
}

export async function reorderStagesAction(workspaceId: string, pipelineId: string, stageIds: string[]) {
  await requireWorkspace(workspaceId);
  await reorderStages(db, workspaceId, pipelineId, stageIds);
  refresh();
}

export async function deleteStageAction(workspaceId: string, stageId: string): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await deleteStage(db, workspaceId, stageId);
  } catch (err) {
    if (err instanceof StageNotEmptyError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true };
}
