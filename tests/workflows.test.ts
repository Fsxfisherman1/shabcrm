import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { activities, deals, pipelineStages, todos, workflowQueue, workflowRuns, workspaces, type WorkflowStep, type WorkflowTrigger } from "@/db/schema";
import { cancelAppointment, createAppointment } from "@/server/calendars";
import type { ProviderFactory } from "@/server/calendars/config";
import { createContact, getContact, updateContact } from "@/server/contacts";
import { receiveSms } from "@/server/messaging";
import { TestEmail, TestSms } from "@/server/messaging/providers";
import { createDeal, listPipelines, moveDeal, updateDeal } from "@/server/pipelines";
import {
  createWorkflow,
  enrollByHand,
  listRuns,
  listWorkflows,
  receiveWorkflowWebhook,
  saveWorkflow,
  setWorkflowEnabled,
  WorkflowError,
} from "@/server/workflows";
import { fillTemplate, runDueWorkflows, stopAllRuns } from "@/server/workflows/engine";
import { stepAfter } from "@/server/workflows/steps";
import { withWorkspace } from "@/db/tenant";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

const NUMBER = "+14155550000";
const noCalendars: ProviderFactory = () => {
  throw new Error("no calendars in these tests");
};

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  await db
    .update(workspaces)
    .set({ smsNumber: NUMBER, emailFromAddress: "hello@acme.test", emailFromName: "Acme Plumbing" })
    .where(eq(workspaces.id, ws.id));
  const providers = { sms: new TestSms(), email: new TestEmail() };
  const deps = { providers, appUrl: "https://crm.example.com" };
  const run = (now = new Date()) => runDueWorkflows(db, deps, now);
  return { alex, ws, providers, deps, run };
}

async function workflow(
  workspaceId: string,
  userId: string,
  trigger: WorkflowTrigger,
  steps: WorkflowStep[],
  opts: { stopOnReply?: boolean; allowReentry?: boolean; enabled?: boolean } = {},
) {
  const wf = await createWorkflow(db, workspaceId, { name: "Test", trigger }, userId);
  return saveWorkflow(db, workspaceId, wf.id, {
    name: "Test",
    enabled: opts.enabled ?? true,
    trigger,
    steps,
    stopOnReply: opts.stopOnReply ?? true,
    allowReentry: opts.allowReentry ?? false,
  });
}

/** Tenant tables only show their rows inside withWorkspace. */
const inWs = <T>(workspaceId: string, fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);

const consent = { smsConsent: "granted" as const, smsConsentSource: "Form" };
const hour = 3600_000;

