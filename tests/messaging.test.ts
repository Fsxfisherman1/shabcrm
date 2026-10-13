import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { workspaces } from "@/db/schema";
import { createContact, getContact, setSmsConsent } from "@/server/contacts";
import {
  getConversation,
  handleCallEnded,
  listConversations,
  markConversationRead,
  MessagingError,
  receiveEmail,
  receiveSms,
  sendMessage,
  unreadCount,
  updateSmsStatus,
} from "@/server/messaging";
import { TestEmail, TestSms, validateTwilioSignature } from "@/server/messaging/providers";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

const NUMBER = "+14155550000";

async function setup(number = NUMBER) {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  await db
    .update(workspaces)
    .set({ smsNumber: number, emailFromAddress: "hello@acme.test", emailFromName: "Acme Plumbing", forwardCallsTo: "+14155559999" })
    .where(eq(workspaces.id, ws.id));
  const providers = { sms: new TestSms(), email: new TestEmail() };
  return { alex, ws, providers };
}

describe("sending", () => {
  beforeEach(resetDb);

  it("texts contacts with consent and records the message", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(
      db,
      ws.id,
      { firstName: "Jane", phone: "4155550101", consent: { smsConsent: "granted", smsConsentSource: "Form" } },
      alex.id,
    );
    const msg = await sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi Jane" }, alex.id, providers);
    expect(msg.status).toBe("sent");
    expect(providers.sms.sent).toEqual([{ from: NUMBER, to: "+14155550101", body: "Hi Jane", statusCallback: undefined }]);
  });

  it("refuses to text without consent, and never texts someone who opted out", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    await expect(
      sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi" }, alex.id, providers),
    ).rejects.toThrow(/No text consent/);

    // Once they text us, we can reply...
    await receiveSms(db, { from: "+14155550101", to: NUMBER, body: "Do you do water heaters?" });
    await sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Yes we do!" }, alex.id, providers);

    // ...but not after they opt out.
    await setSmsConsent(db, ws.id, c.id, { smsConsent: "revoked" }, alex.id);
    await expect(
      sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi" }, alex.id, providers),
    ).rejects.toThrow(/opted out/);
    expect(providers.sms.sent).toHaveLength(1);
  });

  it("emails contacts and passes the reply-to address", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "jane@x.com" }, alex.id);
    await expect(
      sendMessage(db, ws.id, { contactId: c.id, channel: "email", body: "Hello" }, alex.id, providers),
    ).rejects.toBeInstanceOf(MessagingError);
    await sendMessage(
      db,
      ws.id,
      { contactId: c.id, channel: "email", subject: "Your quote", body: "Hello" },
      alex.id,
      providers,
      { replyTo: "in+abc@inbound.test" },
    );
    expect(providers.email.sent[0]).toMatchObject({
      from: "hello@acme.test",
      fromName: "Acme Plumbing",
      to: "jane@x.com",
      subject: "Your quote",
      replyTo: "in+abc@inbound.test",
    });
  });

  it("records provider failures and carrier delivery updates", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(
      db,
      ws.id,
      { phone: "4155550101", consent: { smsConsent: "granted", smsConsentSource: "Form" } },
      alex.id,
    );
    providers.sms.failNext = "Invalid number";
    const failed = await sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi" }, alex.id, providers);
    expect(failed).toMatchObject({ status: "failed", error: "Invalid number" });

    const ok = await sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi" }, alex.id, providers);
    await updateSmsStatus(db, ws.id, ok.providerId!, "delivered");
    const convo = await getConversation(db, ws.id, c.id);
    expect(convo!.messages.map((m) => m.status)).toEqual(["failed", "delivered"]);
  });
});

