import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { activities, contacts, messages, workspaces, type Contact, type Workspace } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { normalizePhone } from "@/lib/phone";
import { statusToken } from "./config";
import { ProviderError, type EmailProvider, type SmsProvider } from "./providers";
import { fireTrigger } from "@/server/workflows/triggers";
import { queueTagging } from "@/server/ai";

export class MessagingError extends Error {}

/** WhatsApp and iMessage are optional so callers that only text and email needn't pass them. */
export type Providers = { sms: SmsProvider; email: EmailProvider; whatsapp?: SmsProvider; imessage?: SmsProvider };

export type Channel = "sms" | "email" | "whatsapp" | "imessage";
/** Channels that reach a phone number. */
export type PhoneChannel = Exclude<Channel, "email">;

const NAME: Record<Channel, string> = { sms: "Texting", email: "Email", whatsapp: "WhatsApp", imessage: "iMessage" };
const MAX_LENGTH: Record<PhoneChannel, number> = { sms: 1600, whatsapp: 4096, imessage: 4000 };
const NUMBER_COLUMN = { sms: workspaces.smsNumber, whatsapp: workspaces.whatsappNumber, imessage: workspaces.imessageNumber } as const;

export function channelNumber(workspace: Workspace, channel: PhoneChannel): string | null {
  return channel === "sms" ? workspace.smsNumber : channel === "whatsapp" ? workspace.whatsappNumber : workspace.imessageNumber;
}

/** How long after a contact texts or calls us we may text them back without stored consent. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

/** A STOP-style reply, which needs no answer. */
export function isStopWord(body: string) {
  return STOP_WORDS.has(keywordOf(body));
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export type TextPermission = { allowed: true; reason: "consent" | "reply_window" } | { allowed: false; reason: string };

/**
 * Whether we may text this contact. Opted-out contacts are never texted.
 * Otherwise we need recorded consent, or the contact must have texted or
 * called us within the last 24 hours (a reply to them, not marketing).
 */
export function textPermission(contact: Contact, lastInboundAt: Date | null, now = new Date()): TextPermission {
  if (!contact.phone) return { allowed: false, reason: "This contact has no mobile number." };
  if (contact.smsConsent === "revoked") return { allowed: false, reason: "This contact opted out of texts." };
  if (contact.smsConsent === "granted") return { allowed: true, reason: "consent" };
  if (lastInboundAt && now.getTime() - lastInboundAt.getTime() < REPLY_WINDOW_MS) {
    return { allowed: true, reason: "reply_window" };
  }
  return {
    allowed: false,
    reason: "No text consent on record. Record their consent, or wait for them to text or call you first.",
  };
}

/**
 * WhatsApp only lets a business message someone within 24 hours of their last
 * WhatsApp message to it (anything later needs a template Meta has approved).
 */
export function whatsappPermission(
  contact: Contact,
  lastWhatsApp: { at: Date; body: string } | null,
  now = new Date(),
): TextPermission {
  if (!contact.phone) return { allowed: false, reason: "This contact has no mobile number." };
  if (!lastWhatsApp || now.getTime() - lastWhatsApp.at.getTime() >= REPLY_WINDOW_MS) {
    return {
      allowed: false,
      reason: "WhatsApp only lets businesses reply within 24 hours of the customer's last WhatsApp message. Text or email them instead.",
    };
  }
  if (STOP_WORDS.has(keywordOf(lastWhatsApp.body))) return { allowed: false, reason: "They asked you to stop on WhatsApp." };
  return { allowed: true, reason: "reply_window" };
}

const keywordOf = (body: string) => body.trim().toLowerCase().replace(/[^a-z]/g, "");

async function lastWhatsApp(tx: Tx, contactId: string) {
  const [msg] = await tx
    .select({ at: messages.createdAt, body: messages.body })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.channel, "whatsapp"), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return msg ?? null;
}

