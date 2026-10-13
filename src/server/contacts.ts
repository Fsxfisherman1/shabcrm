import { and, arrayContains, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { activities, contacts, deals, type Contact } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { normalizePhone } from "@/lib/phone";
import { fireTrigger } from "@/server/workflows/triggers";

export type ContactInput = {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: string | null;
  tags?: string[];
};

export type ConsentInput =
  | { smsConsent: "granted"; smsConsentSource: string }
  | { smsConsent: "none" | "revoked"; smsConsentSource?: string | null };

function clean(input: ContactInput) {
  const email = input.email?.trim().toLowerCase() || null;
  return {
    firstName: input.firstName?.trim() ?? "",
    lastName: input.lastName?.trim() ?? "",
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    phone: normalizePhone(input.phone),
    company: input.company?.trim() || null,
    source: input.source?.trim() || null,
    tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
  };
}

export async function listContacts(
  db: Db,
  workspaceId: string,
  opts: { search?: string; tag?: string; limit?: number; offset?: number } = {},
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const filters = [];
    const q = opts.search?.trim();
    if (q) {
      const like = `%${q}%`;
      filters.push(
        or(
          ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, like),
          ilike(contacts.email, like),
          ilike(contacts.phone, `%${q.replace(/\D/g, "") || q}%`),
          ilike(contacts.company, like),
        ),
      );
    }
    if (opts.tag) filters.push(arrayContains(contacts.tags, [opts.tag]));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      tx
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt))
        .limit(opts.limit ?? 50)
        .offset(opts.offset ?? 0),
      tx.select({ total: sql<number>`count(*)::int` }).from(contacts).where(where),
    ]);
    return { rows, total };
  });
}

export async function listTags(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx.execute<{ tag: string; n: number }>(
      sql`select tag, count(*)::int as n from contacts, unnest(tags) as tag group by tag order by n desc, tag limit 100`,
    );
    return [...rows];
  });
}

export async function getContact(db: Db, workspaceId: string, contactId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!contact) return null;
    const [timeline, contactDeals] = await Promise.all([
      tx
        .select()
        .from(activities)
        .where(eq(activities.contactId, contactId))
        .orderBy(desc(activities.createdAt))
        .limit(100),
      tx.select().from(deals).where(eq(deals.contactId, contactId)).orderBy(desc(deals.createdAt)),
    ]);
    return { contact, timeline, deals: contactDeals };
  });
}

export class DuplicateContactError extends Error {}

export async function createContact(
  db: Db,
  workspaceId: string,
  input: ContactInput & { consent?: ConsentInput },
  userId: string | null,
) {
  const data = clean(input);
  return withWorkspace(db, workspaceId, async (tx) => {
    const existing = await findExisting(tx, data.email, data.phone);
    if (existing) throw new DuplicateContactError("A contact with that email or phone already exists.");
    const [contact] = await tx
      .insert(contacts)
      .values({ workspaceId, ...data, ...consentValues(input.consent) })
      .returning();
    await tx.insert(activities).values({
      workspaceId,
      contactId: contact.id,
      kind: "created",
      body: data.source ? `Added from ${data.source}` : "Contact added",
      createdBy: userId,
    });
    await fireTrigger(tx, workspaceId, { type: "contact_created", contactId: contact.id });
    for (const tag of contact.tags) await fireTrigger(tx, workspaceId, { type: "tag_added", contactId: contact.id, tag });
    return contact;
  });
}

export async function updateContact(
  db: Db,
  workspaceId: string,
  contactId: string,
  input: ContactInput,
) {
  const data = clean(input);
  return withWorkspace(db, workspaceId, async (tx) => {
    const dupe = await findExisting(tx, data.email, data.phone);
    if (dupe && dupe.id !== contactId) {
      throw new DuplicateContactError("Another contact already uses that email or phone.");
    }
    const [before] = await tx.select({ tags: contacts.tags }).from(contacts).where(eq(contacts.id, contactId));
    const [contact] = await tx
      .update(contacts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(contacts.id, contactId))
      .returning();
    if (contact) {
      for (const tag of contact.tags.filter((t) => !before?.tags.includes(t))) {
        await fireTrigger(tx, workspaceId, { type: "tag_added", contactId, tag });
      }
    }
    return contact ?? null;
  });
}

