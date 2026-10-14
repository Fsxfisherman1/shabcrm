import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { contacts, workflowRunLogs, workflowRuns, workflows, type WorkflowStep, type WorkflowTrigger } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { normalizePhone } from "@/lib/phone";
import { findExisting } from "@/server/contacts";
import { duplicateIds, stepSchema, triggerSchema } from "./steps";
import { enroll, fireTrigger } from "./triggers";

export { fireTrigger, type TriggerEvent } from "./triggers";

export class WorkflowError extends Error {}

export async function listWorkflows(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const list = await tx.select().from(workflows).orderBy(desc(workflows.updatedAt));
    const counts = await tx
      .select({ workflowId: workflowRuns.workflowId, status: workflowRuns.status, n: count() })
      .from(workflowRuns)
      .groupBy(workflowRuns.workflowId, workflowRuns.status);
    return list.map((wf) => {
      const mine = counts.filter((c) => c.workflowId === wf.id);
      const sum = (statuses: string[]) => mine.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
      return { ...wf, inProgress: sum(["active", "waiting"]), finished: sum(["completed", "stopped", "failed"]) };
    });
  });
}

export async function getWorkflow(db: Db, workspaceId: string, workflowId: string) {
  const [wf] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(workflows).where(eq(workflows.id, workflowId)));
  return wf ?? null;
}

export async function createWorkflow(
  db: Db,
  workspaceId: string,
  input: { name: string; trigger: WorkflowTrigger; steps?: WorkflowStep[] },
  userId: string | null,
) {
  const [wf] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .insert(workflows)
      .values({
        workspaceId,
        name: input.name.trim() || "Untitled workflow",
        trigger: input.trigger,
        steps: input.steps ?? [],
        hookToken: randomBytes(18).toString("base64url"),
        createdBy: userId,
      })
      .returning(),
  );
  return wf;
}

export type WorkflowInput = {
  name: string;
  enabled: boolean;
  trigger: unknown;
  steps: unknown;
  stopOnReply: boolean;
  stopOnBooking?: boolean;
  stopOnWon?: boolean;
  allowReentry: boolean;
};

/** Saves the builder's work, after checking every step is complete. */
export async function saveWorkflow(db: Db, workspaceId: string, workflowId: string, input: WorkflowInput) {
  const name = input.name.trim();
  if (!name) throw new WorkflowError("Give the workflow a name.");
  const trigger = triggerSchema.safeParse(input.trigger);
  if (!trigger.success) throw new WorkflowError(`Trigger: ${trigger.error.issues[0].message}`);
  const steps = stepSchema.array().max(200).safeParse(input.steps);
  if (!steps.success) throw new WorkflowError(`A step isn't finished: ${steps.error.issues[0].message}`);
  if (duplicateIds(steps.data)) throw new WorkflowError("Two steps share an id. Reload and try again.");
  if (input.enabled && steps.data.length === 0) throw new WorkflowError("Add at least one step before turning it on.");

  const [wf] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(workflows)
      .set({
        name,
        enabled: input.enabled,
        trigger: trigger.data,
        steps: steps.data,
        stopOnReply: input.stopOnReply,
        stopOnBooking: input.stopOnBooking ?? false,
        stopOnWon: input.stopOnWon ?? false,
        allowReentry: input.allowReentry,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, workflowId))
      .returning(),
  );
  if (!wf) throw new WorkflowError("Workflow not found.");
  return wf;
}

export async function setWorkflowEnabled(db: Db, workspaceId: string, workflowId: string, enabled: boolean) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const [wf] = await tx.select().from(workflows).where(eq(workflows.id, workflowId));
    if (!wf) throw new WorkflowError("Workflow not found.");
    if (enabled && wf.steps.length === 0) throw new WorkflowError("Add at least one step before turning it on.");
    await tx.update(workflows).set({ enabled, updatedAt: new Date() }).where(eq(workflows.id, workflowId));
  });
}

export async function deleteWorkflow(db: Db, workspaceId: string, workflowId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(workflows).where(eq(workflows.id, workflowId)));
}

/** "Add a contact to this workflow" by hand. Works while the workflow is off, for testing. */
export async function enrollByHand(db: Db, workspaceId: string, workflowId: string, contactId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [wf] = await tx.select().from(workflows).where(eq(workflows.id, workflowId));
    if (!wf) throw new WorkflowError("Workflow not found.");
    if (!wf.steps.length) throw new WorkflowError("Add a step first.");
    const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId));
    if (!contact) throw new WorkflowError("Contact not found.");
    const [running] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.contactId, contactId), inArray(workflowRuns.status, ["active", "waiting"])));
    if (running) throw new WorkflowError("That contact is already in this workflow.");
    // Adding by hand always lets someone go through again.
    await enroll(tx, { ...wf, allowReentry: true }, contactId, { trigger: "manual" });
  });
}

/**
 * Data sent in from another app (a website form, Zapier, Make…). Finds or
 * adds the contact by email or phone, then starts the workflow for them.
 */
export async function receiveWorkflowWebhook(db: Db, workspaceId: string, token: string, data: Record<string, unknown>) {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = data[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  return withWorkspace(db, workspaceId, async (tx) => {
    const [wf] = await tx.select().from(workflows).where(eq(workflows.hookToken, token));
    if (!wf || wf.trigger.type !== "webhook") return { ok: false as const, status: 404, error: "Not found" };
    if (!wf.enabled) return { ok: false as const, status: 409, error: "This workflow is turned off." };

    const emailRaw = pick("email", "Email", "email_address");
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
    const phone = normalizePhone(pick("phone", "Phone", "phone_number", "mobile"));
    if (!email && !phone) return { ok: false as const, status: 422, error: "Send an email or phone so we know who this is." };

    let contact = await findExisting(tx, email, phone);
    if (!contact) {
      let first = pick("first_name", "firstName", "First Name");
      let last = pick("last_name", "lastName", "Last Name");
      if (!first && !last) {
        const [head = "", ...tail] = pick("name", "Name", "full_name").split(/\s+/);
        first = head;
        last = tail.join(" ");
      }
      [contact] = await tx
        .insert(contacts)
        .values({ workspaceId, firstName: first, lastName: last, email, phone, source: `Workflow: ${wf.name}` })
        .returning();
      await fireTrigger(tx, workspaceId, { type: "contact_created", contactId: contact.id });
    }
    const started = await fireTrigger(tx, workspaceId, { type: "webhook", contactId: contact.id, workflowId: wf.id, data });
    return { ok: true as const, contactId: contact.id, started: started.length > 0 };
  });
}

export async function listRuns(db: Db, workspaceId: string, workflowId: string, limit = 50) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const runs = await tx
      .select({ run: workflowRuns, contact: { id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone } })
      .from(workflowRuns)
      .innerJoin(contacts, eq(contacts.id, workflowRuns.contactId))
      .where(eq(workflowRuns.workflowId, workflowId))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
    const logs = runs.length
      ? await tx
          .select()
          .from(workflowRunLogs)
          .where(inArray(workflowRunLogs.runId, runs.map((r) => r.run.id)))
          .orderBy(workflowRunLogs.createdAt, sql`${workflowRunLogs.id}`)
      : [];
    return runs.map((r) => ({ ...r, logs: logs.filter((l) => l.runId === r.run.id) }));
  });
}
