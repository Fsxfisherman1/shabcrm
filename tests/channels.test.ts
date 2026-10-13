import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaces } from "@/db/schema";
import { createContact, getContact } from "@/server/contacts";
import {
  getConversation,
  listConversations,
  receivePhoneMessage,
  sendMessage,
  updateIMessageStatus,
  whatsappPermission,
} from "@/server/messaging";
import { statusToken } from "@/server/messaging/config";
import { TestEmail, TestSms } from "@/server/messaging/providers";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

vi.mock("server-only", () => ({}));

const APP = "https://crm.example.com";
const SMS = "+14155550000";
const WHATSAPP = "+14155550111";
const IMESSAGE = "+14155550122";
const SECRET = "sb-secret";

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_URL", APP);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
  vi.stubEnv("SENDBLUE_API_KEY", "key");
  vi.stubEnv("SENDBLUE_API_SECRET", "secret");
  vi.stubEnv("SENDBLUE_WEBHOOK_SECRET", SECRET);
});
afterAll(() => vi.unstubAllEnvs());

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  await db.update(workspaces).set({ smsNumber: SMS, whatsappNumber: WHATSAPP, imessageNumber: IMESSAGE }).where(eq(workspaces.id, ws.id));
  const providers = { sms: new TestSms(), email: new TestEmail(), whatsapp: new TestSms(), imessage: new TestSms() };
  return { alex, ws, providers };
}

describe("WhatsApp and iMessage", () => {
  beforeEach(resetDb);

  it("files each channel's messages under the right account and contact", async () => {
    const { ws } = await setup();
    await receivePhoneMessage(db, { channel: "whatsapp", from: "+14155550177", to: WHATSAPP, body: "Hola" });
    await receivePhoneMessage(db, { channel: "imessage", from: "(415) 555-0177", to: IMESSAGE, body: "Also me" });
    // A WhatsApp message to the texting number isn't ours.
    expect(await receivePhoneMessage(db, { channel: "whatsapp", from: "+14155550177", to: SMS, body: "?" })).toBeNull();

    const [row] = await listConversations(db, ws.id);
    expect(row).toMatchObject({ channel: "imessage", body: "Also me", unread: 2 });
    expect(await listConversations(db, ws.id, { channel: "whatsapp" })).toMatchObject([{ body: "Hola" }]);
    expect(await listConversations(db, ws.id, { channel: "email" })).toHaveLength(0);
    const full = await getContact(db, ws.id, row.contact_id);
    expect(full?.contact.source).toBe("WhatsApp");
  });

  it("replies on WhatsApp only within 24 hours of their last WhatsApp message", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(
      db,
      ws.id,
      { firstName: "Ana", phone: "4155550177", consent: { smsConsent: "granted", smsConsentSource: "Form" } },
      alex.id,
    );
    // Text consent doesn't open WhatsApp.
    await expect(sendMessage(db, ws.id, { contactId: c.id, channel: "whatsapp", body: "Hi" }, alex.id, providers)).rejects.toThrow(
      /within 24 hours/,
    );
    await receivePhoneMessage(db, { channel: "whatsapp", from: "+14155550177", to: WHATSAPP, body: "Hi there" });
    const msg = await sendMessage(db, ws.id, { contactId: c.id, channel: "whatsapp", body: "Hello Ana" }, alex.id, providers);
    expect(msg).toMatchObject({ status: "sent", fromAddress: WHATSAPP, toAddress: "+14155550177" });
    expect(providers.whatsapp.sent).toMatchObject([{ from: WHATSAPP, to: "+14155550177", body: "Hello Ana" }]);
    expect(providers.sms.sent).toHaveLength(0);

    const contact = (await getConversation(db, ws.id, c.id))!.contact;
    const day = 24 * 60 * 60 * 1000;
    expect(whatsappPermission(contact, { at: new Date(Date.now() - day - 1000), body: "Hi" }).allowed).toBe(false);
    expect(whatsappPermission(contact, { at: new Date(), body: "STOP" }).allowed).toBe(false);
  });

  it("treats iMessage like texting: consent, the reply window, and STOP", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Ben", phone: "4155550188" }, alex.id);
    await expect(sendMessage(db, ws.id, { contactId: c.id, channel: "imessage", body: "Hi" }, alex.id, providers)).rejects.toThrow(
      /No text consent/,
    );
    // An iMessage from them opens the reply window for texts too.
    await receivePhoneMessage(db, { channel: "imessage", from: "+14155550188", to: IMESSAGE, body: "Are you open?" });
    const reply = await sendMessage(db, ws.id, { contactId: c.id, channel: "imessage", body: "Yes!" }, alex.id, providers, { appUrl: APP });
    expect(reply.status).toBe("sent");
    expect(providers.imessage.sent[0].statusCallback).toBe(`${APP}/api/webhooks/sendblue/status?w=${ws.id}&t=${statusToken(ws.id)}`);
    expect((await getConversation(db, ws.id, c.id))!.permissions.sms.allowed).toBe(true);

    await receivePhoneMessage(db, { channel: "imessage", from: "+14155550188", to: IMESSAGE, body: "STOP" });
    const convo = (await getConversation(db, ws.id, c.id))!;
    expect(convo.contact.smsConsent).toBe("revoked");
    expect(convo.permissions.imessage.allowed).toBe(false);
    expect(convo.permissions.sms.allowed).toBe(false);

    await updateIMessageStatus(db, ws.id, reply.providerId!, "DELIVERED");
    expect((await getConversation(db, ws.id, c.id))!.messages.find((m) => m.id === reply.id)?.status).toBe("delivered");
  });

  it("asks for a number before sending on a channel the account hasn't set up", async () => {
    const { alex, ws, providers } = await setup();
    await db.update(workspaces).set({ imessageNumber: null }).where(eq(workspaces.id, ws.id));
    const c = await createContact(
      db,
      ws.id,
      { firstName: "Ana", phone: "4155550177", consent: { smsConsent: "granted", smsConsentSource: "Form" } },
      alex.id,
    );
    await expect(sendMessage(db, ws.id, { contactId: c.id, channel: "imessage", body: "Hi" }, alex.id, providers)).rejects.toThrow(
      /Set up an iMessage number/,
    );
  });
});

