import { and, count, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { appointments, contacts, deals, formSubmissions, memberships, messages, tabSeen, todos, workflowRuns } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import type { SeenTab, WorkspaceBadges } from "@/lib/badges";

// ---------------------------------------------------------------------------
// The red counts on the sidebar tabs. The Inbox counts unread conversations;
// the other tabs count what arrived since this person last opened the tab.
// ---------------------------------------------------------------------------

/** Records that this person just opened a tab, which clears its count. */
export async function markTabSeen(db: Db, userId: string, workspaceId: string, tab: SeenTab, now = new Date()) {
  await db
    .insert(tabSeen)
    .values({ userId, workspaceId, tab, seenAt: now })
    .onConflictDoUpdate({ target: [tabSeen.userId, tabSeen.workspaceId, tabSeen.tab], set: { seenAt: now } });
}

export async function workspaceBadges(db: Db, userId: string, workspaceId: string, now = new Date()): Promise<WorkspaceBadges> {
  const [member] = await db
    .select({ joinedAt: memberships.createdAt })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  if (!member) return { inbox: 0, contacts: 0, calendar: 0, pipeline: 0, forms: 0, automations: 0 };
  const seenRows = await db
    .select({ tab: tabSeen.tab, at: tabSeen.seenAt })
    .from(tabSeen)
    .where(and(eq(tabSeen.userId, userId), eq(tabSeen.workspaceId, workspaceId)));
  // A tab never opened counts from when they joined the account.
  const seen = (tab: SeenTab) => seenRows.find((r) => r.tab === tab)?.at ?? member.joinedAt;

  return withWorkspace(db, workspaceId, async (tx) => {
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    return {
      inbox: await n(
        tx
          .select({ n: sql<number>`count(distinct ${messages.contactId})::int` })
          .from(messages)
          .where(and(eq(messages.direction, "inbound"), isNull(messages.readAt))),
      ),
      contacts: await n(tx.select({ n: count() }).from(contacts).where(gt(contacts.createdAt, seen("contacts")))),
      // Upcoming appointments booked since; past or canceled ones need nothing.
      calendar: await n(
        tx
          .select({ n: count() })
          .from(appointments)
          .where(and(gt(appointments.createdAt, seen("calendar")), eq(appointments.status, "booked"), gte(appointments.endsAt, now))),
      ),
      pipeline: await n(tx.select({ n: count() }).from(deals).where(gt(deals.createdAt, seen("pipeline")))),
      forms: await n(tx.select({ n: count() }).from(formSubmissions).where(gt(formSubmissions.createdAt, seen("forms")))),
      // Only problems: workflow runs that failed.
      automations: await n(
        tx
          .select({ n: count() })
          .from(workflowRuns)
          .where(and(eq(workflowRuns.status, "failed"), gt(workflowRuns.finishedAt, seen("automations")))),
      ),
    };
  });
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
  return { accounts, todos: await dueTodoCount(db, userId, today) };
}
