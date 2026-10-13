import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type SendSmsInput = { from: string; to: string; body: string; statusCallback?: string };
export type SendEmailInput = {
  fromName?: string | null;
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
};
export type SendResult = { providerId: string; status: "queued" | "sent" };

export interface SmsProvider {
  readonly name: "twilio" | "test";
  sendSms(input: SendSmsInput): Promise<SendResult>;
}

export interface EmailProvider {
  readonly name: "postmark" | "test";
  sendEmail(input: SendEmailInput): Promise<SendResult>;
}

export class ProviderError extends Error {}

// ---------------------------------------------------------------------------
// Twilio (SMS and voice)
// ---------------------------------------------------------------------------

export class TwilioSms implements SmsProvider {
  readonly name = "twilio" as const;
  constructor(
    private accountSid: string,
    private authToken: string,
  ) {}

  async sendSms({ from, to, body, statusCallback }: SendSmsInput): Promise<SendResult> {
    const form = new URLSearchParams({ From: from, To: to, Body: body });
    if (statusCallback) form.set("StatusCallback", statusCallback);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new ProviderError(json.message ?? `Twilio error ${res.status}`);
    return { providerId: json.sid, status: "queued" };
  }
}

/**
 * Checks the X-Twilio-Signature header: HMAC-SHA1 of the full webhook URL
 * followed by each POST parameter name and value, sorted by name.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Postmark (email)
// ---------------------------------------------------------------------------

export class PostmarkEmail implements EmailProvider {
  readonly name = "postmark" as const;
  constructor(private serverToken: string) {}

  async sendEmail({ fromName, from, to, subject, text, replyTo }: SendEmailInput): Promise<SendResult> {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.serverToken,
      },
      body: JSON.stringify({
        From: fromName ? `${fromName.replace(/[<>"]/g, "")} <${from}>` : from,
        To: to,
        Subject: subject,
        TextBody: text,
        ReplyTo: replyTo,
        MessageStream: "outbound",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
    if (!res.ok || json.ErrorCode || !json.MessageID) {
      throw new ProviderError(json.Message ?? `Postmark error ${res.status}`);
    }
    return { providerId: json.MessageID, status: "sent" };
  }
}

// ---------------------------------------------------------------------------
// Test mode: nothing leaves the building. Used until real accounts are
// connected, and in automated tests.
// ---------------------------------------------------------------------------

export class TestSms implements SmsProvider {
  readonly name = "test" as const;
  readonly sent: SendSmsInput[] = [];
  failNext: string | null = null;
  async sendSms(input: SendSmsInput): Promise<SendResult> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new ProviderError(msg);
    }
    this.sent.push(input);
    return { providerId: `test-sms-${randomUUID()}`, status: "sent" };
  }
}

export class TestEmail implements EmailProvider {
  readonly name = "test" as const;
  readonly sent: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<SendResult> {
    this.sent.push(input);
    return { providerId: `test-email-${randomUUID()}`, status: "sent" };
  }
}