describe("starting workflows", () => {
  beforeEach(resetDb);

  it("starts for new contacts and sends a text with merge fields", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "send_sms", body: "Hi {{first_name|there}}, thanks for contacting {{business_name}}!" },
    ]);
    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    await createContact(db, ws.id, { firstName: "", lastName: "Doe", phone: "4155550102", consent }, alex.id);
    expect(await run()).toBe(2);
    expect(providers.sms.sent.map((m) => m.body).sort()).toEqual([
      "Hi Jane, thanks for contacting Acme Plumbing!",
      "Hi there, thanks for contacting Acme Plumbing!",
    ]);
    const [list] = await listWorkflows(db, ws.id);
    expect(list).toMatchObject({ inProgress: 0, finished: 2 });
    expect(await inWs(ws.id, (tx) => tx.select().from(workflowQueue))).toEqual([]);
  });

  it("does nothing while turned off, and only lets a contact in once unless allowed", async () => {
    const { alex, ws, providers, run } = await setup();
    const wf = await workflow(ws.id, alex.id, { type: "tag_added", tag: "VIP" }, [{ id: "a", type: "add_note", body: "VIP!" }], { enabled: false });
    const c = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", tags: ["vip"] }, alex.id);
    expect(await run()).toBe(0);

    await setWorkflowEnabled(db, ws.id, wf.id, true);
    await updateContact(db, ws.id, c.id, { firstName: "Jane", phone: "4155550101", tags: [] });
    await updateContact(db, ws.id, c.id, { firstName: "Jane", phone: "4155550101", tags: ["vip"] });
    await updateContact(db, ws.id, c.id, { firstName: "Jane", phone: "4155550101", tags: [] });
    await updateContact(db, ws.id, c.id, { firstName: "Jane", phone: "4155550101", tags: ["VIP"] });
    expect(await run()).toBe(1);
    expect(providers.sms.sent).toEqual([]);
    const notes = await inWs(ws.id, (tx) => tx.select().from(activities).where(eq(activities.kind, "note")));
    expect(notes.map((n) => n.body)).toEqual(["VIP!"]);
  });

  it("matches text keywords as whole words", async () => {
    const { alex, ws, run } = await setup();
    await workflow(ws.id, alex.id, { type: "sms_received", keyword: "quote" }, [{ id: "a", type: "add_tag", tag: "wants quote" }]);
    await receiveSms(db, { from: "+14155550101", to: NUMBER, body: "Can I get a QUOTE?" });
    await receiveSms(db, { from: "+14155550102", to: NUMBER, body: "Thanks for the quotes" });
    await run();
    const runs = await inWs(ws.id, (tx) => tx.select().from(workflowRuns));
    expect(runs).toHaveLength(1);
    const c = await getContact(db, ws.id, runs[0].contactId);
    expect(c?.contact.tags).toEqual(["wants quote"]);
  });

  it("starts on deal stage moves and won deals", async () => {
    const { alex, ws, run } = await setup();
    const [pipeline] = await listPipelines(db, ws.id);
    const stages = await inWs(ws.id, (tx) => tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id)).orderBy(pipelineStages.position));
    await workflow(ws.id, alex.id, { type: "deal_stage_changed", stageId: stages[1].id }, [{ id: "a", type: "add_tag", tag: "quoted" }]);
    await workflow(ws.id, alex.id, { type: "deal_status_changed", status: "won" }, [{ id: "a", type: "add_tag", tag: "customer" }]);
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "jane@example.com" }, alex.id);
    const deal = await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: stages[0].id, title: "Water heater", valueCents: 0, contactId: c.id }, alex.id);
    await run();
    expect((await getContact(db, ws.id, c.id))?.contact.tags).toEqual([]);
    await moveDeal(db, ws.id, deal.id, stages[1].id, 0, alex.id);
    await updateDeal(db, ws.id, deal.id, { status: "won" });
    await run();
    expect((await getContact(db, ws.id, c.id))?.contact.tags.sort()).toEqual(["customer", "quoted"]);
  });

  it("lets one workflow start another by adding a tag", async () => {
    const { alex, ws, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [{ id: "a", type: "add_tag", tag: "lead" }]);
    await workflow(ws.id, alex.id, { type: "tag_added", tag: "lead" }, [{ id: "a", type: "add_note", body: "Lead workflow ran" }]);
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "jane@example.com" }, alex.id);
    await run();
    await run();
    const notes = await inWs(ws.id, (tx) => tx.select().from(activities).where(eq(activities.contactId, c.id)));
    expect(notes.some((n) => n.body === "Lead workflow ran")).toBe(true);
  });

  it("adds contacts by hand even while off, but not twice at once", async () => {
    const { alex, ws, run } = await setup();
    const wf = await workflow(ws.id, alex.id, { type: "manual" }, [{ id: "a", type: "wait", amount: 1, unit: "days" }], { enabled: false });
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "jane@example.com" }, alex.id);
    await enrollByHand(db, ws.id, wf.id, c.id);
    await expect(enrollByHand(db, ws.id, wf.id, c.id)).rejects.toThrow(WorkflowError);
    await run();
    expect(await stopAllRuns(db, ws.id, wf.id)).toBe(1);
    await enrollByHand(db, ws.id, wf.id, c.id);
  });
});

