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

/** Anything that sends a plain message to a phone number: SMS, WhatsApp, iMessage. */
export interface SmsProvider {
  readonly name: "twilio" | "twilio-whatsapp" | "sendblue" | "test";
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

/**
 * WhatsApp through Twilio: the same Messages API, with "whatsapp:" in front of
 * both numbers. Replies come to the same webhook as texts.
 * https://www.twilio.com/docs/whatsapp/api
 */
export class TwilioWhatsApp implements SmsProvider {
  readonly name = "twilio-whatsapp" as const;
  private twilio: TwilioSms;
  constructor(accountSid: string, authToken: string) {
    this.twilio = new TwilioSms(accountSid, authToken);
  }

  sendSms({ from, to, ...rest }: SendSmsInput): Promise<SendResult> {
    return this.twilio.sendSms({ from: `whatsapp:${from}`, to: `whatsapp:${to}`, ...rest });
  }
}

// ---------------------------------------------------------------------------
// Sendblue (iMessage, falling back to SMS for people without an iPhone)
// https://docs.sendblue.com/api/resources/messages/methods/send
// ---------------------------------------------------------------------------

export class SendblueIMessage implements SmsProvider {
  readonly name = "sendblue" as const;
  constructor(
    private apiKey: string,
    private apiSecret: string,
  ) {}

  async sendSms({ from, to, body, statusCallback }: SendSmsInput): Promise<SendResult> {
    const res = await fetch("https://api.sendblue.co/api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-api-key-id": this.apiKey, "sb-api-secret-key": this.apiSecret },
      body: JSON.stringify({ from_number: from, number: to, content: body, status_callback: statusCallback }),
    });
    const json = (await res.json().catch(() => ({}))) as { message_handle?: string; status?: string; error_message?: string; message?: string };
    if (!res.ok || !json.message_handle || json.status === "ERROR" || json.status === "DECLINED") {
      throw new ProviderError(json.error_message ?? json.message ?? `Sendblue error ${res.status}`);
    }
    return { providerId: json.message_handle, status: json.status === "SENT" || json.status === "DELIVERED" ? "sent" : "queued" };
  }
}

/** Sendblue sends the webhook secret you set as-is in the sb-signing-secret header. */
export function validateSharedSecret(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
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
