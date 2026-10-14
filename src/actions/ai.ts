"use server";

import { refresh } from "next/cache";
import { db } from "@/db";
import { requireWorkspace } from "@/lib/session";
import { AiError, draftReply, loadLlm, removeAiSettings, saveAiSettings, testAi } from "@/server/ai";
import type { ActionState } from "./types";

const CHANNELS = new Set(["sms", "imessage", "whatsapp", "email"] as const);

function failed(err: unknown): ActionState {
  if (err instanceof AiError) return { error: err.message };
  throw err;
}

export async function saveAiSettingsAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { role } = await requireWorkspace(workspaceId);
  if (role === "member") return { error: "Only owners and admins can connect an AI." };
  try {
    await saveAiSettings(db, workspaceId, {
      provider: String(form.get("provider") ?? ""),
      model: String(form.get("model") ?? ""),
      baseUrl: String(form.get("baseUrl") ?? ""),
      apiKey: String(form.get("apiKey") ?? ""),
      about: String(form.get("about") ?? ""),
      tagMessages: form.get("tagMessages") === "on",
    });
  } catch (err) {
    return failed(err);
  }
  refresh();
  return { ok: true, message: "Saved. Use Test to check it works." };
}

export async function removeAiSettingsAction(workspaceId: string): Promise<ActionState> {
  const { role } = await requireWorkspace(workspaceId);
  if (role === "member") return { error: "Only owners and admins can disconnect the AI." };
  await removeAiSettings(db, workspaceId);
  refresh();
  return { ok: true, message: "Disconnected." };
}

export async function testAiAction(workspaceId: string): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    const llm = await loadLlm(db, workspaceId);
    if (!llm) return { error: "Save the AI settings first." };
    await testAi(llm);
    return { ok: true, message: "It works." };
  } catch (err) {
    return failed(err);
  }
}

/** A draft for the person to edit and send. Nothing is sent. */
export async function draftReplyAction(workspaceId: string, contactId: string, channel: string): Promise<{ draft?: string; error?: string }> {
  await requireWorkspace(workspaceId);
  if (!CHANNELS.has(channel as never)) return { error: "Pick how to send it." };
  try {
    const llm = await loadLlm(db, workspaceId);
    if (!llm) return { error: "Connect an AI in Settings first." };
    return { draft: await draftReply(db, workspaceId, contactId, channel as "sms", llm) };
  } catch (err) {
    if (err instanceof AiError) return { error: err.message };
    throw err;
  }
}
