"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { db } from "@/db";
import { requireWorkspace } from "@/lib/session";
import { createForm, deleteForm, FormError, saveForm, saveWebsiteForm, submitForm, type FormInput } from "@/server/forms";
import type { ActionState } from "./types";

export async function createFormAction(workspaceId: string) {
  await requireWorkspace(workspaceId);
  const form = await createForm(db, workspaceId, "Contact form");
  redirect(`/w/${workspaceId}/forms/${form.id}`);
}

export async function saveFormAction(workspaceId: string, formId: string, input: FormInput): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await saveForm(db, workspaceId, formId, input);
  } catch (err) {
    if (err instanceof FormError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function saveWebsiteFormAction(workspaceId: string, formId: string, input: { name: string; enabled: boolean; tags: string }): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  try {
    await saveWebsiteForm(db, workspaceId, formId, input);
  } catch (err) {
    if (err instanceof FormError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function deleteFormAction(workspaceId: string, formId: string) {
  await requireWorkspace(workspaceId);
  await deleteForm(db, workspaceId, formId);
  redirect(`/w/${workspaceId}/forms`);
}

/** The public form. On success, `message` carries the page to go to, if the form has one. */
export async function submitFormAction(slug: string, _: ActionState, form: FormData): Promise<ActionState> {
  if (String(form.get("website") ?? "")) return { ok: true }; // honeypot: bots fill every field
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("field_") && typeof value === "string") values[key.slice(6)] = value;
  }
  try {
    const result = await submitForm(db, slug, {
      values,
      smsOptIn: form.get("smsOptIn") === "on",
      page: String(form.get("page") ?? "") || null,
    });
    return { ok: true, message: result.form.redirectUrl };
  } catch (err) {
    if (err instanceof FormError) return { error: err.message };
    throw err;
  }
}
