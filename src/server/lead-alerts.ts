import { and, between, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { contacts, formSubmissions, forms, messages, workspaces, type Workspace } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { contactName } from "@/lib/format";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { isStopWord } from "@/server/messaging";
import type { EmailProvider, SmsProvider } from "@/server/messaging/providers";

// ---------------------------------------------------------------------------
// Speed-to-lead: when someone texts, emails or fills in a form and nobody at the
// business has answered within the account's limit, alert them by email and/or
// text. One alert per wait: it resets when someone replies.
// ---------------------------------------------------------------------------

export class LeadAlertError extends Error {}

/** Only things that crossed the limit within the last hour count, so turning alerts on doesn't flood old ones. */
const LOOKBACK_MS = 60 * 60_000;

export type LeadAlertDeps = { providers: { sms: SmsProvider; email: EmailProvider }; appUrl: string };

export type WaitingLead = { contactId: string; name: string; since: Date; preview: string; messageIds: string[]; submissionIds: string[] };

export async function updateLeadAlerts(
  db: Db,
  workspaceId: string,
  input: { minutes: number | null; email: string | null; phone: string | null },
) {
  let phone: string | null = null;
  if (input.minutes !== null) {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 24 * 60) {
      throw new LeadAlertError("Pick a number of minutes between 1 and 1440.");
    }
    if (input.phone) {
      phone = normalizePhone(input.phone);
      if (!phone) throw new LeadAlertError("That phone number to alert doesn't look right.");
    }
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new LeadAlertError("That email to alert doesn't look right.");
    if (!input.email && !phone) throw new LeadAlertError("Add an email or phone number to alert.");
  }
  await db
    .update(workspaces)
    .set({ leadAlertMinutes: input.minutes, leadAlertEmail: input.email || null, leadAlertPhone: phone })
    .where(eq(workspaces.id, workspaceId));
}

/** Leads in this account that crossed the waiting limit and haven't been alerted about yet. */
export async function findWaitingLeads(db: Db, workspace: Workspace, now = new Date()): Promise<WaitingLead[]> {
  const minutes = workspace.leadAlertMinutes;
  if (!minutes) return [];
  const until = new Date(now.getTime() - minutes * 60_000);
  const from = new Date(until.getTime() - LOOKBACK_MS);

  return withWorkspace(db, workspace.id, async (tx) => {
    const inbound = await tx
      .select({ id: messages.id, contactId: messages.contactId, body: messages.body, at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.direction, "inbound"), isNull(messages.leadAlertedAt), between(messages.createdAt, from, until)));
    const submitted = await tx
      .select({ id: formSubmissions.id, contactId: formSubmissions.contactId, form: forms.name, at: formSubmissions.createdAt })
      .from(formSubmissions)
      .innerJoin(forms, eq(forms.id, formSubmissions.formId))
      .where(and(isNull(formSubmissions.leadAlertedAt), isNotNull(formSubmissions.contactId), between(formSubmissions.createdAt, from, until)));

    const byContact = new Map<string, WaitingLead>();
    const add = (contactId: string, at: Date, preview: string, kind: "messageIds" | "submissionIds", id: string) => {
      const lead = byContact.get(contactId) ?? { contactId, name: "", since: at, preview, messageIds: [], submissionIds: [] };
      if (at < lead.since) Object.assign(lead, { since: at, preview });
      lead[kind].push(id);
      byContact.set(contactId, lead);
    };
    for (const m of inbound) if (!isStopWord(m.body)) add(m.contactId, m.at, m.body, "messageIds", m.id);
    for (const s of submitted) add(s.contactId!, s.at, `Filled in "${s.form}"`, "submissionIds", s.id);
    if (!byContact.size) return [];

    const ids = [...byContact.keys()];
    // A person at the business answering (not an automation) is what counts.
    const answered = await tx
      .select({ contactId: messages.contactId, at: max(messages.createdAt) })
      .from(messages)
      .where(and(inArray(messages.contactId, ids), eq(messages.direction, "outbound"), isNotNull(messages.createdBy)))
      .groupBy(messages.contactId);
    const alerted = await tx
      .select({ contactId: messages.contactId, at: max(messages.leadAlertedAt) })
      .from(messages)
      .where(and(inArray(messages.contactId, ids), isNotNull(messages.leadAlertedAt)))
      .groupBy(messages.contactId);
    const alertedForms = await tx
      .select({ contactId: formSubmissions.contactId, at: max(formSubmissions.leadAlertedAt) })
      .from(formSubmissions)
      .where(and(inArray(formSubmissions.contactId, ids), isNotNull(formSubmissions.leadAlertedAt)))
      .groupBy(formSubmissions.contactId);
    const names = await tx.select().from(contacts).where(inArray(contacts.id, ids));

    const latest = (rows: { contactId: string | null; at: Date | null }[], id: string) =>
      rows.filter((r) => r.contactId === id && r.at).reduce<Date | null>((t, r) => (!t || r.at! > t ? r.at : t), null);
    const waiting: WaitingLead[] = [];
    for (const lead of byContact.values()) {
      const reply = latest(answered, lead.contactId);
      if (reply && reply >= lead.since) continue; // someone answered in time
      const lastAlert = [latest(alerted, lead.contactId), latest(alertedForms, lead.contactId)].reduce<Date | null>(
        (t, d) => (d && (!t || d > t) ? d : t),
        null,
      );
      const contact = names.find((c) => c.id === lead.contactId);
      lead.name = contact ? contactName(contact) : "A lead";
      // Already alerted about this wait (nobody has replied since): don't alert again, just note it.
      if (lastAlert && (!reply || lastAlert > reply)) {
        await markAlerted(tx, lead, now);
        continue;
      }
      waiting.push(lead);
    }
    return waiting;
  });
}

