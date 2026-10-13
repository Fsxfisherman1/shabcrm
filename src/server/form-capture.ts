import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { formSubmissions, forms, workspaces, type Form, type FormField, type Workspace } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { answerKey, FormError, recordSubmission } from "./forms";

// ---------------------------------------------------------------------------
// Picking up a website's own forms. A snippet on the site (or a webhook from a
// site builder like Wix) sends each submission here; the site's form keeps
// working as before.
// ---------------------------------------------------------------------------

export type CapturedField = { name: string; label: string; type: string; value: string };
export type Capture = { formKey: string; formName: string; page: string; fields: CapturedField[] };

/** The account's snippet key, made the first time it's needed. */
export async function getCaptureKey(db: Db, workspaceId: string) {
  const [ws] = await db.select({ key: workspaces.captureKey }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (ws?.key) return ws.key;
  await db
    .update(workspaces)
    .set({ captureKey: `ws_${randomBytes(12).toString("base64url")}` })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.captureKey)));
  return getCaptureKey(db, workspaceId);
}

async function workspaceByKey(db: Db, key: string): Promise<Workspace | null> {
  if (!/^ws_[\w-]{10,40}$/.test(key)) return null;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.captureKey, key));
  return ws ?? null;
}

type Detail = "email" | "phone" | "first_name" | "last_name" | "full_name" | "company";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(your|the|please enter|enter)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const NAMES: Record<Exclude<Detail, "email" | "phone">, RegExp> = {
  first_name: /^(first ?name|fname|given ?name|first)$/,
  last_name: /^(last ?name|lname|surname|family ?name|last)$/,
  full_name: /^(name|full ?name|contact ?name|names?)$/,
  company: /^(company|company ?name|business|business ?name|organi[sz]ation)$/,
};

/** Works out what a field on someone else's form is, from its type, name and label. */
export function classifyField(f: Pick<CapturedField, "name" | "label" | "type">): Detail | null {
  // Builders often name fields like "input_3" or "fields[name]"; strip the wrapping.
  const texts = [f.label, f.name.replace(/^.*\[([^\]]+)\]$/, "$1")].map((t) => norm(t ?? "")).filter(Boolean);
  if (f.type === "email" || texts.some((t) => /\be ?mail\b/.test(t))) return "email";
  if (f.type === "tel" || texts.some((t) => /\b(phone|mobile|cell|telephone|tel)\b/.test(t) && !/\b(prefer|best time|when)\b/.test(t))) return "phone";
  for (const [kind, pattern] of Object.entries(NAMES)) {
    if (texts.some((t) => pattern.test(t))) return kind as Detail;
  }
  return null;
}

// Fields that are never worth keeping: passwords, payment details, anti-spam tokens.
const SKIP = /password|passwd|card|cvv|cvc|ssn|social security|captcha|recaptcha|honeypot|nonce|token|csrf/i;

function clean(text: unknown, max: number) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * One submission from a website form. Returns null (and saves nothing) when the
 * form is switched off or there's no email or phone to know who it is.
 */