export async function setSmsConsent(
  db: Db,
  workspaceId: string,
  contactId: string,
  consent: ConsentInput,
  userId: string | null,
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [contact] = await tx
      .update(contacts)
      .set({ ...consentValues(consent), updatedAt: new Date() })
      .where(eq(contacts.id, contactId))
      .returning();
    if (!contact) return null;
    const label =
      consent.smsConsent === "granted"
        ? `SMS consent recorded (${consent.smsConsentSource})`
        : consent.smsConsent === "revoked"
          ? "SMS consent revoked"
          : "SMS consent cleared";
    await tx.insert(activities).values({
      workspaceId,
      contactId,
      kind: "consent_changed",
      body: label,
      createdBy: userId,
    });
    return contact;
  });
}

export async function deleteContact(db: Db, workspaceId: string, contactId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(contacts).where(eq(contacts.id, contactId)));
}

export async function addNote(
  db: Db,
  workspaceId: string,
  contactId: string,
  body: string,
  userId: string | null,
) {
  const text = body.trim();
  if (!text) return null;
  return withWorkspace(db, workspaceId, async (tx) => {
    const [note] = await tx
      .insert(activities)
      .values({ workspaceId, contactId, kind: "note", body: text, createdBy: userId })
      .returning();
    return note;
  });
}

export type ImportResult = { created: number; updated: number; skipped: number };

/**
 * Imports contacts, matching existing ones by email or phone. Matches get
 * merged tags and any blank fields filled in. Consent is never upgraded on a
 * contact who has revoked it (they replied STOP or asked to be removed).
 */
export async function importContacts(
  db: Db,
  workspaceId: string,
  rows: ContactInput[],
  options: { consent: ConsentInput; tags?: string[]; source?: string },
  userId: string | null,
): Promise<ImportResult> {
  const extraTags = options.tags ?? [];
  const result: ImportResult = { created: 0, updated: 0, skipped: 0 };

  await withWorkspace(db, workspaceId, async (tx) => {
    for (const raw of rows) {
      const data = clean({ ...raw, source: raw.source ?? options.source, tags: [...(raw.tags ?? []), ...extraTags] });
      if (!data.email && !data.phone) {
        result.skipped++;
        continue;
      }
      const existing = await findExisting(tx, data.email, data.phone);
      if (existing) {
        const tags = [...new Set([...existing.tags, ...data.tags])];
        const upgradeConsent =
          options.consent.smsConsent === "granted" && existing.smsConsent === "none";
        await tx
          .update(contacts)
          .set({
            firstName: existing.firstName || data.firstName,
            lastName: existing.lastName || data.lastName,
            email: existing.email ?? data.email,
            phone: existing.phone ?? data.phone,
            company: existing.company ?? data.company,
            tags,
            ...(upgradeConsent ? consentValues(options.consent) : {}),
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, existing.id));
        result.updated++;
      } else {
        const [contact] = await tx
          .insert(contacts)
          .values({ workspaceId, ...data, ...consentValues(options.consent) })
          .returning({ id: contacts.id });
        await tx.insert(activities).values({
          workspaceId,
          contactId: contact.id,
          kind: "imported",
          body: options.source ? `Imported from ${options.source}` : "Imported from CSV",
          createdBy: userId,
        });
        result.created++;
      }
    }
  });

  return result;
}

export async function findExisting(tx: Tx, email: string | null, phone: string | null): Promise<Contact | null> {
  const conds = [];
  if (email) conds.push(sql`lower(${contacts.email}) = ${email}`);
  if (phone) conds.push(eq(contacts.phone, phone));
  if (!conds.length) return null;
  const [row] = await tx.select().from(contacts).where(or(...conds)).limit(1);
  return row ?? null;
}

function consentValues(consent?: ConsentInput) {
  if (!consent || consent.smsConsent === "none") {
    return { smsConsent: "none" as const, smsConsentSource: null, smsConsentAt: null };
  }
  return {
    smsConsent: consent.smsConsent,
    smsConsentSource: consent.smsConsentSource ?? null,
    smsConsentAt: new Date(),
  };
}
