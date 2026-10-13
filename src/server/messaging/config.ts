import { PostmarkEmail, TestEmail, TestSms, TwilioSms, type EmailProvider, type SmsProvider } from "./providers";

/** Twilio and Postmark switch on when their keys are set; otherwise test mode. */
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
  };
}

const globalForProviders = globalThis as unknown as { testSms?: TestSms; testEmail?: TestEmail };

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

/** Reply-to address that routes email replies back to the right account. */
export function replyToAddress(workspaceId: string): string | undefined {
  const { inboundEmailAddress } = messagingConfig();
  if (!inboundEmailAddress) return undefined;
  const [local, domain] = inboundEmailAddress.split("@");
  return `${local}+${workspaceId}@${domain}`;
}
