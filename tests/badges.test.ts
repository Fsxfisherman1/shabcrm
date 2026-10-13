import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { memberships, workspaces } from "@/db/schema";
import { allBadges, markTabSeen, workspaceBadges } from "@/server/badges";
import { createContact } from "@/server/contacts";
import { receiveSms } from "@/server/messaging";
import { createDeal, listPipelinesWithStages } from "@/server/pipelines";
import { addTodo } from "@/server/todos";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

const NUMBER = "+14155550000";

describe("sidebar counts", () => {
  beforeEach(resetDb);

  it("counts what's new since each person last opened the tab", async () => {
    const alex = await makeUser();
    const sam = await makeUser("Sam");
    const ws = await makeWorkspace(alex.id);
    await db.insert(memberships).values({ userId: sam.id, workspaceId: ws.id, role: "member" });
    await db.update(workspaces).set({ smsNumber: NUMBER }).where(eq(workspaces.id, ws.id));

    await createContact(db, ws.id, { firstName: "Jane", phone: "4155550101" }, alex.id);
    await receiveSms(db, { from: "+14155550188", to: NUMBER, body: "Hi" }); // a new contact, and an unread text
    const [pipeline] = await listPipelinesWithStages(db, ws.id);
    await createDeal(db, ws.id, { pipelineId: pipeline.id, stageId: pipeline.stages[0].id, title: "Kitchen", valueCents: 0 }, alex.id);

    expect(await workspaceBadges(db, alex.id, ws.id)).toMatchObject({ inbox: 1, contacts: 2, pipeline: 1, calendar: 0, forms: 0, automations: 0 });

    // Alex opens Contacts; Sam hasn't, so Sam still sees them as new.
    await markTabSeen(db, alex.id, ws.id, "contacts");
    expect((await workspaceBadges(db, alex.id, ws.id)).contacts).toBe(0);
    expect((await workspaceBadges(db, sam.id, ws.id)).contacts).toBe(2);

    await createContact(db, ws.id, { firstName: "Lee", email: "lee@example.com" }, sam.id);
    expect((await workspaceBadges(db, alex.id, ws.id)).contacts).toBe(1);
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
