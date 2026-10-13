import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { user } from "@/db/schema";
import { createWorkspace } from "@/server/workspaces";

export const db = createDb(process.env.DATABASE_URL!);

export async function resetDb() {
  await db.execute(
    sql`truncate table form_submissions, forms, workflow_queue, workflow_run_logs, workflow_runs, workflows, todos, appointments, calendars, booking_pages, messages, activities, deals, pipeline_stages, pipelines, contacts, memberships, workspaces, session, account, verification, "user" cascade`,
  );
}

export async function makeUser(name = "Alex") {
  const [u] = await db
    .insert(user)
    .values({ id: randomUUID(), name, email: `${randomUUID()}@example.com` })
    .returning();
  return u;
}

export async function makeWorkspace(ownerId: string, name = "Acme Plumbing") {
  return createWorkspace(db, { name, kind: "client", ownerId });
}
