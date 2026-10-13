import { createHmac } from "node:crypto";
import { PostmarkEmail, SendblueIMessage, TestEmail, TestSms, TwilioSms, TwilioWhatsApp, type EmailProvider, type SmsProvider } from "./providers";

/** Twilio, Postmark and Sendblue switch on when their keys are set; otherwise test mode. */
export function messagingConfig() {
  const env = process.env;
  return {
    appUrl: (env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    twilio:
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
        ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }
        : null,
    postmark: env.POSTMARK_SERVER_TOKEN ? { serverToken: env.POSTMARK_SERVER_TOKEN } : null,
    // e.g. abc123@inbound.postmarkapp.com; replies come back as abc123+<account id>@...
    inboundEmailAddress: env.POSTMARK_INBOUND_ADDRESS ?? null,
    inboundEmailSecret: env.POSTMARK_INBOUND_SECRET ?? null,
    // WhatsApp goes through the same Twilio account, once a WhatsApp sender is approved there.
    sendblue:
      env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET && env.SENDBLUE_WEBHOOK_SECRET
        ? { apiKey: env.SENDBLUE_API_KEY, apiSecret: env.SENDBLUE_API_SECRET, webhookSecret: env.SENDBLUE_WEBHOOK_SECRET }
        : null,
  };
}

const globalForProviders = globalThis as unknown as {
  testSms?: TestSms;
  testEmail?: TestEmail;
  testWhatsApp?: TestSms;
  testIMessage?: TestSms;
};

export function smsProvider(): SmsProvider {
  const { twilio } = messagingConfig();
  if (twilio) return new TwilioSms(twilio.accountSid, twilio.authToken);
  return (globalForProviders.testSms ??= new TestSms());
}

export function emailProvider(): EmailProvider {
  const { postmark } = messagingConfig();
  if (postmark) return new PostmarkEmail(postmark.serverToken);
  return (globalForProviders.testEmail ??= new TestEmail());
}

export function whatsappProvider(): SmsProvider {
  const { twilio } = messagingConfig();
  if (twilio) return new TwilioWhatsApp(twilio.accountSid, twilio.authToken);
  return (globalForProviders.testWhatsApp ??= new TestSms());
}

export function imessageProvider(): SmsProvider {
  const { sendblue } = messagingConfig();
  if (sendblue) return new SendblueIMessage(sendblue.apiKey, sendblue.apiSecret);
  return (globalForProviders.testIMessage ??= new TestSms());
}

export function allProviders() {
  return { sms: smsProvider(), email: emailProvider(), whatsapp: whatsappProvider(), imessage: imessageProvider() };
}

/**
 * Sendblue's delivery updates may not carry the webhook secret, so their URL
 * carries a signature of the account id instead.
 */
export function statusToken(workspaceId: string) {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "dev").update(`status:${workspaceId}`).digest("base64url").slice(0, 32);
}

/** Reply-to address that routes email replies back to the right account. */
export function replyToAddress(workspaceId: string): string | undefined {
  const { inboundEmailAddress } = messagingConfig();
  if (!inboundEmailAddress) return undefined;
  const [local, domain] = inboundEmailAddress.split("@");
  return `${local}+${workspaceId}@${domain}`;
}
