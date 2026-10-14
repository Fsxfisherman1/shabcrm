import { and, count, eq, gt, gte, inArray, isNull, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db, Tx } from "@/db/client";
import {
  activities,
  appointments,
  contacts,
  deals,
  formSubmissions,
  itemSeen,
  memberships,
  messages,
  tabSeen,
  todos,
  userPrefs,
  workflowRuns,
} from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import type { SeenTab, WorkspaceBadges } from "@/lib/badges";

// ---------------------------------------------------------------------------
// The red counts on the sidebar tabs. The Inbox counts unread conversations
// and To-do counts what's due. The other tabs count what's new, and clear in
// one of two ways, as each person chooses:
// - item by item (the default): each thing counts until that person opens it,
//   for example the contact's page or the form's responses;
// - by tab: everything clears when they open the tab.
// ---------------------------------------------------------------------------

export type ItemKind = "contact" | "deal" | "appointment" | "submission" | "run";

export async function getBadgePrefs(db: Db, userId: string) {
  const [existing] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId));
  if (existing) return existing;
  // First time: start counting item by item from now, so nothing old piles up.
  await db.insert(userPrefs).values({ userId }).onConflictDoNothing();
  const [created] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId));
  return created;
}

export async function setClearPerItem(db: Db, userId: string, on: boolean, now = new Date()) {
  await getBadgePrefs(db, userId);
  // Turning it on starts from zero rather than counting everything ever unopened.
  await db
    .update(userPrefs)
    .set(on ? { clearPerItem: true, perItemSince: now } : { clearPerItem: false })
    .where(eq(userPrefs.userId, userId));
}

/** Records that this person just opened a tab, which clears its count when clearing by tab. */
export async function markTabSeen(db: Db, userId: string, workspaceId: string, tab: SeenTab, now = new Date()) {
  await db
    .insert(tabSeen)
    .values({ userId, workspaceId, tab, seenAt: now })
    .onConflictDoUpdate({ target: [tabSeen.userId, tabSeen.workspaceId, tabSeen.tab], set: { seenAt: now } });
}

/** Records that this person opened (or acted on) these items, which clears them when clearing item by item. */
export async function markItemsSeen(db: Db, userId: string, workspaceId: string, kind: ItemKind, itemIds: string[]) {
  if (!itemIds.length) return;
  await db
    .insert(itemSeen)
    .values(itemIds.map((itemId) => ({ userId, workspaceId, kind, itemId })))
    .onConflictDoNothing();
}

/** Everything a contact's page shows: the contact, and their deals, bookings and form responses. */
export async function markContactSeen(db: Db, userId: string, workspaceId: string, contactId: string) {
  const ids = await withWorkspace(db, workspaceId, async (tx) => ({
    deals: (await tx.select({ id: deals.id }).from(deals).where(eq(deals.contactId, contactId))).map((r) => r.id),
    appointments: (await tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.contactId, contactId))).map((r) => r.id),
    submissions: (await tx.select({ id: formSubmissions.id }).from(formSubmissions).where(eq(formSubmissions.contactId, contactId))).map(
      (r) => r.id,
    ),
  }));
  await markItemsSeen(db, userId, workspaceId, "contact", [contactId]);
  await markItemsSeen(db, userId, workspaceId, "deal", ids.deals);
  await markItemsSeen(db, userId, workspaceId, "appointment", ids.appointments);
  await markItemsSeen(db, userId, workspaceId, "submission", ids.submissions);
}

const ZERO: WorkspaceBadges = { inbox: 0, contacts: 0, calendar: 0, pipeline: 0, forms: 0, automations: 0 };