describe("running steps", () => {
  beforeEach(resetDb);

  it("waits, then carries on when the time comes", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "send_sms", body: "Welcome" },
      { id: "b", type: "wait", amount: 2, unit: "days" },
      { id: "c", type: "send_sms", body: "Checking in" },
    ]);
    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    const start = new Date();
    await run(start);
    expect(providers.sms.sent.map((m) => m.body)).toEqual(["Welcome"]);
    expect((await inWs(ws.id, (tx) => tx.select().from(workflowRuns)))[0].status).toBe("waiting");

    expect(await run(new Date(start.getTime() + 47 * hour))).toBe(0);
    await run(new Date(start.getTime() + 49 * hour));
    expect(providers.sms.sent.map((m) => m.body)).toEqual(["Welcome", "Checking in"]);
    const [r] = await inWs(ws.id, (tx) => tx.select().from(workflowRuns));
    expect(r.status).toBe("completed");
    const [{ logs }] = await listRuns(db, ws.id, r.workflowId);
    expect(logs.map((l) => l.outcome)).toEqual([
      "Started: New contact",
      "Sent text",
      expect.stringMatching(/^Waiting until /),
      "Sent text",
    ]);
  });

  it("follows the yes or no branch, then rejoins", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      {
        id: "if",
        type: "if",
        condition: { type: "text_consent" },
        then: [{ id: "t", type: "send_sms", body: "Text hello" }],
        else: [{ id: "e", type: "send_email", subject: "Hello", body: "Email hello {{first_name}}" }],
      },
      { id: "after", type: "add_tag", tag: "welcomed" },
    ]);
    const texter = await createContact(db, ws.id, { firstName: "Tex", phone: "4155550101", consent }, alex.id);
    const emailer = await createContact(db, ws.id, { firstName: "Em", email: "em@example.com" }, alex.id);
    await run();
    expect(providers.sms.sent.map((m) => m.body)).toEqual(["Text hello"]);
    expect(providers.email.sent.map((m) => m.text)).toEqual(["Email hello Em"]);
    for (const c of [texter, emailer]) expect((await getContact(db, ws.id, c.id))?.contact.tags).toEqual(["welcomed"]);
  });

  it("stops when the contact replies", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "send_sms", body: "Want a quote?" },
      { id: "b", type: "wait", amount: 1, unit: "days" },
      { id: "c", type: "send_sms", body: "Just following up" },
    ]);
    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    const start = new Date();
    await run(start);
    await receiveSms(db, { from: "+14155550101", to: NUMBER, body: "Yes please" });
    await run(new Date(start.getTime() + 25 * hour));
    expect(providers.sms.sent.map((m) => m.body)).toEqual(["Want a quote?"]);
    const [r] = await inWs(ws.id, (tx) => tx.select().from(workflowRuns));
    expect(r).toMatchObject({ status: "stopped", note: "Contact replied" });
  });

  it("skips texts to contacts without consent instead of failing the run", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "send_sms", body: "Hi" },
      { id: "b", type: "add_tag", tag: "done" },
    ]);
    const c = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    await run();
    expect(providers.sms.sent).toEqual([]);
    const [r] = await inWs(ws.id, (tx) => tx.select().from(workflowRuns));
    expect(r.status).toBe("completed");
    const [{ logs }] = await listRuns(db, ws.id, r.workflowId);
    expect(logs[1].outcome).toMatch(/^Skipped: No text consent/);
    expect((await getContact(db, ws.id, c.id))?.contact.tags).toEqual(["done"]);
  });

  it("sends appointment reminders, and skips them if the appointment is canceled", async () => {
    const { alex, ws, providers, run } = await setup();
    await workflow(ws.id, alex.id, { type: "appointment_booked" }, [
      { id: "a", type: "wait_until_appointment", hoursBefore: 24 },
      {
        id: "if",
        type: "if",
        condition: { type: "has_upcoming_appointment" },
        then: [{ id: "b", type: "send_sms", body: "See you {{appointment_time}}" }],
        else: [],
      },
    ]);
    const now = new Date();
    const jane = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    const bob = await createContact(db, ws.id, { firstName: "Bob", phone: "4155550102", consent }, alex.id);
    const start = new Date(now.getTime() + 72 * hour);
    await createAppointment(db, ws.id, { contactId: jane.id, start, durationMinutes: 30, title: "Visit" }, alex.id, noCalendars);
    const bobs = await createAppointment(db, ws.id, { contactId: bob.id, start, durationMinutes: 30, title: "Visit" }, alex.id, noCalendars);
    await run(now);
    expect(providers.sms.sent).toEqual([]);

    await cancelAppointment(db, ws.id, bobs.id, alex.id, noCalendars);
    await run(new Date(start.getTime() - 23 * hour));
    expect(providers.sms.sent.map((m) => m.to)).toEqual(["+14155550101"]);
    expect(providers.sms.sent[0].body).toMatch(/^See you \w{3}, \w{3} \d+ at \d+:\d\d [AP]M$/);
  });

  it("creates deals and to-dos for the workflow's owner", async () => {
    const { alex, ws, run } = await setup();
    const [pipeline] = await listPipelines(db, ws.id);
    const [stage] = await inWs(ws.id, (tx) => tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id)).orderBy(pipelineStages.position));
    await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "create_deal", pipelineId: pipeline.id, stageId: stage.id, title: "{{full_name}} job", value: 250 },
      { id: "b", type: "create_todo", title: "Call {{first_name}}", dueInDays: 1 },
    ]);
    await createContact(db, ws.id, { firstName: "Jane", lastName: "Doe", email: "jane@example.com" }, alex.id);
    await run();
    const [deal] = await inWs(ws.id, (tx) => tx.select().from(deals));
    expect(deal).toMatchObject({ title: "Jane Doe job", valueCents: 25000 });
    const [todo] = await db.select().from(todos);
    expect(todo).toMatchObject({ title: "Call Jane", userId: alex.id, workspaceId: ws.id });
  });

  it("posts contact data to another app", async () => {
    const { alex, ws, providers } = await setup();
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await workflow(ws.id, alex.id, { type: "contact_created" }, [{ id: "a", type: "webhook", url: "https://hooks.example.com/x" }]);
    await createContact(db, ws.id, { firstName: "Jane", email: "jane@example.com" }, alex.id);
    await runDueWorkflows(db, { providers, fetch: fakeFetch });
    expect(calls).toEqual([
      { url: "https://hooks.example.com/x", body: expect.objectContaining({ contact: expect.objectContaining({ first_name: "Jane", email: "jane@example.com" }) }) },
    ]);
  });

  it("ends a contact's run cleanly when their next step was deleted", async () => {
    const { alex, ws, providers, run } = await setup();
    const wf = await workflow(ws.id, alex.id, { type: "contact_created" }, [
      { id: "a", type: "wait", amount: 1, unit: "hours" },
      { id: "b", type: "send_sms", body: "Hi" },
    ]);
    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    const start = new Date();
    await run(start);
    await saveWorkflow(db, ws.id, wf.id, { ...wf, steps: [{ id: "a", type: "wait", amount: 1, unit: "hours" }] });
    await run(new Date(start.getTime() + 2 * hour));
    expect(providers.sms.sent).toEqual([]);
    expect((await inWs(ws.id, (tx) => tx.select().from(workflowRuns)))[0].status).toBe("completed");
  });
});