export async function captureSubmission(db: Db, key: string, capture: Capture) {
  const workspace = await workspaceByKey(db, key);
  if (!workspace) return { ok: false as const, status: 404, reason: "Unknown key" };

  let url: URL | null = null;
  try {
    url = capture.page ? new URL(capture.page) : null;
  } catch {
    url = null;
  }
  const where = url ? `${url.host}${url.pathname.replace(/\/$/, "")}` : "";
  const formKey = clean(capture.formKey, 120) || "form";
  const externalKey = `${where}#${formKey}`.toLowerCase().slice(0, 300);

  const answers: Record<string, string> = {};
  const data: Record<string, string> = {};
  const details: Partial<Record<Detail, string>> = {};
  const labels: string[] = [];
  for (const f of capture.fields.slice(0, 60)) {
    const label = clean(f.label || f.name, 120);
    const value = String(f.value ?? "").trim().slice(0, 5000);
    if (!label || !value || ["password", "hidden", "submit", "file", "button"].includes(f.type) || SKIP.test(`${f.name} ${label}`)) continue;
    const kind = classifyField(f);
    if (kind && !details[kind]) details[kind] = value;
    else data[answerKey(label)] = value;
    answers[label] = answers[label] ? `${answers[label]}, ${value}` : value;
    if (!labels.includes(label)) labels.push(label);
  }
  if (!details.email && !details.phone) return { ok: false as const, status: 200, reason: "No email or phone" };

  // Each form on each page becomes a form on the Forms tab the first time it's used.
  const name = clean(capture.formName, 80) || (where ? `Form on ${where}` : "Website form");
  const form = await withWorkspace(db, workspace.id, async (tx) => {
    const [existing] = await tx.select().from(forms).where(eq(forms.externalKey, externalKey));
    const fields: FormField[] = labels.map((label, i) => ({ id: `w${i}`, kind: "text", label, required: false }));
    if (existing) {
      const known = new Set(existing.fields.map((f) => f.label));
      const added = labels.filter((l) => !known.has(l));
      if (!added.length) return existing;
      const [updated] = await tx
        .update(forms)
        .set({ fields: [...existing.fields, ...added.map((label, i) => ({ id: `w${existing.fields.length + i}`, kind: "text" as const, label, required: false }))] })
        .where(eq(forms.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await tx
      .insert(forms)
      .values({
        workspaceId: workspace.id,
        source: "website",
        externalKey,
        slug: `site-${randomBytes(5).toString("hex")}`,
        name,
        title: name,
        fields,
        smsConsentText: null,
      })
      .onConflictDoNothing()
      .returning();
    return created ?? (await tx.select().from(forms).where(eq(forms.externalKey, externalKey)))[0];
  });
  if (!form.enabled) return { ok: false as const, status: 200, reason: "Form is switched off" };

  // Sites that check the form after it's sent can fire it twice; keep one.
  const [repeat] = await withWorkspace(db, workspace.id, (tx) =>
    tx
      .select({ id: formSubmissions.id })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.formId, form.id), gt(formSubmissions.createdAt, new Date(Date.now() - 2 * 60_000)), sql`${formSubmissions.answers} = ${JSON.stringify(answers)}::jsonb`))
      .limit(1),
  );
  if (repeat) return { ok: false as const, status: 200, reason: "Already received" };

  try {
    const contact = await recordSubmission(db, workspace, form as Form, {
      answers,
      details,
      data,
      smsOptIn: false, // we can't see what a website's own consent checkbox said
      page: url?.toString() ?? null,
    });
    return { ok: true as const, formId: form.id, contactId: contact.id };
  } catch (err) {
    if (err instanceof FormError) return { ok: false as const, status: 200, reason: err.message };
    throw err;
  }
}

/** Turns a nested JSON body (Wix, Zapier…) into a flat list of fields. */
export function flattenBody(body: unknown, prefix = "", out: CapturedField[] = []): CapturedField[] {
  if (out.length >= 60 || body === null || body === undefined) return out;
  if (Array.isArray(body)) {
    if (body.every((v) => typeof v !== "object" || v === null)) {
      if (prefix) out.push({ name: prefix, label: prefix, type: "text", value: body.join(", ") });
      return out;
    }
    // Lists of {label/name/key, value} pairs, as some builders send.
    for (const item of body) {
      if (item && typeof item === "object" && "value" in item) {
        const o = item as Record<string, unknown>;
        const label = String(o.label ?? o.title ?? o.name ?? o.key ?? o.fieldName ?? prefix);
        flattenBody(o.value, label, out);
      } else flattenBody(item, prefix, out);
    }
    return out;
  }
  if (typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      // Builders often wrap the answers ({ data: {...} }); keep inner names short.
      const name = ["data", "fields", "submission", "submissions", "formData", "values", "contact"].includes(k) ? prefix : prefix ? `${prefix} ${k}` : k;
      flattenBody(v, name, out);
    }
    return out;
  }
  if (prefix) out.push({ name: prefix, label: humanize(prefix), type: "text", value: String(body) });
  return out;
}

function humanize(name: string) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