/** Permission for each phone channel. Texts and iMessages share consent: both are texting a phone number. */
async function phonePermissions(tx: Tx, contact: Contact) {
  const text = textPermission(contact, await lastInboundAt(tx, contact.id));
  return { sms: text, imessage: text, whatsapp: whatsappPermission(contact, await lastWhatsApp(tx, contact.id)) };
}

async function lastInboundAt(tx: Tx, contactId: string): Promise<Date | null> {
  const [msg] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), inArray(messages.channel, ["sms", "imessage"]), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [call] = await tx
    .select({ at: activities.createdAt })
    .from(activities)
    .where(and(eq(activities.contactId, contactId), eq(activities.kind, "missed_call")))
    .orderBy(desc(activities.createdAt))
    .limit(1);
  const times = [msg?.at, call?.at].filter((d): d is Date => Boolean(d));
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type SendInput = {
  contactId: string;
  channel: Channel;
  body: string;
  subject?: string;
};

export async function sendMessage(
  db: Db,
  workspaceId: string,
  input: SendInput,
  userId: string | null,
  providers: Providers,
  opts: { appUrl?: string; replyTo?: string } = {},
) {
  const body = input.body.trim();
  if (!body) throw new MessagingError("Write a message first.");
  if (input.channel !== "email" && body.length > MAX_LENGTH[input.channel]) {
    throw new MessagingError(`${NAME[input.channel]} messages can be up to ${MAX_LENGTH[input.channel].toLocaleString("en-US")} characters.`);
  }

  // 1. Check the rules and record the message as queued.
  const { message, workspace } = await withWorkspace(db, workspaceId, async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, input.contactId));
    if (!contact) throw new MessagingError("Contact not found.");

    let from: string;
    let to: string;
    if (input.channel !== "email") {
      const number = channelNumber(workspace, input.channel);
      if (!number) {
        throw new MessagingError(
          input.channel === "sms"
            ? "Set up a texting number for this account in Settings first."
            : `Set up ${input.channel === "imessage" ? "an" : "a"} ${NAME[input.channel]} number for this account in Settings first.`,
        );
      }
      const permission = (await phonePermissions(tx, contact))[input.channel];
      if (!permission.allowed) throw new MessagingError(permission.reason);
      from = number;
      to = contact.phone!;
    } else {
      if (!workspace.emailFromAddress) throw new MessagingError("Set a from email address for this account in Settings first.");
      if (!contact.email) throw new MessagingError("This contact has no email address.");
      if (contact.emailOptOut) throw new MessagingError("This contact unsubscribed from email.");
      if (!input.subject?.trim()) throw new MessagingError("Add a subject line.");
      from = workspace.emailFromAddress;
      to = contact.email;
    }

    const [message] = await tx
      .insert(messages)
      .values({
        workspaceId,
        contactId: contact.id,
        channel: input.channel,
        direction: "outbound",
        status: "queued",
        subject: input.channel === "email" ? input.subject!.trim() : null,
        body,
        fromAddress: from,
        toAddress: to,
        createdBy: userId,
      })
      .returning();
    return { message, workspace };
  });

  // 2. Hand it to Twilio, Sendblue or Postmark, outside the transaction.
  let update: Partial<typeof messages.$inferInsert>;
  try {
    const phone = message.channel === "email" ? null : providers[message.channel];
    if (message.channel !== "email" && !phone) throw new ProviderError(`${NAME[message.channel]} isn't connected.`);
    const statusCallback = !opts.appUrl
      ? undefined
      : message.channel === "imessage"
        ? `${opts.appUrl}/api/webhooks/sendblue/status?w=${workspaceId}&t=${statusToken(workspaceId)}`
        : `${opts.appUrl}/api/webhooks/twilio/status?w=${workspaceId}`;
    const result = phone
      ? await phone.sendSms({ from: message.fromAddress, to: message.toAddress, body, statusCallback })
      : await providers.email.sendEmail({
            fromName: workspace.emailFromName,
            from: message.fromAddress,
            to: message.toAddress,
            subject: message.subject!,
            text: body,
            replyTo: opts.replyTo,
          });
    update = { status: result.status, providerId: result.providerId };
  } catch (err) {
    update = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  // 3. Record the outcome.
  const [saved] = await withWorkspace(db, workspaceId, (tx) =>
    tx.update(messages).set(update).where(eq(messages.id, message.id)).returning(),
  );
  return saved;
}