describe("data sent in from other apps", () => {
  beforeEach(resetDb);

  it("adds the contact and starts the workflow", async () => {
    const { alex, ws, providers, run } = await setup();
    const wf = await workflow(ws.id, alex.id, { type: "webhook" }, [
      { id: "a", type: "send_email", subject: "Got it", body: "Hi {{first_name}}, about your {{data.service|job}}" },
    ]);
    const res = await receiveWorkflowWebhook(db, ws.id, wf.hookToken, { name: "Jane Doe", email: "Jane@Example.com", service: "water heater" });
    expect(res).toMatchObject({ ok: true, started: true });
    await run();
    expect(providers.email.sent).toEqual([expect.objectContaining({ to: "jane@example.com", text: "Hi Jane, about your water heater" })]);

    expect(await receiveWorkflowWebhook(db, ws.id, "wrong", { email: "a@b.co" })).toMatchObject({ ok: false, status: 404 });
    expect(await receiveWorkflowWebhook(db, ws.id, wf.hookToken, { name: "No contact info" })).toMatchObject({ ok: false, status: 422 });
    await setWorkflowEnabled(db, ws.id, wf.id, false);
    expect(await receiveWorkflowWebhook(db, ws.id, wf.hookToken, { email: "a@b.co" })).toMatchObject({ ok: false, status: 409 });
  });

  it("can't reach another account's workflow", async () => {
    const { alex, ws } = await setup();
    const other = await makeWorkspace(alex.id, "Other");
    const wf = await workflow(ws.id, alex.id, { type: "webhook" }, [{ id: "a", type: "add_tag", tag: "x" }]);
    expect(await receiveWorkflowWebhook(db, other.id, wf.hookToken, { email: "a@b.co" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("saving", () => {
  beforeEach(resetDb);

  it("refuses unfinished steps and empty workflows", async () => {
    const { alex, ws } = await setup();
    const wf = await createWorkflow(db, ws.id, { name: "New", trigger: { type: "manual" } }, alex.id);
    const base = { name: "New", enabled: false, trigger: { type: "manual" }, stopOnReply: true, allowReentry: false };
    await expect(saveWorkflow(db, ws.id, wf.id, { ...base, enabled: true, steps: [] })).rejects.toThrow(/at least one step/);
    await expect(saveWorkflow(db, ws.id, wf.id, { ...base, steps: [{ id: "a", type: "send_sms", body: " " }] })).rejects.toThrow(/text can't be empty/);
    await expect(
      saveWorkflow(db, ws.id, wf.id, { ...base, steps: [{ id: "a", type: "add_tag", tag: "x" }, { id: "a", type: "add_tag", tag: "y" }] }),
    ).rejects.toThrow(/share an id/);
    await expect(saveWorkflow(db, ws.id, wf.id, { ...base, steps: [{ id: "a", type: "webhook", url: "http://insecure.example.com" }] })).rejects.toThrow(/https/);
  });
});

describe("helpers", () => {
  it("fills merge fields with fallbacks", () => {
    expect(fillTemplate("Hi {{ first_name | there }}! {{unknown}}", { first_name: "" })).toBe("Hi there! ");
    expect(fillTemplate("{{FIRST_NAME}}", { first_name: "Jane" })).toBe("Jane");
  });

  it("finds the step after the end of a branch", () => {
    const steps: WorkflowStep[] = [
      { id: "if", type: "if", condition: { type: "has_email" }, then: [{ id: "t1", type: "add_tag", tag: "a" }], else: [] },
      { id: "z", type: "add_tag", tag: "b" },
    ];
    expect(stepAfter(steps, "t1")).toBe("z");
    expect(stepAfter(steps, "z")).toBeNull();
  });
});
