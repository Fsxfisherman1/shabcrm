import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiQueue, aiSettings, messages, workflowRuns, workspaces, type WorkflowTrigger } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import {
  AiError,
  draftReply,
  getAiSettings,
  makeLlm,
  parseIntent,
  runAiQueue,
  saveAiSettings,
  type Llm,
  type LlmRequest,
} from "@/server/ai";
import { createAppointment } from "@/server/calendars";
import type { ProviderFactory } from "@/server/calendars/config";
import { createContact } from "@/server/contacts";
import { findWaitingLeads, sendLeadAlerts, updateLeadAlerts } from "@/server/lead-alerts";
import { receiveSms, sendMessage } from "@/server/messaging";
import { TestEmail, TestSms } from "@/server/messaging/providers";
import { createDeal, listPipelinesWithStages, updateDeal } from "@/server/pipelines";
import { createWorkflow, enrollByHand, saveWorkflow } from "@/server/workflows";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
});

const NUMBER = "+14155550000";
const MINUTE = 60_000;
const noCalendars: ProviderFactory = () => {
  throw new Error("no calendars in these tests");
};
const inWs = <T>(workspaceId: string, fn: Parameters<typeof withWorkspace<T>>[2]) => withWorkspace(db, workspaceId, fn);

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  await db.update(workspaces).set({ smsNumber: NUMBER, emailFromAddress: "hello@acme.test" }).where(eq(workspaces.id, ws.id));
  return { alex, ws };
}

async function workflow(workspaceId: string, userId: string, trigger: WorkflowTrigger, rules: { stopOnBooking?: boolean; stopOnWon?: boolean } = {}) {
  const wf = await createWorkflow(db, workspaceId, { name: "Follow-up", trigger }, userId);
  return saveWorkflow(db, workspaceId, wf.id, {
    name: "Follow-up",
    enabled: true,
    trigger,
    steps: [{ id: "w", type: "wait", amount: 2, unit: "days" }],
    stopOnReply: true,
    allowReentry: false,
    ...rules,
  });
}

const runStatus = async (workspaceId: string, workflowId: string) =>
  (await inWs(workspaceId, (tx) => tx.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)))).map((r) => r.status);

describe("stopping follow-ups", () => {
  beforeEach(resetDb);

  it("stops a contact's follow-ups when they book, if the workflow says so", async () => {
    const { alex, ws } = await setup();
    const jane = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    const stops = await workflow(ws.id, alex.id, { type: "manual" }, { stopOnBooking: true });
    const keeps = await workflow(ws.id, alex.id, { type: "manual" });
    await enrollByHand(db, ws.id, stops.id, jane.id);
    await enrollByHand(db, ws.id, keeps.id, jane.id);

    const start = new Date(Date.now() + 2 * 24 * 60 * MINUTE);
    await createAppointment(db, ws.id, { contactId: jane.id, start, durationMinutes: 30, title: "Cleaning" }, alex.id, noCalendars);
    expect(await runStatus(ws.id, stops.id)).toEqual(["stopped"]);
    expect(await runStatus(ws.id, keeps.id)).toEqual(["active"]);
  });

  it("stops sales follow-ups once a deal of theirs is won", async () => {
    const { alex, ws } = await setup();
    const jane = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    const wf = await workflow(ws.id, alex.id, { type: "manual" }, { stopOnWon: true });
    await enrollByHand(db, ws.id, wf.id, jane.id);
    const [pipeline] = await listPipelinesWithStages(db, ws.id);
    const deal = await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: pipeline.stages[0].id, title: "Implants", valueCents: 0, contactId: jane.id }, alex.id);

    await updateDeal(db, ws.id, deal.id, { status: "lost" });
    expect(await runStatus(ws.id, wf.id)).toEqual(["active"]);
    await updateDeal(db, ws.id, deal.id, { status: "won" });
    expect(await runStatus(ws.id, wf.id)).toEqual(["stopped"]);
  });
});

/** A stand-in model that records what it's asked and answers from a script. */
function fakeLlm(answer: (req: LlmRequest) => string) {
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    return answer(req);
  };
  return { llm, calls };
}