describe("channel webhooks", () => {
  beforeEach(resetDb);

  function twilio(params: Record<string, string>) {
    const url = `${APP}/api/webhooks/twilio/sms`;
    const data = Object.keys(params)
      .sort()
      .reduce((acc, k) => acc + k + params[k], url);
    const signature = createHmac("sha1", "twilio-token").update(data).digest("base64");
    return new Request("http://internal/api/webhooks/twilio/sms", {
      method: "POST",
      headers: { "x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  }

  it("takes WhatsApp messages from Twilio's text webhook", async () => {
    const { ws } = await setup();
    const { POST } = await import("@/app/api/webhooks/twilio/sms/route");
    const res = await POST(twilio({ From: "whatsapp:+14155550177", To: `whatsapp:${WHATSAPP}`, Body: "Hola", MessageSid: "SMw1" }));
    expect(res.status).toBe(200);
    expect(await listConversations(db, ws.id)).toMatchObject([{ channel: "whatsapp", body: "Hola", phone: "+14155550177" }]);
  });

  it("takes iMessages from Sendblue only with the right secret", async () => {
    const { ws } = await setup();
    const { POST } = await import("@/app/api/webhooks/sendblue/route");
    const body = { content: "Hi from my iPhone", is_outbound: false, from_number: "+14155550177", to_number: IMESSAGE, message_handle: "h1" };
    const req = (secret: string, payload: object = body) =>
      new Request(`${APP}/api/webhooks/sendblue`, {
        method: "POST",
        headers: { "content-type": "application/json", "sb-signing-secret": secret },
        body: JSON.stringify(payload),
      });

    expect((await POST(req("nope"))).status).toBe(403);
    expect(await listConversations(db, ws.id)).toHaveLength(0);
    expect((await POST(req(SECRET))).status).toBe(204);
    expect((await POST(req(SECRET))).status).toBe(204); // retried: kept once
    expect((await POST(req(SECRET, { ...body, is_outbound: true, message_handle: "h2" }))).status).toBe(204);
    expect(await listConversations(db, ws.id)).toMatchObject([{ channel: "imessage", body: "Hi from my iPhone", unread: 1 }]);
  });

  it("checks the token on Sendblue delivery updates", async () => {
    const { ws } = await setup();
    const { POST } = await import("@/app/api/webhooks/sendblue/status/route");
    const req = (t: string) =>
      new Request(`${APP}/api/webhooks/sendblue/status?w=${ws.id}&t=${t}`, {
        method: "POST",
        body: JSON.stringify({ message_handle: "x", status: "DELIVERED" }),
      });
    expect((await POST(req("wrong"))).status).toBe(403);
    expect((await POST(req(statusToken(ws.id)))).status).toBe(204);
  });
});