describe("receiving", () => {
  beforeEach(resetDb);

  it("routes texts by number, creates unknown senders, and tracks unread", async () => {
    const { ws } = await setup();
    const other = await setup("+14155550001");
    const res = await receiveSms(db, { from: "(415) 555-0177", to: NUMBER, body: "Hi there", providerId: "SM1" });
    expect(res).toMatchObject({ workspaceId: ws.id, optedOut: false });
    // Twilio retries are ignored.
    expect(await receiveSms(db, { from: "4155550177", to: NUMBER, body: "Hi there", providerId: "SM1" })).toBeNull();
    // Unknown numbers go nowhere.
    expect(await receiveSms(db, { from: "4155550177", to: "+15550000000", body: "?" })).toBeNull();

    const convos = await listConversations(db, ws.id);
    expect(convos).toHaveLength(1);
    expect(convos[0]).toMatchObject({ phone: "+14155550177", body: "Hi there", unread: 1 });
    expect(await unreadCount(db, ws.id)).toBe(1);
    expect(await listConversations(db, other.ws.id)).toHaveLength(0);

    await markConversationRead(db, ws.id, res!.contactId);
    expect(await unreadCount(db, ws.id)).toBe(0);
  });

  it("handles STOP and START replies", async () => {
    const { alex, ws, providers } = await setup();
    const c = await createContact(
      db,
      ws.id,
      { phone: "4155550101", consent: { smsConsent: "granted", smsConsentSource: "Form" } },
      alex.id,
    );
    expect(await receiveSms(db, { from: "4155550101", to: NUMBER, body: " Stop " })).toMatchObject({ optedOut: true });
    let detail = await getContact(db, ws.id, c.id);
    expect(detail!.contact).toMatchObject({ smsConsent: "revoked", smsConsentSource: "Texted STOP" });
    await expect(
      sendMessage(db, ws.id, { contactId: c.id, channel: "sms", body: "Hi" }, alex.id, providers),
    ).rejects.toThrow(/opted out/);

    expect(await receiveSms(db, { from: "4155550101", to: NUMBER, body: "START" })).toMatchObject({ optedIn: true });
    detail = await getContact(db, ws.id, c.id);
    expect(detail!.contact.smsConsent).toBe("granted");
    expect(detail!.timeline[0].body).toBe("Opted back in to texts by replying START");
  });

  it("files inbound email under the right account and contact", async () => {
    const { alex, ws } = await setup();
    const c = await createContact(db, ws.id, { firstName: "Jane", email: "jane@x.com" }, alex.id);
    await receiveEmail(db, { workspaceId: ws.id, from: "JANE@x.com", subject: "Re: quote", text: "Sounds good" });
    const res = await receiveEmail(db, { workspaceId: ws.id, from: "new@y.com", fromName: "Sam Lee", subject: "", text: "Hi" });
    const convo = await getConversation(db, ws.id, c.id);
    expect(convo!.messages[0]).toMatchObject({ direction: "inbound", subject: "Re: quote", body: "Sounds good" });
    const sam = await getContact(db, ws.id, res!.contactId);
    expect(sam!.contact).toMatchObject({ firstName: "Sam", lastName: "Lee", email: "new@y.com" });
  });
});

describe("missed-call text-back", () => {
  beforeEach(resetDb);

  it("texts back missed callers when turned on", async () => {
    const { ws, providers } = await setup();
    expect(await handleCallEnded(db, { to: NUMBER, from: "4155550188", dialStatus: "completed" }, providers)).toEqual({ missed: false });

    // Off: logs the missed call only.
    expect(await handleCallEnded(db, { to: NUMBER, from: "4155550188", dialStatus: "no-answer" }, providers)).toEqual({
      missed: true,
      texted: false,
    });
    await db.update(workspaces).set({ missedCallTextEnabled: true }).where(eq(workspaces.id, ws.id));
    expect(await handleCallEnded(db, { to: NUMBER, from: "4155550188", dialStatus: "busy" }, providers)).toEqual({
      missed: true,
      texted: true,
    });
    expect(providers.sms.sent[0]).toMatchObject({ to: "+14155550188", body: expect.stringContaining("Sorry we missed your call") });
    const [convo] = await listConversations(db, ws.id);
    expect(convo.direction).toBe("outbound");
  });

  it("doesn't text back callers who opted out", async () => {
    const { alex, ws, providers } = await setup();
    await db.update(workspaces).set({ missedCallTextEnabled: true }).where(eq(workspaces.id, ws.id));
    const c = await createContact(db, ws.id, { phone: "4155550188" }, alex.id);
    await setSmsConsent(db, ws.id, c.id, { smsConsent: "revoked" }, alex.id);
    expect(await handleCallEnded(db, { to: NUMBER, from: "4155550188", dialStatus: "no-answer" }, providers)).toEqual({
      missed: true,
      texted: false,
    });
    expect(providers.sms.sent).toHaveLength(0);
  });
});

describe("Twilio signatures", () => {
  it("matches Twilio's documented algorithm", () => {
    const token = "12345";
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    const data = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("");
    const sig = createHmac("sha1", token).update(data).digest("base64");
    expect(validateTwilioSignature(token, sig, url, params)).toBe(true);
    expect(validateTwilioSignature(token, sig, url, { ...params, Digits: "9999" })).toBe(false);
    expect(validateTwilioSignature(token, null, url, params)).toBe(false);
  });
});
