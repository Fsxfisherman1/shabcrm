import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { contacts } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { createContact, getContact, listContacts } from "@/server/contacts";
import { listPipelines } from "@/server/pipelines";
import { DEFAULT_STAGES, listWorkspacesForUser } from "@/server/workspaces";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

describe("workspace isolation", () => {
  beforeEach(resetDb);

  it("seeds a default pipeline for a new workspace", async () => {
    const alex = await makeUser();
    const ws = await makeWorkspace(alex.id);
    const pipelines = await listPipelines(db, ws.id);
    expect(pipelines).toHaveLength(1);
    const stages = await withWorkspace(db, ws.id, (tx) =>
      tx.execute(sql`select name from pipeline_stages order by position`),
    );
    expect([...stages].map((s) => s.name)).toEqual(DEFAULT_STAGES);
    expect(await listWorkspacesForUser(db, alex.id)).toHaveLength(1);
  });

  it("never shows one client's contacts to another", async () => {
    const alex = await makeUser();
    const a = await makeWorkspace(alex.id, "Client A");
    const b = await makeWorkspace(alex.id, "Client B");
    const contact = await createContact(db, a.id, { firstName: "Jane", email: "jane@a.com" }, alex.id);

    expect((await listContacts(db, a.id)).total).toBe(1);
    expect((await listContacts(db, b.id)).total).toBe(0);
    expect(await getContact(db, b.id, contact.id)).toBeNull();
  });

  it("blocks writes into another workspace even if a query forgets to filter", async () => {
    const alex = await makeUser();
    const a = await makeWorkspace(alex.id, "Client A");
    const b = await makeWorkspace(alex.id, "Client B");
    const contact = await createContact(db, a.id, { firstName: "Jane", email: "jane@a.com" }, alex.id);

    // An unfiltered update from workspace B touches nothing.
    await withWorkspace(db, b.id, (tx) => tx.update(contacts).set({ firstName: "Hacked" }));
    const [row] = await withWorkspace(db, a.id, (tx) =>
      tx.select().from(contacts).where(eq(contacts.id, contact.id)),
    );
    expect(row.firstName).toBe("Jane");

    // Inserting a row tagged with workspace A from inside B is rejected.
    await expect(
      withWorkspace(db, b.id, (tx) => tx.insert(contacts).values({ workspaceId: a.id, firstName: "Sneaky" })),
    ).rejects.toThrow();
  });

  it("hides tenant rows outside a workspace transaction", async () => {
    const alex = await makeUser();
    const a = await makeWorkspace(alex.id);
    await createContact(db, a.id, { firstName: "Jane", email: "jane@a.com" }, alex.id);
    // As the app role with no workspace set...
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role shab_app`);
      return tx.select().from(contacts);
    });
    expect(rows).toHaveLength(0);
    // ...and as a non-superuser table owner, since row security is forced on
    // owners too. (Superusers, common on hosted Postgres, always bypass it.)
    const [{ rolsuper }] = await db.execute<{ rolsuper: boolean }>(
      sql`select rolsuper from pg_roles where rolname = current_user`,
    );
    if (!rolsuper) expect(await db.select().from(contacts)).toHaveLength(0);
  });
});
