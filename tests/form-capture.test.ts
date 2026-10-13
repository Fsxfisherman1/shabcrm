import { beforeEach, describe, expect, it } from "vitest";
import { withWorkspace } from "@/db/tenant";
import { formSubmissions } from "@/db/schema";
import { getContact } from "@/server/contacts";
import { captureSubmission, classifyField, flattenBody, getCaptureKey, type CapturedField } from "@/server/form-capture";
import { listForms, listSubmissions, saveWebsiteForm } from "@/server/forms";
import { TestEmail, TestSms } from "@/server/messaging/providers";
import { createWorkflow, saveWorkflow } from "@/server/workflows";
import { runDueWorkflows } from "@/server/workflows/engine";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

const field = (name: string, value: string, label = "", type = "text"): CapturedField => ({ name, label, type, value });
const page = "https://brightsmile.example.com/contact/";

describe("recognizing fields", () => {
  it("reads common names, labels and types", () => {
    expect(classifyField(field("your-email", "", "", "email"))).toBe("email");
    expect(classifyField(field("input_3", "", "Mobile number"))).toBe("phone");
    expect(classifyField(field("fields[first_name]", "", ""))).toBe("first_name");
    expect(classifyField(field("lname", ""))).toBe("last_name");
    expect(classifyField(field("your-name", "", "Your Name"))).toBe("full_name");
    expect(classifyField(field("fullName", ""))).toBe("full_name");
    expect(classifyField(field("company", "", "Company name"))).toBe("company");
    // Not contact details:
    expect(classifyField(field("pet", "", "Pet's name"))).toBeNull();
    expect(classifyField(field("msg", "", "Message"))).toBeNull();
    expect(classifyField(field("contact_time", "", "Best time to phone you"))).toBeNull();
  });

  it("flattens site-builder webhooks", () => {
    expect(flattenBody({ data: { firstName: "Lee", email: "lee@example.com", service: ["Cleaning", "Whitening"] }, formId: "abc" })).toEqual([
      { name: "firstName", label: "First Name", type: "text", value: "Lee" },
      { name: "email", label: "Email", type: "text", value: "lee@example.com" },
      { name: "service", label: "service", type: "text", value: "Cleaning, Whitening" },
      { name: "formId", label: "Form Id", type: "text", value: "abc" },
    ]);
    expect(flattenBody({ submissions: [{ label: "Phone", value: "4155550101" }] })).toEqual([{ name: "Phone", label: "Phone", type: "text", value: "4155550101" }]);
  });
});

describe("capturing website forms", () => {
  beforeEach(resetDb);

  async function setup() {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    const key = await getCaptureKey(db, ws.id);
    return { alex, ws, key };
  }

  it("adds the contact and creates the form on first use", async () => {
    const { ws, key } = await setup();
    expect(await getCaptureKey(db, ws.id)).toBe(key);
    const res = await captureSubmission(db, key, {
      formKey: "wpcf7-f12",
      formName: "",
      page,
      fields: [
        field("your-name", "Lee Park", "Your Name"),
        field("your-email", "Lee@Example.com", "Your Email", "email"),
        field("your-message", "Do you take new patients?", "Your Message", "textarea"),
        field("card-number", "4242424242424242", "Card number"),
        field("_wpnonce", "abc123", ""),
      ],
    });
    expect(res.ok).toBe(true);
    const [form] = await listForms(db, ws.id);
    expect(form).toMatchObject({ source: "website", name: "Form on brightsmile.example.com/contact", externalKey: "brightsmile.example.com/contact#wpcf7-f12", submissions: 1 });
    const [{ submission, contact }] = await listSubmissions(db, ws.id, form.id);
    expect(submission.answers).toEqual({ "Your Name": "Lee Park", "Your Email": "Lee@Example.com", "Your Message": "Do you take new patients?" });
    expect(contact).toMatchObject({ firstName: "Lee", lastName: "Park", email: "lee@example.com" });
    const full = await getContact(db, ws.id, contact!.id);
    expect(full?.contact).toMatchObject({ source: "Form: Form on brightsmile.example.com/contact", smsConsent: "none" });
  });

  it("ignores forms without an email or phone, repeats, switched-off forms and unknown keys", async () => {
    const { ws, key } = await setup();
    const search = await captureSubmission(db, key, { formKey: "search", formName: "", page, fields: [field("q", "braces")] });
    expect(search).toMatchObject({ ok: false, reason: "No email or phone" });

    const lead = { formKey: "quote", formName: "Quote", page, fields: [field("email", "a@b.co", "Email", "email")] };
    expect((await captureSubmission(db, key, lead)).ok).toBe(true);
    expect(await captureSubmission(db, key, lead)).toMatchObject({ ok: false, reason: "Already received" });
    const [form] = await listForms(db, ws.id);
    await saveWebsiteForm(db, ws.id, form.id, { name: "Quote", enabled: false, tags: "" });
    expect(await captureSubmission(db, key, { ...lead, fields: [field("email", "c@d.co", "Email", "email")] })).toMatchObject({ ok: false, reason: "Form is switched off" });
    expect(await withWorkspace(db, ws.id, (tx) => tx.select().from(formSubmissions))).toHaveLength(1);
    expect(await captureSubmission(db, "ws_nottherealkey123", lead)).toMatchObject({ ok: false, status: 404 });
  });

  it("keeps the same form across pages' trailing slashes and learns new questions", async () => {
    const { ws, key } = await setup();
    await captureSubmission(db, key, { formKey: "f", formName: "Contact", page, fields: [field("email", "a@b.co", "Email", "email")] });
    await captureSubmission(db, key, {
      formKey: "f",
      formName: "Contact",
      page: "https://brightsmile.example.com/contact?utm=fb",
      fields: [field("email", "x@y.co", "Email", "email"), field("svc", "Cleaning", "Service")],
    });
    const forms = await listForms(db, ws.id);
    expect(forms).toHaveLength(1);
    expect(forms[0].fields.map((f) => f.label)).toEqual(["Email", "Service"]);
  });

  it("starts workflows and applies tags", async () => {
    const { alex, ws, key } = await setup();
    await captureSubmission(db, key, { formKey: "f", formName: "Contact", page, fields: [field("email", "a@b.co", "Email", "email")] });
    const [form] = await listForms(db, ws.id);
    await saveWebsiteForm(db, ws.id, form.id, { name: "Contact page", enabled: true, tags: "Website Lead" });
    const wf = await createWorkflow(db, ws.id, { name: "x", trigger: { type: "form_submitted", formId: form.id } }, alex.id);
    await saveWorkflow(db, ws.id, wf.id, {
      name: "x",
      enabled: true,
      trigger: { type: "form_submitted", formId: form.id },
      steps: [{ id: "a", type: "add_note", body: "Wants {{data.service|something}}" }],
      stopOnReply: true,
      allowReentry: true,
    });
    await captureSubmission(db, key, { formKey: "f", formName: "Contact", page, fields: [field("email", "z@z.co", "Email", "email"), field("s", "Implants", "Service")] });
    await runDueWorkflows(db, { providers: { sms: new TestSms(), email: new TestEmail() } });
    const [{ contact }] = await listSubmissions(db, ws.id, form.id);
    const full = await getContact(db, ws.id, contact!.id);
    expect(full?.contact.tags).toEqual(["website lead"]);
    expect(full?.timeline.some((a) => a.body === "Wants Implants")).toBe(true);
  });
});
