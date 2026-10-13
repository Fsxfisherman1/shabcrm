"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { parseTags } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import {
  addNote,
  createContact,
  deleteContact,
  DuplicateContactError,
  importContacts,
  setSmsConsent,
  updateContact,
  type ConsentInput,
  type ImportResult,
} from "@/server/contacts";
import type { ActionState } from "./types";

function contactFields(form: FormData) {
  return {
    firstName: String(form.get("firstName") ?? ""),
    lastName: String(form.get("lastName") ?? ""),
    email: String(form.get("email") ?? ""),
    phone: String(form.get("phone") ?? ""),
    company: String(form.get("company") ?? ""),
    source: String(form.get("source") ?? ""),
    tags: parseTags(String(form.get("tags") ?? "")),
  };
}

function check(fields: ReturnType<typeof contactFields>): string | null {
  if (!fields.firstName && !fields.lastName && !fields.email && !fields.phone) {
    return "Add at least a name, email or phone.";
  }
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) return "That email doesn't look right.";
  return null;
}

function consentFrom(form: FormData): ConsentInput {
  const consent = String(form.get("smsConsent") ?? "none");
  const source = String(form.get("smsConsentSource") ?? "").trim();
  if (consent === "granted") return { smsConsent: "granted", smsConsentSource: source || "Recorded manually" };
  if (consent === "revoked") return { smsConsent: "revoked" };
  return { smsConsent: "none" };
}

export async function createContactAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { user } = await requireWorkspace(workspaceId);
  const fields = contactFields(form);
  const problem = check(fields);
  if (problem) return { error: problem };
  if (fields.phone && !/\d{7,}/.test(fields.phone.replace(/\D/g, ""))) return { error: "That phone number looks too short." };
  let id: string;
  try {
    const contact = await createContact(db, workspaceId, { ...fields, consent: consentFrom(form) }, user.id);
    id = contact.id;
  } catch (err) {
    if (err instanceof DuplicateContactError) return { error: err.message };
    throw err;
  }
  redirect(`/w/${workspaceId}/contacts/${id}`);
}

export async function updateContactAction(
  workspaceId: string,
  contactId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const fields = contactFields(form);
  const problem = check(fields);
  if (problem) return { error: problem };
  try {
    await updateContact(db, workspaceId, contactId, fields);
  } catch (err) {
    if (err instanceof DuplicateContactError) return { error: err.message };
    throw err;
  }
  refresh();
  return { ok: true, message: "Saved." };
}

export async function setConsentAction(
  workspaceId: string,
  contactId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { user } = await requireWorkspace(workspaceId);
  const consent = consentFrom(form);
  if (consent.smsConsent === "granted" && !String(form.get("smsConsentSource") ?? "").trim()) {
    return { error: "Say how they agreed to texts, e.g. \"Signed the intake form\"." };
  }
  await setSmsConsent(db, workspaceId, contactId, consent, user.id);
  refresh();
  return { ok: true, message: "Consent updated." };
}

export async function addNoteAction(workspaceId: string, contactId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { user } = await requireWorkspace(workspaceId);
  const body = String(form.get("body") ?? "");
  if (!body.trim()) return { error: "Write something first." };
  await addNote(db, workspaceId, contactId, body, user.id);
  refresh();
  return { ok: true };
}

export async function deleteContactAction(workspaceId: string, contactId: string) {
  await requireWorkspace(workspaceId);
  await deleteContact(db, workspaceId, contactId);
  redirect(`/w/${workspaceId}/contacts`);
}

const importSchema = z.object({
  rows: z
    .array(
      z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .max(5000, "Import up to 5,000 rows at a time."),
  consent: z.enum(["granted", "none"]),
  consentSource: z.string().trim().max(200),
  tags: z.string().max(500),
  fileName: z.string().max(200),
});

export async function importContactsAction(
  workspaceId: string,
  input: z.input<typeof importSchema>,
): Promise<{ error: string } | { result: ImportResult }> {
  const { user } = await requireWorkspace(workspaceId);
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { rows, consent, consentSource, tags, fileName } = parsed.data;
  if (consent === "granted" && !consentSource) {
    return { error: "Say how these contacts agreed to texts." };
  }
  const result = await importContacts(
    db,
    workspaceId,
    rows,
    {
      consent: consent === "granted" ? { smsConsent: "granted", smsConsentSource: consentSource } : { smsConsent: "none" },
      tags: parseTags(tags),
      source: fileName || "CSV import",
    },
    user.id,
  );
  return { result };
}
