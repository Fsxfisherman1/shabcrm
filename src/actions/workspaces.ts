"use server";

import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { getCurrentUser, requireWorkspace } from "@/lib/session";
import { setClearPerItem } from "@/server/badges";
import { createWorkspace, renameWorkspace } from "@/server/workspaces";
import type { ActionState } from "./types";

const name = z.string().trim().min(1, "Enter a name.").max(120);

export async function createClientAccount(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  const parsed = name.safeParse(form.get("name"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const ws = await createWorkspace(db, { name: parsed.data, kind: "client", ownerId: user.id });
  revalidatePath("/", "layout"); // the sidebar's account list
  redirect(`/w/${ws.id}`);
}

export async function renameAccount(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { role } = await requireWorkspace(workspaceId);
  if (role === "member") return { error: "Only owners and admins can rename an account." };
  const parsed = name.safeParse(form.get("name"));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  await renameWorkspace(db, workspaceId, parsed.data);
  revalidatePath("/", "layout"); // the sidebar's account list
  return { ok: true, message: "Saved." };
}

/** A personal setting: whether red counts clear item by item or when the tab is opened. */
export async function setClearPerItemAction(workspaceId: string, on: boolean) {
  const { user } = await requireWorkspace(workspaceId);
  await setClearPerItem(db, user.id, on);
  refresh();
}