describe("AI", () => {
  beforeEach(resetDb);

  it("keeps the API key encrypted and never hands it back", async () => {
    const { ws } = await setup();
    await expect(saveAiSettings(db, ws.id, { provider: "anthropic", model: "claude-opus-5-5", tagMessages: true })).rejects.toThrow(/API key/);
    await saveAiSettings(db, ws.id, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-secret-1234", tagMessages: true });

    const [row] = await inWs(ws.id, (tx) => tx.select().from(aiSettings));
    expect(row.apiKey).not.toContain("sk-ant");
    const settings = await getAiSettings(db, ws.id);
    expect(settings).toMatchObject({ provider: "anthropic", hasKey: true, keyEnding: "1234" });
    expect(JSON.stringify(settings)).not.toContain("secret");

    // A blank key keeps the saved one; a different service needs its own.
    await saveAiSettings(db, ws.id, { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "", tagMessages: false });
    expect(await getAiSettings(db, ws.id)).toMatchObject({ model: "claude-sonnet-5-5", keyEnding: "1234", tagMessages: false });
    await expect(saveAiSettings(db, ws.id, { provider: "openai", model: "gpt-x", tagMessages: true })).rejects.toThrow(/API key/);
    // A local model may need no key, but needs an address.
    await expect(saveAiSettings(db, ws.id, { provider: "openai_compatible", model: "llama", tagMessages: true })).rejects.toThrow(/address/);
    await saveAiSettings(db, ws.id, { provider: "openai_compatible", model: "llama", baseUrl: "http://localhost:11434/v1", tagMessages: true });
    expect(await getAiSettings(db, ws.id)).toMatchObject({ provider: "openai_compatible", hasKey: false });
  });

  it("tags incoming messages and starts workflows waiting for that tag", async () => {
    const { alex, ws } = await setup();
    const wf = await workflow(ws.id, alex.id, { type: "intent_detected", intent: "pricing" });

    // Without AI connected, nothing is queued.
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hello?" });
    expect(await db.select().from(aiQueue)).toHaveLength(0);

    await saveAiSettings(db, ws.id, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-x", tagMessages: true });
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "How much is a cleaning without insurance?" });
    await receiveSms(db, { from: "+14155550199", to: NUMBER, body: "STOP" }); // opt-outs aren't sent to the AI
    expect(await db.select().from(aiQueue)).toHaveLength(1);

    const { llm, calls } = fakeLlm(() => "pricing");
    expect(await runAiQueue(db, () => llm)).toBe(1);
    expect(await db.select().from(aiQueue)).toHaveLength(0);
    expect(calls[0].prompt).toContain("How much is a cleaning");
    expect(calls[0].prompt).toContain("Hello?"); // the message before it, for context
    expect(calls[0].quick).toBe(true);

    const tagged = await inWs(ws.id, (tx) => tx.select().from(messages).where(eq(messages.body, "How much is a cleaning without insurance?")));
    expect(tagged[0].intent).toBe("pricing");
    expect(await runStatus(ws.id, wf.id)).toEqual(["active"]);
  });

  it("gives up on a message after three failed tries", async () => {
    const { ws } = await setup();
    await saveAiSettings(db, ws.id, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-x", tagMessages: true });
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hi" });
    const broken: Llm = async () => {
      throw new AiError("down");
    };
    const later = (min: number) => new Date(Date.now() + min * MINUTE);
    await runAiQueue(db, () => broken, later(0));
    await runAiQueue(db, () => broken, later(10));
    expect(await db.select().from(aiQueue)).toHaveLength(1);
    await runAiQueue(db, () => broken, later(20));
    expect(await db.select().from(aiQueue)).toHaveLength(0);
  });

  it("reads the label out of the model's answer", () => {
    expect(parseIntent("wants_to_book")).toBe("wants_to_book");
    expect(parseIntent("Label: reschedule.")).toBe("reschedule");
    expect(parseIntent("none")).toBeNull();
    expect(parseIntent("I think this is spam")).toBeNull();
  });

  it("drafts a reply from the conversation and the notes about the business", async () => {
    const { ws } = await setup();
    await saveAiSettings(db, ws.id, {
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-x",
      about: "Open Mon-Fri 8-5. Cleanings are $120.",
      tagMessages: false,
    });
    const r = await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Are you open Saturday?" });
    const { llm, calls } = fakeLlm(() => "  Sorry, we're closed weekends. Want a Friday slot?  ");

    expect(await draftReply(db, ws.id, r!.contactId, "sms", llm)).toBe("Sorry, we're closed weekends. Want a Friday slot?");
    expect(calls[0].system).toContain("Cleanings are $120");
    expect(calls[0].system).toContain("text message");
    expect(calls[0].prompt).toContain("Are you open Saturday?");
    // Nothing was sent.
    const sent = await inWs(ws.id, (tx) => tx.select().from(messages).where(eq(messages.direction, "outbound")));
    expect(sent).toHaveLength(0);
  });
});

describe("talking to each AI service", () => {
  function fakeFetch(reply: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = input instanceof Request ? Object.fromEntries(input.headers) : init?.headers;
      const body = input instanceof Request ? await input.text() : init?.body;
      calls.push({ url, init: { ...init, headers, body } });
      return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { impl, calls };
  }
  const req = { system: "Be brief.", prompt: "Say hi", maxTokens: 100 };
  const headerOf = (init: RequestInit, name: string) => {
    const h = init.headers;
    if (h instanceof Headers) return h.get(name);
    return Object.entries((h ?? {}) as Record<string, string>).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  };

  it("Claude, with Anthropic's fallback on for models that support it", async () => {
    const { impl, calls } = fakeFetch({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "Hi!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const llm = makeLlm({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-x", baseUrl: null }, impl);
    expect(await llm({ ...req, quick: true })).toBe("Hi!");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(headerOf(calls[0].init, "x-api-key")).toBe("sk-ant-x");
    expect(headerOf(calls[0].init, "anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      model: "claude-opus-5-5",
      system: "Be brief.",
      max_tokens: 100,
      fallbacks: "default",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Say hi" }],
    });
  });

  it("OpenAI and compatible services", async () => {
    const { impl, calls } = fakeFetch({ choices: [{ message: { content: "Hi!" } }] });
    expect(await makeLlm({ provider: "openai", model: "gpt-x", apiKey: "sk-1", baseUrl: null }, impl)(req)).toBe("Hi!");
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headerOf(calls[0].init, "authorization")).toBe("Bearer sk-1");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: "gpt-x", max_completion_tokens: 100, messages: [{ role: "system" }, { role: "user" }] });

    await makeLlm({ provider: "openai_compatible", model: "llama3", apiKey: null, baseUrl: "http://localhost:11434/v1/" }, impl)(req);
    expect(calls[1].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headerOf(calls[1].init, "authorization")).toBeNull();
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ max_tokens: 100 });
  });

  it("Gemini", async () => {
    const { impl, calls } = fakeFetch({ candidates: [{ content: { parts: [{ text: "Hi" }, { text: "!" }] } }] });
    expect(await makeLlm({ provider: "gemini", model: "gemini-x", apiKey: "g-1", baseUrl: null }, impl)(req)).toBe("Hi!");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(headerOf(calls[0].init, "x-goog-api-key")).toBe("g-1");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ systemInstruction: { parts: [{ text: "Be brief." }] } });
  });

  it("explains a rejected key plainly", async () => {
    const { impl } = fakeFetch({ error: { message: "bad key" } }, 401);
    await expect(makeLlm({ provider: "openai", model: "gpt-x", apiKey: "nope", baseUrl: null }, impl)(req)).rejects.toThrow("OpenAI didn't accept the API key.");
  });
});

