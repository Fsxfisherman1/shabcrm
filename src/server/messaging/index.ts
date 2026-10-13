import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { activities, contacts, messages, workspaces, type Contact, type Workspace } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { normalizePhone } from "@/lib/phone";
import type { EmailProvider, SmsProvider } from "./providers";

export class MessagingError extends Error {}

export type Providers = { sms: SmsProvider; email: EmailProvider };

/** How long after a contact texts or calls us we may text them back without stored consent. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

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

async function lastInboundAt(tx: Tx, contactId: string): Promise<Date | null> {
  const [msg] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.channel, "sms"), eq(messages.direction, "inbound")))
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
  channel: "sms" | "email";
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
  if (input.channel === "sms" && body.length > 1600) throw new MessagingError("Texts can be up to 1,600 characters.");

  // 1. Check the rules and record the message as queued.
  const { message, workspace } = await withWorkspace(db, workspaceId, async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, input.contactId));
    if (!contact) throw new MessagingError("Contact not found.");

    let from: string;
    let to: string;
    if (input.channel === "sms") {
      if (!workspace.smsNumber) throw new MessagingError("Set up a texting number for this account in Settings first.");
      const permission = textPermission(contact, await lastInboundAt(tx, contact.id));
      if (!permission.allowed) throw new MessagingError(permission.reason);
      from = workspace.smsNumber;
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

  // 2. Hand it to Twilio or Postmark, outside the transaction.
  let update: Partial<typeof messages.$inferInsert>;
  try {
    const result =
      message.channel === "sms"
        ? await providers.sms.sendSms({
            from: message.fromAddress,
            to: message.toAddress,
            body,
            statusCallback: opts.appUrl ? `${opts.appUrl}/api/webhooks/twilio/status?w=${workspaceId}` : undefined,
          })
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

/** Applies a Twilio delivery status callback. */
export async function updateSmsStatus(
  db: Db,
  workspaceId: string,
  providerId: string,
  twilioStatus: string,
  errorCode?: string | null,
) {
  const status =
    twilioStatus === "delivered"
      ? "delivered"
      : twilioStatus === "failed" || twilioStatus === "undelivered"
        ? "failed"
        : twilioStatus === "sent"
          ? "sent"
          : null;
  if (!status) return;
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(messages)
      .set({ status, error: status === "failed" ? `Carrier error ${errorCode ?? "unknown"}` : null })
      .where(and(eq(messages.providerId, providerId), eq(messages.direction, "outbound"))),
  );
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export async function workspaceBySmsNumber(db: Db, number: string): Promise<Workspace | null> {
  const e164 = normalizePhone(number) ?? number;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.smsNumber, e164));
  return ws ?? null;
}

async function findOrCreateByPhone(tx: Tx, workspaceId: string, phone: string, source: string) {
  const [existing] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
  if (existing) return existing;
  const [created] = await tx.insert(contacts).values({ workspaceId, phone, source }).returning();
  await tx.insert(activities).values({ workspaceId, contactId: created.id, kind: "created", body: `Added from ${source.toLowerCase()}` });
  return created;
}

export type InboundSmsResult = { workspaceId: string; contactId: string; optedOut: boolean; optedIn: boolean } | null;

export async function receiveSms(
  db: Db,
  input: { from: string; to: string; body: string; providerId?: string },
): Promise<InboundSmsResult> {
  const workspace = await workspaceBySmsNumber(db, input.to);
  const from = normalizePhone(input.from) ?? input.from;
  if (!workspace) return null;

  return withWorkspace(db, workspace.id, async (tx) => {
    if (input.providerId) {
      const [dupe] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.providerId, input.providerId));
      if (dupe) return null; // Twilio retried a webhook we already handled.
    }
    const contact = await findOrCreateByPhone(tx, workspace.id, from, "Inbound text");
    await tx.insert(messages).values({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel: "sms",
      direction: "inbound",
      status: "received",
      body: input.body,
      fromAddress: from,
      toAddress: workspace.smsNumber!,
      providerId: input.providerId ?? null,
    });

    const keyword = input.body.trim().toLowerCase().replace(/[^a-z]/g, "");
    let optedOut = false;
    let optedIn = false;
    if (STOP_WORDS.has(keyword) && contact.smsConsent !== "revoked") {
      optedOut = true;
      await tx
        .update(contacts)
        .set({ smsConsent: "revoked", smsConsentSource: `Texted ${keyword.toUpperCase()}`, smsConsentAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await tx.insert(activities).values({
        workspaceId: workspace.id,
        contactId: contact.id,
        kind: "consent_changed",
        body: `Opted out of texts by replying ${keyword.toUpperCase()}`,
      });
    } else if (START_WORDS.has(keyword) && contact.smsConsent === "revoked") {
      // The contact themselves opting back in is the one way out of "revoked".
      optedIn = true;
      await tx
        .update(contacts)
        .set({ smsConsent: "granted", smsConsentSource: `Texted ${keyword.toUpperCase()}`, smsConsentAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, contact.id));
      await tx.insert(activities).values({
        workspaceId: workspace.id,
        contactId: contact.id,
        kind: "consent_changed",
        body: `Opted back in to texts by replying ${keyword.toUpperCase()}`,
      });
    }
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

export async function listConversations(db: Db, workspaceId: string, opts: { unreadOnly?: boolean } = {}) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx.execute<{
      contact_id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
      channel: "sms" | "email";
      direction: "inbound" | "outbound";
      body: string;
      status: string;
      created_at: string;
      unread: number;
    }>(sql`
      select distinct on (m.contact_id)
        m.contact_id, c.first_name, c.last_name, c.email, c.phone,
        m.channel, m.direction, m.body, m.status, m.created_at,
        (select count(*)::int from messages u
          where u.contact_id = m.contact_id and u.direction = 'inbound' and u.read_at is null) as unread
      from messages m
      join contacts c on c.id = m.contact_id
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
    const permission = textPermission(contact, await lastInboundAt(tx, contactId));
    return { contact, messages: thread, textPermission: permission };
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
  },
) {
  await db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
}