/** Applies a Twilio delivery status callback (texts and WhatsApp). */
export async function updateSmsStatus(
  db: Db,
  workspaceId: string,
  providerId: string,
  twilioStatus: string,
  errorCode?: string | null,
) {
  const status =
    twilioStatus === "delivered" || twilioStatus === "read"
      ? "delivered"
      : twilioStatus === "failed" || twilioStatus === "undelivered"
        ? "failed"
        : twilioStatus === "sent"
          ? "sent"
          : null;
  if (status) await setOutboundStatus(db, workspaceId, providerId, status, `Carrier error ${errorCode ?? "unknown"}`);
}

/** Applies a Sendblue delivery update (iMessage). */
export async function updateIMessageStatus(db: Db, workspaceId: string, providerId: string, sendblueStatus: string, error?: string | null) {
  const s = sendblueStatus.toUpperCase();
  const status = s === "DELIVERED" ? "delivered" : s === "SENT" ? "sent" : s === "ERROR" || s === "DECLINED" ? "failed" : null;
  if (status) await setOutboundStatus(db, workspaceId, providerId, status, error || "Not delivered");
}

async function setOutboundStatus(db: Db, workspaceId: string, providerId: string, status: "sent" | "delivered" | "failed", error: string) {
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(messages)
      .set({ status, error: status === "failed" ? error : null })
      .where(and(eq(messages.providerId, providerId), eq(messages.direction, "outbound"))),
  );
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export async function workspaceBySmsNumber(db: Db, number: string): Promise<Workspace | null> {
  return workspaceByNumber(db, "sms", number);
}

export async function workspaceByNumber(db: Db, channel: PhoneChannel, number: string): Promise<Workspace | null> {
  const e164 = normalizePhone(number) ?? number;
  const [ws] = await db.select().from(workspaces).where(eq(NUMBER_COLUMN[channel], e164));
  return ws ?? null;
}

async function findOrCreateByPhone(tx: Tx, workspaceId: string, phone: string, source: string) {
  const [existing] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
  if (existing) return existing;
  const [created] = await tx.insert(contacts).values({ workspaceId, phone, source }).returning();
  await tx.insert(activities).values({ workspaceId, contactId: created.id, kind: "created", body: `Added from ${source.toLowerCase()}` });
  await fireTrigger(tx, workspaceId, { type: "contact_created", contactId: created.id });
  return created;
}

export type InboundSmsResult = { workspaceId: string; contactId: string; optedOut: boolean; optedIn: boolean } | null;

export async function receiveSms(
  db: Db,
  input: { from: string; to: string; body: string; providerId?: string },
): Promise<InboundSmsResult> {
  return receivePhoneMessage(db, { ...input, channel: "sms" });
}

const INBOUND_SOURCE: Record<PhoneChannel, string> = { sms: "Inbound text", whatsapp: "WhatsApp", imessage: "iMessage" };