async function markAlerted(tx: Tx, lead: WaitingLead, now: Date) {
  if (lead.messageIds.length) await tx.update(messages).set({ leadAlertedAt: now }).where(inArray(messages.id, lead.messageIds));
  if (lead.submissionIds.length) await tx.update(formSubmissions).set({ leadAlertedAt: now }).where(inArray(formSubmissions.id, lead.submissionIds));
}

function waitedFor(since: Date, now: Date) {
  const minutes = Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000));
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} hours`;
}

/** Checks every account with alerts on and sends what's due. Returns how many alerts went out. */
export async function sendLeadAlerts(db: Db, deps: LeadAlertDeps, now = new Date()) {
  const list = await db.select().from(workspaces).where(isNotNull(workspaces.leadAlertMinutes));
  let sent = 0;
  for (const workspace of list) {
    try {
      for (const lead of await findWaitingLeads(db, workspace, now)) {
        // Marked first, so a crash never sends the same alert twice.
        await withWorkspace(db, workspace.id, (tx) => markAlerted(tx, lead, now));
        const link = `${deps.appUrl}/w/${workspace.id}/inbox?c=${lead.contactId}`;
        const preview = lead.preview.length > 120 ? `${lead.preview.slice(0, 117)}…` : lead.preview;
        const text = `${workspace.name}: ${lead.name} has waited ${waitedFor(lead.since, now)} for a reply. "${preview}" ${link}`;
        if (workspace.leadAlertPhone && workspace.smsNumber) {
          await deps.providers.sms.sendSms({ from: workspace.smsNumber, to: workspace.leadAlertPhone, body: text });
        }
        if (workspace.leadAlertEmail && workspace.emailFromAddress) {
          await deps.providers.email.sendEmail({
            from: workspace.emailFromAddress,
            fromName: "ShabCRM",
            to: workspace.leadAlertEmail,
            subject: `${lead.name} is waiting for a reply`,
            text: `${lead.name} has waited ${waitedFor(lead.since, now)} for someone at ${workspace.name} to answer.\n\n"${preview}"\n\nReply here: ${link}`,
          });
        }
        sent++;
      }
    } catch (err) {
      console.error(`Lead alerts for ${workspace.id} failed`, err);
    }
  }
  return sent;
}

/** What the settings page shows about where alerts go, and what's missing. */
export function leadAlertProblems(workspace: Workspace) {
  const problems: string[] = [];
  if (workspace.leadAlertPhone && !workspace.smsNumber) problems.push(`Alerts to ${formatPhone(workspace.leadAlertPhone)} need a texting number above.`);
  if (workspace.leadAlertEmail && !workspace.emailFromAddress) problems.push(`Alerts to ${workspace.leadAlertEmail} need a from email address above.`);
  return problems;
}

