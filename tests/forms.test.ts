import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { activities, formSubmissions, workspaces } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { createContact, getContact, setSmsConsent } from "@/server/contacts";
import { createForm, formBySlug, FormError, listForms, listSubmissions, saveForm, submitForm, type FormInput } from "@/server/forms";
import { TestEmail, TestSms } from "@/server/messaging/providers";
import { createWorkflow, saveWorkflow } from "@/server/workflows";
import { runDueWorkflows } from "@/server/workflows/engine";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  const form = await createForm(db, ws.id, "Quote request");
  return { alex, ws, form };
}

function input(form: Awaited<ReturnType<typeof createForm>>, patch: Partial<FormInput> = {}): FormInput {
  return {
    name: form.name,
    enabled: true,
    slug: form.slug,
    title: form.title,
    description: form.description,
    fields: form.fields,
    submitLabel: form.submitLabel,
    thankYou: form.thankYou,
    redirectUrl: "",
    smsConsentText: form.smsConsentText ?? "",
    tags: "",
    ...patch,
  };
}

describe("forms", () => {
  beforeEach(resetDb);

  it("adds a new contact with tags, answers and text consent", async () => {
    const { ws, form } = await setup();
    await saveForm(db, ws.id, form.id, input(form, { tags: "Website Lead, quote" }));
    const { contact } = await submitForm(db, form.slug, {
      values: { f1: "Jane Q Doe", f2: "Jane@Example.com", f3: "(415) 555-0101", f4: "Leaky faucet" },
      smsOptIn: true,
      page: "https://acme.example.com/contact",
    });
    expect(contact).toMatchObject({
      firstName: "Jane",
      lastName: "Q Doe",
      email: "jane@example.com",
      phone: "+14155550101",
      tags: ["website lead", "quote"],
      source: "Form: Quote request",
      smsConsent: "granted",
      smsConsentSource: "Form: Quote request",
    });
    const [sub] = await listSubmissions(db, ws.id, form.id);
    expect(sub.submission).toMatchObject({ answers: { Name: "Jane Q Doe", Email: "Jane@Example.com", Phone: "(415) 555-0101", "How can we help?": "Leaky faucet" }, page: "https://acme.example.com/contact" });
    const [list] = await listForms(db, ws.id);
    expect(list.submissions).toBe(1);
  });

  it("updates an existing contact without overwriting, and never re-opts-in someone who opted out", async () => {
    const { alex, ws, form } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Janet", email: "jane@example.com", tags: ["vip"] }, alex.id);
    await setSmsConsent(db, ws.id, c.id, { smsConsent: "revoked" }, alex.id);
    await saveForm(db, ws.id, form.id, input(form, { tags: "lead" }));
    const { contact } = await submitForm(db, form.slug, { values: { f1: "Jane Doe", f2: "jane@example.com", f3: "4155550101" }, smsOptIn: true });
    expect(contact.id).toBe(c.id);
    expect(contact).toMatchObject({ firstName: "Janet", phone: "+14155550101", tags: ["vip", "lead"], smsConsent: "revoked" });
    const acts = await withWorkspace(db, ws.id, (tx) => tx.select().from(activities).where(eq(activities.contactId, c.id)));
    expect(acts.some((a) => a.kind === "form_submitted" && a.body.startsWith('Filled in "Quote request"'))).toBe(true);
  });

  it("checks required fields, choices and contact details", async () => {
    const { ws, form } = await setup();
    await saveForm(db, ws.id, form.id, input(form, { fields: [...form.fields, { id: "s", kind: "select", label: "Service", required: true, options: ["Repair", "Install"] }] }));
    const ok = { f1: "Jane", f2: "jane@example.com", s: "Repair" };
    await expect(submitForm(db, form.slug, { values: { ...ok, f1: "" }, smsOptIn: false })).rejects.toThrow('Please fill in "Name"');
    await expect(submitForm(db, form.slug, { values: { ...ok, s: "Hack" }, smsOptIn: false })).rejects.toThrow(/pick an option/);
    await expect(submitForm(db, form.slug, { values: { ...ok, f2: "nope" }, smsOptIn: false })).rejects.toThrow(/valid email/);
    await expect(submitForm(db, form.slug, { values: { ...ok, f3: "12" }, smsOptIn: false })).rejects.toThrow(/phone number/);
    await saveForm(db, ws.id, form.id, input(form, { enabled: false }));
    await expect(submitForm(db, form.slug, { values: ok, smsOptIn: false })).rejects.toThrow(FormError);
  });

  it("refuses forms that can't reach anyone, duplicate details and taken addresses", async () => {
    const { ws, form } = await setup();
    await expect(saveForm(db, ws.id, form.id, input(form, { fields: [{ id: "a", kind: "full_name", label: "Name", required: true }] }))).rejects.toThrow(/email or phone/);
    await expect(
      saveForm(db, ws.id, form.id, input(form, { fields: [...form.fields, { id: "x", kind: "email", label: "Work email", required: false }] })),
    ).rejects.toThrow(/only be on the form once/);
    const other = await createForm(db, ws.id, "Other");
    await expect(saveForm(db, ws.id, other.id, input(other, { slug: form.slug }))).rejects.toThrow(/taken/);
    expect((await saveForm(db, ws.id, form.id, input(form, { slug: "Acme Quote!" }))).slug).toBe("acme-quote");
    expect(await formBySlug(db, "ACME-QUOTE")).not.toBeNull();
  });

  it("keeps each account's submissions to itself", async () => {
    const { alex, ws, form } = await setup();
    const other = await makeWorkspace(alex.id, "Other");
    await submitForm(db, form.slug, { values: { f1: "Jane", f2: "jane@example.com" }, smsOptIn: false });
    expect(await withWorkspace(db, other.id, (tx) => tx.select().from(formSubmissions))).toEqual([]);
    expect(await getContact(db, other.id, (await listSubmissions(db, ws.id, form.id))[0].contact!.id)).toBeNull();
  });

  it("starts workflows for that form, with answers as merge fields", async () => {
    const { alex, ws, form } = await setup();
    await db.update(workspaces).set({ emailFromAddress: "hi@acme.test" }).where(eq(workspaces.id, ws.id));
    const other = await createForm(db, ws.id, "Other form");
    for (const f of [form, other]) {
      const wf = await createWorkflow(db, ws.id, { name: f.name, trigger: { type: "form_submitted", formId: f.id } }, alex.id);
      await saveWorkflow(db, ws.id, wf.id, {
        name: f.name,
        enabled: true,
        trigger: { type: "form_submitted", formId: f.id },
        steps: [{ id: "a", type: "send_email", subject: "Thanks", body: `${f.name}: {{first_name}} needs {{data.how_can_we_help|help}}` }],
        stopOnReply: true,
        allowReentry: true,
      });
    }
    await submitForm(db, form.slug, { values: { f1: "Jane", f2: "jane@example.com", f4: "a new water heater" }, smsOptIn: false });
    const providers = { sms: new TestSms(), email: new TestEmail() };
    await runDueWorkflows(db, { providers });
    expect(providers.email.sent.map((m) => m.text)).toEqual(["Quote request: Jane needs a new water heater"]);
  });
});
