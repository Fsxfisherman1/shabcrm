import { randomBytes } from "node:crypto";
import { and, count, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  activities,
  CONTACT_FIELD_KINDS,
  contacts,
  formSubmissions,
  forms,
  workspaces,
  type Contact,
  type Form,
  type FormField,
  type Workspace,
} from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { parseTags } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { findExisting } from "@/server/contacts";
import { fireTrigger } from "@/server/workflows/triggers";

export class FormError extends Error {}

export const DEFAULT_FIELDS: FormField[] = [
  { id: "f1", kind: "full_name", label: "Name", required: true },
  { id: "f2", kind: "email", label: "Email", required: true },
  { id: "f3", kind: "phone", label: "Phone", required: false },
  { id: "f4", kind: "textarea", label: "How can we help?", required: false },
];

/** The key a custom field's answer goes under in workflows: {{data.how_can_we_help}}. */
export function answerKey(label: string) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "answer"
  );
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "form"
  );
}

// ---------------------------------------------------------------------------
// Managing forms (inside the CRM)
// ---------------------------------------------------------------------------

export async function listForms(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const list = await tx.select().from(forms).orderBy(desc(forms.updatedAt));
    const counts = await tx.select({ formId: formSubmissions.formId, n: count() }).from(formSubmissions).groupBy(formSubmissions.formId);
    return list.map((f) => ({ ...f, submissions: counts.find((c) => c.formId === f.id)?.n ?? 0 }));
  });
}

export async function getForm(db: Db, workspaceId: string, formId: string) {
  const [form] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(forms).where(eq(forms.id, formId)));
  return form ?? null;
}

export async function createForm(db: Db, workspaceId: string, name: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const title = name.trim() || "Contact us";
  const [form] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .insert(forms)
      .values({
        workspaceId,
        name: title,
        slug: `${slugify(workspace.name)}-${randomBytes(3).toString("hex")}`,
        title: "Get in touch",
        description: `Send ${workspace.name} a message and we'll get back to you.`,
        fields: DEFAULT_FIELDS,
        smsConsentText: `I agree to receive text messages from ${workspace.name}. Message and data rates may apply. Reply STOP to opt out.`,
      })
      .returning(),
  );
  return form;
}

const text = (max: number, what: string) => z.string().trim().min(1, `${what} can't be empty.`).max(max);

const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum([...CONTACT_FIELD_KINDS, "text", "textarea", "select"]),
  label: text(120, "Each field's label"),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});

export type FormInput = {
  name: string;
  enabled: boolean;
  slug: string;
  title: string;
  description: string;
  fields: unknown;
  submitLabel: string;
  thankYou: string;
  redirectUrl: string;
  smsConsentText: string;
  tags: string;
};

export async function saveForm(db: Db, workspaceId: string, formId: string, input: FormInput) {
  const name = input.name.trim();
  if (!name) throw new FormError("Give the form a name.");
  const title = input.title.trim();
  if (!title) throw new FormError("Give the form a heading.");
  const slug = slugify(input.slug);
  if (slug.length < 3) throw new FormError("The form address needs at least 3 letters or numbers.");
  const parsed = fieldSchema.array().min(1, "Add at least one field.").max(30).safeParse(input.fields);
  if (!parsed.success) throw new FormError(parsed.error.issues[0].message);
  const fields = parsed.data.map((f) => (f.kind === "select" ? { ...f, options: f.options ?? [] } : { ...f, options: undefined }));
  for (const kind of CONTACT_FIELD_KINDS) {
    if (fields.filter((f) => f.kind === kind).length > 1) throw new FormError("Each contact detail (name, email, phone…) can only be on the form once.");
  }
  if (!fields.some((f) => f.kind === "email" || f.kind === "phone")) throw new FormError("Add an email or phone field, so you can reach the people who fill it in.");
  if (fields.some((f) => f.kind === "select" && !f.options?.length)) throw new FormError("Give each dropdown at least one choice.");
  if (new Set(fields.map((f) => f.id)).size !== fields.length) throw new FormError("Two fields share an id. Reload and try again.");
  const labels = fields.filter((f) => !CONTACT_FIELD_KINDS.includes(f.kind as never)).map((f) => answerKey(f.label));
  if (new Set(labels).size !== labels.length) throw new FormError("Two questions have the same label. Give each one its own.");
  const redirectUrl = input.redirectUrl.trim();
  if (redirectUrl && !/^https?:\/\/\S+$/.test(redirectUrl)) throw new FormError("The page to send people to must start with https://.");

  const [taken] = await db.select({ id: forms.id }).from(forms).where(and(eq(forms.slug, slug), ne(forms.id, formId)));
  if (taken) throw new FormError("That form address is taken. Try another.");

  const [form] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(forms)
      .set({
        name,
        enabled: input.enabled,
        slug,
        title,
        description: input.description.trim(),
        fields,
        submitLabel: input.submitLabel.trim() || "Send",
        thankYou: input.thankYou.trim() || "Thanks! We'll be in touch soon.",
        redirectUrl: redirectUrl || null,
        smsConsentText: input.smsConsentText.trim() || null,
        tags: parseTags(input.tags),
        updatedAt: new Date(),
      })
      .where(eq(forms.id, formId))
      .returning(),
  );
  if (!form) throw new FormError("Form not found.");
  return form;
}