/** A text, WhatsApp or iMessage from a contact, matched to the account by the number it was sent to. */
export async function receivePhoneMessage(
  db: Db,
  input: { channel: PhoneChannel; from: string; to: string; body: string; providerId?: string },
): Promise<InboundSmsResult> {
  const workspace = await workspaceByNumber(db, input.channel, input.to);
  const from = normalizePhone(input.from) ?? input.from;
  if (!workspace) return null;

  return withWorkspace(db, workspace.id, async (tx) => {
    if (input.providerId) {
      const [dupe] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.providerId, input.providerId));
      if (dupe) return null; // Twilio retried a webhook we already handled.
    }
    const contact = await findOrCreateByPhone(tx, workspace.id, from, INBOUND_SOURCE[input.channel]);
    const [message] = await tx.insert(messages).values({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel: input.channel,
      direction: "inbound",
      status: "received",
      body: input.body,
      fromAddress: from,
      toAddress: channelNumber(workspace, input.channel)!,
      providerId: input.providerId ?? null,
    }).returning({ id: messages.id });

    // STOP and START by text or iMessage change text consent. On WhatsApp,
    // STOP just closes the conversation (see whatsappPermission).
    const keyword = keywordOf(input.body);
    const how = input.channel === "imessage" ? "iMessage" : "text";
    let optedOut = false;
    let optedIn = false;
    if (input.channel === "whatsapp") {
      // nothing to change
    } else if (STOP_WORDS.has(keyword) && contact.smsConsent !== "revoked") {
      optedOut = true;
      await tx
        .update(contacts)
        .set({
          smsConsent: "revoked",
          smsConsentSource: `${how === "text" ? "Texted" : "Sent by iMessage"} ${keyword.toUpperCase()}`,
          smsConsentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contact.id));
      await tx.insert(activities).values({
        workspaceId: workspace.id,
        contactId: contact.id,
        kind: "consent_changed",
        body: `Opted out of texts by replying ${keyword.toUpperCase()}${how === "text" ? "" : " by iMessage"}`,
      });
    } else if (START_WORDS.has(keyword) && contact.smsConsent === "revoked") {
      // The contact themselves opting back in is the one way out of "revoked".
      optedIn = true;
      await tx
        .update(contacts)
        .set({
          smsConsent: "granted",
          smsConsentSource: `${how === "text" ? "Texted" : "Sent by iMessage"} ${keyword.toUpperCase()}`,
          smsConsentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contact.id));
      await tx.insert(activities).values({
        workspaceId: workspace.id,
        contactId: contact.id,
        kind: "consent_changed",
        body: `Opted back in to texts by replying ${keyword.toUpperCase()}${how === "text" ? "" : " by iMessage"}`,
      });
    }
    if (!optedOut && !optedIn) await queueTagging(tx, workspace.id, message.id);
    await fireTrigger(tx, workspace.id, { type: "sms_received", contactId: contact.id, body: input.body });
    return { workspaceId: workspace.id, contactId: contact.id, optedOut, optedIn };
  });
}

export async function receiveEmail(
  db: Db,
  input: { workspaceId: string; from: string; fromName?: string; subject: string; text: string; providerId?: string },
) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
  if (!workspace) return null;
  const email = input.from.trim().toLowerCase();
  return withWorkspace(db, workspace.id, async (tx) => {
    if (input.providerId) {
      const [dupe] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.providerId, input.providerId));
      if (dupe) return null;
    }
    let [contact] = await tx.select().from(contacts).where(sql`lower(${contacts.email}) = ${email}`);
    if (!contact) {
      const [first, ...rest] = (input.fromName ?? "").trim().split(/\s+/);
      [contact] = await tx
        .insert(contacts)
        .values({ workspaceId: workspace.id, email, firstName: first ?? "", lastName: rest.join(" "), source: "Inbound email" })
        .returning();
      await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "created", body: "Added from inbound email" });
      await fireTrigger(tx, workspace.id, { type: "contact_created", contactId: contact.id });
    }
    const [message] = await tx
      .insert(messages)
      .values({
        workspaceId: workspace.id,
        contactId: contact.id,
        channel: "email",
        direction: "inbound",
        status: "received",
        subject: input.subject || "(no subject)",
        body: input.text,
        fromAddress: email,
        toAddress: workspace.emailFromAddress ?? "",
        providerId: input.providerId ?? null,
      })
      .returning();
    await queueTagging(tx, workspace.id, message.id);
    await fireTrigger(tx, workspace.id, { type: "email_received", contactId: contact.id });
    return { workspaceId: workspace.id, contactId: contact.id, messageId: message.id };
  });
}

