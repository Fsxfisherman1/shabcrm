import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaces } from "@/db/schema";
import { getConversation, listConversations } from "@/server/messaging";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

vi.mock("server-only", () => ({}));

const APP = "https://crm.example.com";
const TOKEN = "twilio-token";
const NUMBER = "+14155550000";

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_URL", APP);
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("POSTMARK_INBOUND_SECRET", "pm-secret");
});
afterAll(() => vi.unstubAllEnvs());

function twilioRequest(path: string, params: Record<string, string>, { sign = true } = {}) {
  const url = `${APP}${path}`;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const signature = createHmac("sha1", sign ? TOKEN : "wrong").update(data).digest("base64");
  // The app may see a different host behind a proxy; only the path matters.
  return new Request(`http://internal:3000${path}`, {
    method: "POST",
    headers: { "x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function setup() {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  await db.update(workspaces).set({ smsNumber: NUMBER, missedCallTextEnabled: false }).where(eq(workspaces.id, ws.id));
  return ws;
}

describe("webhooks", () => {
  beforeEach(resetDb);

  it("accepts signed Twilio texts and rejects forged ones", async () => {
    const ws = await setup();
    const { POST } = await import("@/app/api/webhooks/twilio/sms/route");
    const params = { From: "+14155550177", To: NUMBER, Body: "Hello?", MessageSid: "SM9" };

    expect((await POST(twilioRequest("/api/webhooks/twilio/sms", params, { sign: false }))).status).toBe(403);
    expect(await listConversations(db, ws.id)).toHaveLength(0);

    const res = await POST(twilioRequest("/api/webhooks/twilio/sms", params));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await listConversations(db, ws.id)).toMatchObject([{ body: "Hello?", unread: 1 }]);
  });

  it("forwards calls to the business phone, or logs a missed call when there is none", async () => {
    const ws = await setup();
    const { POST } = await import("@/app/api/webhooks/twilio/voice/route");
    const params = { From: "+14155550177", To: NUMBER, CallSid: "CA1" };

    let xml = await (await POST(twilioRequest("/api/webhooks/twilio/voice", params))).text();
    expect(xml).toContain("<Say>");

    await db.update(workspaces).set({ forwardCallsTo: "+14155559999" }).where(eq(workspaces.id, ws.id));
    xml = await (await POST(twilioRequest("/api/webhooks/twilio/voice", params))).text();
    expect(xml).toContain(`<Dial timeout="20" callerId="${NUMBER}" action="${APP}/api/webhooks/twilio/voice-status">+14155559999</Dial>`);
  });

  it("files Postmark replies under the right account", async () => {
    const ws = await setup();
    const { POST } = await import("@/app/api/webhooks/postmark/inbound/route");
    const email = {
      MessageID: "pm-1",
      FromFull: { Email: "Jane@Example.com", Name: "Jane Doe" },
      Subject: "Re: Your quote",
      TextBody: "Sounds good!\n\nOn Monday you wrote: ...",
      StrippedTextReply: "Sounds good!",
      MailboxHash: ws.id,
    };
    const post = (token: string) =>
      POST(new Request(`${APP}/api/webhooks/postmark/inbound?token=${token}`, { method: "POST", body: JSON.stringify(email) }));

    expect((await post("nope")).status).toBe(403);
    expect((await post("pm-secret")).status).toBe(204);
    const [row] = await listConversations(db, ws.id);
    const convo = await getConversation(db, ws.id, row.contact_id);
    expect(convo!.contact).toMatchObject({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
    expect(convo!.messages).toMatchObject([{ channel: "email", subject: "Re: Your quote", body: "Sounds good!" }]);
  });
});