export async function deleteForm(db: Db, workspaceId: string, formId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(forms).where(eq(forms.id, formId)));
}

export async function listSubmissions(db: Db, workspaceId: string, formId: string, limit = 100) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ submission: formSubmissions, contact: { id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone } })
      .from(formSubmissions)
      .leftJoin(contacts, eq(contacts.id, formSubmissions.contactId))
      .where(eq(formSubmissions.formId, formId))
      .orderBy(desc(formSubmissions.createdAt))
      .limit(limit),
  );
}

// ---------------------------------------------------------------------------
// The public form
// ---------------------------------------------------------------------------

export async function formBySlug(db: Db, slug: string): Promise<{ form: Form; workspace: Workspace } | null> {
  const [row] = await db
    .select({ form: forms, workspace: workspaces })
    .from(forms)
    .innerJoin(workspaces, eq(workspaces.id, forms.workspaceId))
    .where(eq(forms.slug, slug.toLowerCase()));
  return row ?? null;
}

export type Submission = {
  /** Answers by field id. */
  values: Record<string, string>;
  smsOptIn: boolean;
  /** The page the form was filled in on, when embedded. */
  page?: string | null;
};

/**
 * Someone filled in a form: find or add the contact, save their answers, and
 * start any workflows waiting for this form.
 */
export async function submitForm(db: Db, slug: string, input: Submission) {
  const found = await formBySlug(db, slug);
  if (!found || !found.form.enabled) throw new FormError("This form isn't taking responses right now.");
  const { form, workspace } = found;

  const answers: Record<string, string> = {};
  const data: Record<string, string> = {};
  const details: Partial<Record<(typeof CONTACT_FIELD_KINDS)[number], string>> = {};
  for (const field of form.fields) {
    const value = String(input.values[field.id] ?? "").trim().slice(0, 5000);
    if (!value) {
      if (field.required) throw new FormError(`Please fill in "${field.label}".`);
      continue;
    }
    if (field.kind === "select" && !field.options?.includes(value)) throw new FormError(`Please pick an option for "${field.label}".`);
    answers[field.label] = value;
    if (CONTACT_FIELD_KINDS.includes(field.kind as never)) details[field.kind as (typeof CONTACT_FIELD_KINDS)[number]] = value;
    else data[answerKey(field.label)] = value;
  }

  const email = details.email ? details.email.toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FormError("Please enter a valid email address.");
  const phone = details.phone ? normalizePhone(details.phone) : null;
  if (details.phone && !phone) throw new FormError("That phone number doesn't look right.");
  if (!email && !phone) throw new FormError("Please enter your email or phone number.");
  let firstName = details.first_name ?? "";
  let lastName = details.last_name ?? "";
  if (details.full_name) {
    const [head = "", ...tail] = details.full_name.split(/\s+/);
    firstName = head;
    lastName = tail.join(" ");
  }
  const source = `Form: ${form.name}`;
  const page = input.page && /^https?:\/\//.test(input.page) ? input.page.slice(0, 500) : null;

  const contact = await withWorkspace(db, workspace.id, async (tx) => {
    let contact: Contact | null = await findExisting(tx, email, phone);
    let newTags = form.tags;
    if (!contact) {
      [contact] = await tx
        .insert(contacts)
        .values({ workspaceId: workspace.id, firstName, lastName, email, phone, company: details.company || null, source, tags: form.tags })
        .returning();
      await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "created", body: `Added from ${source}` });
      await fireTrigger(tx, workspace.id, { type: "contact_created", contactId: contact.id });
    } else {
      // Fill in what we didn't have; never overwrite what's there.
      const fill: Partial<Contact> = {};
      if (!contact.firstName && !contact.lastName && (firstName || lastName)) Object.assign(fill, { firstName, lastName });
      if (!contact.email && email) fill.email = email;
      if (!contact.phone && phone) fill.phone = phone;
      if (!contact.company && details.company) fill.company = details.company;
      newTags = form.tags.filter((t) => !contact!.tags.includes(t));
      if (newTags.length) fill.tags = [...contact.tags, ...newTags];
      if (Object.keys(fill).length) [contact] = await tx.update(contacts).set({ ...fill, updatedAt: new Date() }).where(eq(contacts.id, contact.id)).returning();
    }

    // Ticking "text me" records consent, but never overrides an opt-out.
    if (input.smsOptIn && form.smsConsentText && contact.phone && contact.smsConsent === "none") {
      [contact] = await tx
        .update(contacts)
        .set({ smsConsent: "granted", smsConsentSource: source, smsConsentAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, contact.id))
        .returning();
      await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "consent_changed", body: `Agreed to texts on the form "${form.name}"` });
    }

    await tx.insert(formSubmissions).values({ workspaceId: workspace.id, formId: form.id, contactId: contact.id, answers, page });
    const summary = Object.entries(answers)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
    await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "form_submitted", body: `Filled in "${form.name}"\n${summary}` });
    for (const tag of newTags) await fireTrigger(tx, workspace.id, { type: "tag_added", contactId: contact.id, tag });
    await fireTrigger(tx, workspace.id, { type: "form_submitted", contactId: contact.id, formId: form.id, data });
    return contact;
  });
  return { form, contact };
}