export async function workspaceBadges(db: Db, userId: string, workspaceId: string, now = new Date()): Promise<WorkspaceBadges> {
  const [member] = await db
    .select({ joinedAt: memberships.createdAt })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  if (!member) return ZERO;
  const prefs = await getBadgePrefs(db, userId);
  const seenRows = await db
    .select({ tab: tabSeen.tab, at: tabSeen.seenAt })
    .from(tabSeen)
    .where(and(eq(tabSeen.userId, userId), eq(tabSeen.workspaceId, workspaceId)));

  // Which rows count as new on a tab, given when it was created and its id.
  const since = (tab: SeenTab) =>
    prefs.clearPerItem
      ? new Date(Math.max(member.joinedAt.getTime(), prefs.perItemSince.getTime()))
      : (seenRows.find((r) => r.tab === tab)?.at ?? member.joinedAt); // a tab never opened counts from joining
  const fresh = (tab: SeenTab, kind: ItemKind, createdAt: PgColumn, id: PgColumn): SQL => {
    const after = gt(createdAt, since(tab));
    if (!prefs.clearPerItem) return after;
    const opened = sql`(select 1 from ${itemSeen} where ${itemSeen.userId} = ${userId} and ${itemSeen.kind} = ${kind} and ${itemSeen.itemId} = ${id})`;
    return and(after, notExists(opened))!;
  };

  return withWorkspace(db, workspaceId, async (tx) => {
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    return {
      inbox: await n(
        tx
          .select({ n: sql<number>`count(distinct ${messages.contactId})::int` })
          .from(messages)
          .where(and(eq(messages.direction, "inbound"), isNull(messages.readAt))),
      ),
      // Contacts you added or imported yourself aren't news to you.
      contacts: await n(
        tx
          .select({ n: count() })
          .from(contacts)
          .where(and(fresh("contacts", "contact", contacts.createdAt, contacts.id), notExists(addedBy(tx, userId)))),
      ),
      // Upcoming bookings made by someone else; past or canceled ones need nothing.
      calendar: await n(
        tx
          .select({ n: count() })
          .from(appointments)
          .where(
            and(
              fresh("calendar", "appointment", appointments.createdAt, appointments.id),
              eq(appointments.status, "booked"),
              gte(appointments.endsAt, now),
              or(isNull(appointments.createdBy), sql`${appointments.createdBy} <> ${userId}`),
            ),
          ),
      ),
      pipeline: await n(
        tx
          .select({ n: count() })
          .from(deals)
          .where(and(fresh("pipeline", "deal", deals.createdAt, deals.id), or(isNull(deals.createdBy), sql`${deals.createdBy} <> ${userId}`))),
      ),
      forms: await n(tx.select({ n: count() }).from(formSubmissions).where(fresh("forms", "submission", formSubmissions.createdAt, formSubmissions.id))),
      // Only problems: workflow runs that failed.
      automations: await n(
        tx
          .select({ n: count() })
          .from(workflowRuns)
          .where(and(eq(workflowRuns.status, "failed"), fresh("automations", "run", workflowRuns.finishedAt, workflowRuns.id))),
      ),
    };
  });
}

/** A contact this person added or imported themselves. */
function addedBy(tx: Tx, userId: string) {
  return tx
    .select({ one: sql`1` })
    .from(activities)
    .where(and(eq(activities.contactId, contacts.id), inArray(activities.kind, ["created", "imported"]), eq(activities.createdBy, userId)));
}

/** Open to-dos due today or earlier. */
export async function dueTodoCount(db: Db, userId: string, today: string) {
  const [row] = await db
    .select({ n: count() })
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.done, false), lte(todos.dueDate, today)));
  return row?.n ?? 0;
}

/** Counts for every account this person belongs to, plus their to-dos. */
export async function allBadges(db: Db, userId: string, today: string, now = new Date()) {
  const ids = (await db.select({ id: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, userId))).map((r) => r.id);
  const accounts: Record<string, WorkspaceBadges> = {};
  for (const id of ids) accounts[id] = await workspaceBadges(db, userId, id, now);
  const { clearPerItem } = await getBadgePrefs(db, userId);
  return { accounts, todos: await dueTodoCount(db, userId, today), clearPerItem };
}
