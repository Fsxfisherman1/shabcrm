import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { memberships, workspaces } from "@/db/schema";
import { allBadges, getBadgePrefs, markContactSeen, markItemsSeen, markTabSeen, setClearPerItem, workspaceBadges } from "@/server/badges";
import { createContact, listContacts } from "@/server/contacts";
import { receiveSms } from "@/server/messaging";
import { createDeal, listPipelinesWithStages } from "@/server/pipelines";
import { addTodo } from "@/server/todos";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

const NUMBER = "+14155550000";

describe("sidebar counts", () => {
  beforeEach(resetDb);

  async function setup() {
    const alex = await makeUser();
    const sam = await makeUser("Sam");
    const ws = await makeWorkspace(alex.id);
    await db.insert(memberships).values({ userId: sam.id, workspaceId: ws.id, role: "member" });
    await db.update(workspaces).set({ smsNumber: NUMBER }).where(eq(workspaces.id, ws.id));
    const [pipeline] = await listPipelinesWithStages(db, ws.id);
    const deal = (title: string, contactId: string | null, by: string) =>
      createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: pipeline.stages[0].id, title, valueCents: 0, contactId }, by);
    return { alex, sam, ws, deal };
  }

  it("clears by tab: counts what's new since each person last opened the tab", async () => {
    const { alex, sam, ws, deal } = await setup();
    await setClearPerItem(db, alex.id, false);
    await setClearPerItem(db, sam.id, false);

    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hi" }); // a new contact, and an unread text
    await deal("Kitchen", null, alex.id);

    // What Alex added isn't new to Alex, but it is to Sam.
    expect(await workspaceBadges(db, alex.id, ws.id)).toMatchObject({ inbox: 1, contacts: 1, pipeline: 0, calendar: 0, forms: 0, automations: 0 });
    expect(await workspaceBadges(db, sam.id, ws.id)).toMatchObject({ contacts: 2, pipeline: 1 });

    await markTabSeen(db, sam.id, ws.id, "contacts");
    expect((await workspaceBadges(db, sam.id, ws.id)).contacts).toBe(0);
    expect((await workspaceBadges(db, alex.id, ws.id)).contacts).toBe(1);
  });

  it("clears item by item: each thing counts until that person opens it", async () => {
    const { alex, sam, ws, deal } = await setup();
    expect((await getBadgePrefs(db, alex.id)).clearPerItem).toBe(true); // the default
    await getBadgePrefs(db, sam.id);

    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hi" });
    await receiveSms(db, { from: "+14155550199", to: NUMBER, body: "Hello" });
    const [first, second] = (await listContacts(db, ws.id)).rows;
    await deal("Implants", first.id, sam.id);
    expect(await workspaceBadges(db, alex.id, ws.id)).toMatchObject({ contacts: 2, pipeline: 1 });

    // Opening the tab doesn't clear anything; opening a contact clears them and their deal.
    await markTabSeen(db, alex.id, ws.id, "contacts");
    expect((await workspaceBadges(db, alex.id, ws.id)).contacts).toBe(2);
    await markContactSeen(db, alex.id, ws.id, first.id);
    expect(await workspaceBadges(db, alex.id, ws.id)).toMatchObject({ contacts: 1, pipeline: 0 });
    await markItemsSeen(db, alex.id, ws.id, "contact", [second.id]);
    expect((await workspaceBadges(db, alex.id, ws.id)).contacts).toBe(0);

    // Sam's counts are separate.
    expect((await workspaceBadges(db, sam.id, ws.id)).contacts).toBe(2);
    // Turning it back on starts from zero.
    await setClearPerItem(db, sam.id, false);
    await setClearPerItem(db, sam.id, true);
    expect((await workspaceBadges(db, sam.id, ws.id)).contacts).toBe(0);
  });

  it("counts to-dos due today or overdue, and only the person's own accounts", async () => {
    const alex = await makeUser();
    const other = await makeUser("Other");
    const ws = await makeWorkspace(alex.id);
    await makeWorkspace(other.id, "Someone else's");
    await addTodo(db, alex.id, { title: "Overdue", dueDate: "2026-01-01" });
    await addTodo(db, alex.id, { title: "Today", dueDate: "2026-03-10" });
    await addTodo(db, alex.id, { title: "Later", dueDate: "2026-04-01" });
    await addTodo(db, alex.id, { title: "Whenever" });

    const badges = await allBadges(db, alex.id, "2026-03-10");
    expect(badges.todos).toBe(2);
    expect(Object.keys(badges.accounts)).toEqual([ws.id]);
  });
});