describe("speed-to-lead alerts", () => {
  beforeEach(resetDb);

  async function alertsSetup() {
    const { alex, ws } = await setup();
    await updateLeadAlerts(db, ws.id, { minutes: 15, email: "alex@agency.test", phone: "(415) 555-0177" });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    const providers = { sms: new TestSms(), email: new TestEmail() };
    const deps = { providers, appUrl: "https://crm.example.com" };
    const later = (min: number) => new Date(Date.now() + min * MINUTE);
    return { alex, ws, workspace, providers, deps, later };
  }

  it("alerts once when a lead waits past the limit, by email and text", async () => {
    const { ws, providers, deps, later } = await alertsSetup();
    const r = await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Can someone come today? Water everywhere" });

    expect(await sendLeadAlerts(db, deps, later(10))).toBe(0); // not yet
    expect(await sendLeadAlerts(db, deps, later(16))).toBe(1);
    expect(providers.sms.sent).toMatchObject([{ from: NUMBER, to: "+14155550177" }]);
    expect(providers.sms.sent[0].body).toContain("Water everywhere");
    expect(providers.sms.sent[0].body).toContain(`/w/${ws.id}/inbox?c=${r!.contactId}`);
    expect(providers.email.sent).toMatchObject([{ to: "alex@agency.test", from: "hello@acme.test" }]);

    // A second message in the same wait doesn't alert again.
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hello??" });
    expect(await sendLeadAlerts(db, deps, later(17))).toBe(0);
    expect(await sendLeadAlerts(db, deps, later(40))).toBe(0);
  });

  it("doesn't alert when a person answered in time, but automations don't count", async () => {
    const { alex, ws, workspace, later } = await alertsSetup();
    const consent = { smsConsent: "granted" as const, smsConsentSource: "Form" };
    const jane = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101", consent }, alex.id);
    const bob = await createContact(db, ws.id, { firstName: "Bob", phone: "4155550102", consent }, alex.id);
    await receiveSms(db, { from: "+14155550101", to: NUMBER, body: "Question" });
    await receiveSms(db, { from: "+14155550102", to: NUMBER, body: "Question" });
    const providers = { sms: new TestSms(), email: new TestEmail() };
    await sendMessage(db, ws.id, { contactId: jane.id, channel: "sms", body: "On it!" }, alex.id, providers);
    await sendMessage(db, ws.id, { contactId: bob.id, channel: "sms", body: "Auto-reply" }, null, providers);

    const waiting = await findWaitingLeads(db, workspace, later(20));
    expect(waiting.map((w) => w.name)).toEqual(["Bob"]);
    // STOP needs no answer.
    await receiveSms(db, { from: "+14155550103", to: NUMBER, body: "STOP" });
    expect((await findWaitingLeads(db, workspace, later(20))).map((w) => w.name)).toEqual(["Bob"]);
  });

  it("checks the settings", async () => {
    const { ws } = await setup();
    await expect(updateLeadAlerts(db, ws.id, { minutes: 15, email: null, phone: null })).rejects.toThrow(/email or phone/);
    await expect(updateLeadAlerts(db, ws.id, { minutes: 0, email: "a@b.co", phone: null })).rejects.toThrow(/minutes/);
    await expect(updateLeadAlerts(db, ws.id, { minutes: 15, email: null, phone: "123" })).rejects.toThrow(/phone/);
    await updateLeadAlerts(db, ws.id, { minutes: null, email: null, phone: null }); // off
  });
});