// ---------------------------------------------------------------------------
// Missed-call text-back
// ---------------------------------------------------------------------------

const MISSED = new Set(["no-answer", "busy", "failed", "canceled"]);

export async function handleCallEnded(
  db: Db,
  input: { to: string; from: string; dialStatus: string },
  providers: Providers,
  opts: { appUrl?: string } = {},
) {
  if (!MISSED.has(input.dialStatus)) return { missed: false as const };
  const workspace = await workspaceBySmsNumber(db, input.to);
  const from = normalizePhone(input.from);
  if (!workspace || !from) return { missed: false as const };

  const contact = await withWorkspace(db, workspace.id, async (tx) => {
    const contact = await findOrCreateByPhone(tx, workspace.id, from, "Missed call");
    await tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "missed_call", body: "Missed call" });
    await fireTrigger(tx, workspace.id, { type: "missed_call", contactId: contact.id });
    return contact;
  });

  if (!workspace.missedCallTextEnabled) return { missed: true as const, texted: false };
  const message = await sendMessage(
    db,
    workspace.id,
    { contactId: contact.id, channel: "sms", body: workspace.missedCallText },
    null,
    providers,
    opts,
  ).catch((err) => {
    if (err instanceof MessagingError) return null; // e.g. they opted out
    throw err;
  });
  return { missed: true as const, texted: message?.status !== "failed" && Boolean(message) };
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function listConversations(db: Db, workspaceId: string, opts: { unreadOnly?: boolean; channel?: Channel } = {}) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx.execute<{
      contact_id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
      channel: Channel;
      direction: "inbound" | "outbound";
      body: string;
      status: string;
      intent: string | null;
      created_at: string;
      unread: number;
    }>(sql`
      select distinct on (m.contact_id)
        m.contact_id, c.first_name, c.last_name, c.email, c.phone,
        m.channel, m.direction, m.body, m.status, m.intent, m.created_at,
        (select count(*)::int from messages u
          where u.contact_id = m.contact_id and u.direction = 'inbound' and u.read_at is null) as unread
      from messages m
      join contacts c on c.id = m.contact_id
      ${opts.channel ? sql`where m.channel = ${opts.channel}` : sql``}
      order by m.contact_id, m.created_at desc
    `);
    return [...rows]
      .map((r) => ({ ...r, created_at: new Date(r.created_at) }))
      .filter((r) => !opts.unreadOnly || r.unread > 0)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  });
}

export type ConversationRow = Awaited<ReturnType<typeof listConversations>>[number];

export async function getConversation(db: Db, workspaceId: string, contactId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!contact) return null;
    const thread = await tx.select().from(messages).where(eq(messages.contactId, contactId)).orderBy(asc(messages.createdAt));
    const permissions = await phonePermissions(tx, contact);
    return { contact, messages: thread, textPermission: permissions.sms, permissions };
  });
}

export async function markConversationRead(db: Db, workspaceId: string, contactId: string) {
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(messages)
      .set({ readAt: new Date() })
      .where(and(eq(messages.contactId, contactId), eq(messages.direction, "inbound"), isNull(messages.readAt))),
  );
}

export async function unreadCount(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(distinct ${messages.contactId})::int` })
      .from(messages)
      .where(and(eq(messages.direction, "inbound"), isNull(messages.readAt)));
    return row.n;
  });
}

export async function updateMessagingSettings(
  db: Db,
  workspaceId: string,
  input: {
    smsNumber: string | null;
    forwardCallsTo: string | null;
    missedCallTextEnabled: boolean;
    missedCallText: string;
    emailFromName: string | null;
    emailFromAddress: string | null;
    whatsappNumber: string | null;
    imessageNumber: string | null;
  },
) {
  await db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
}
