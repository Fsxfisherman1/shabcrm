import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { TRIGGER_LABEL } from "@/lib/workflows";
import { workflowQueue, workflowRunLogs, workflowRuns, workflows, type Workflow } from "@/db/schema";

export type TriggerEvent =
  | { type: "contact_created"; contactId: string }
  | { type: "tag_added"; contactId: string; tag: string }
  | { type: "sms_received"; contactId: string; body: string }
  | { type: "email_received"; contactId: string }
  | { type: "missed_call"; contactId: string }
  | { type: "appointment_booked"; contactId: string; appointmentId: string; startsAt: string }
  | { type: "appointment_canceled"; contactId: string; appointmentId: string }
  | { type: "deal_stage_changed"; contactId: string; dealId: string; stageId: string }
  | { type: "deal_status_changed"; contactId: string; dealId: string; status: "won" | "lost" | "open" }
  | { type: "webhook"; contactId: string; workflowId: string; data: Record<string, unknown> }
  | { type: "manual"; contactId: string; workflowId: string };


function matches(workflow: Workflow, event: TriggerEvent): boolean {
  const t = workflow.trigger;
  if (t.type !== event.type) return false;
  switch (event.type) {
    case "tag_added":
      return t.type === "tag_added" && t.tag.toLowerCase() === event.tag.toLowerCase();
    case "sms_received": {
      const keyword = t.type === "sms_received" ? t.keyword?.trim().toLowerCase() : "";
      return !keyword || ` ${event.body.toLowerCase().replace(/[^a-z0-9 ]/g, " ")} `.includes(` ${keyword} `);
    }
    case "deal_stage_changed":
      return t.type === "deal_stage_changed" && t.stageId === event.stageId;
    case "deal_status_changed":
      return t.type === "deal_status_changed" && t.status === event.status;
    case "webhook":
    case "manual":
      return workflow.id === event.workflowId;
    default:
      return true;
  }
}

/** Puts a contact into a workflow. Returns the run id, or null if they can't enter again. */
export async function enroll(tx: Tx, workflow: Workflow, contactId: string, context: Record<string, unknown>, now = new Date()) {
  if (!workflow.allowReentry) {
    const [already] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.contactId, contactId)))
      .limit(1);
    if (already) return null;
  }
  const first = workflow.steps[0]?.id ?? null;
  const [run] = await tx
    .insert(workflowRuns)
    .values({
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      contactId,
      status: first ? "active" : "completed",
      nextStepId: first,
      wakeAt: first ? now : null,
      context,
      finishedAt: first ? null : now,
    })
    .returning();
  await tx.insert(workflowRunLogs).values({
    workspaceId: workflow.workspaceId,
    runId: run.id,
    outcome: `Started: ${TRIGGER_LABEL[context.trigger as TriggerEvent["type"]] ?? "started"}`,
  });
  if (first) await tx.insert(workflowQueue).values({ runId: run.id, workspaceId: workflow.workspaceId, wakeAt: now });
  return run.id;
}

/** Ends a contact's runs in workflows set to stop when they reply. */
async function stopOnReply(tx: Tx, workspaceId: string, contactId: string, now: Date) {
  const runs = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(
      and(
        eq(workflowRuns.contactId, contactId),
        inArray(workflowRuns.status, ["active", "waiting"]),
        eq(workflows.stopOnReply, true),
      ),
    );
  if (!runs.length) return;
  const ids = runs.map((r) => r.id);
  await tx.update(workflowRuns).set({ status: "stopped", nextStepId: null, finishedAt: now, note: "Contact replied" }).where(inArray(workflowRuns.id, ids));
  await tx.delete(workflowQueue).where(inArray(workflowQueue.runId, ids));
  await tx.insert(workflowRunLogs).values(ids.map((runId) => ({ workspaceId, runId, outcome: "Stopped: the contact replied" })));
}

/**
 * Called from inside the transaction that made the change (a contact added, a
 * text received…), so starting workflows succeeds or fails with it. The steps
 * themselves run later in the background.
 */
export async function fireTrigger(tx: Tx, workspaceId: string, event: TriggerEvent, now = new Date()) {
  if (event.type === "sms_received" || event.type === "email_received") await stopOnReply(tx, workspaceId, event.contactId, now);

  // Adding someone by hand works while a workflow is off, so it can be tested.
  const scope =
    event.type === "manual"
      ? eq(workflows.id, event.workflowId)
      : event.type === "webhook"
        ? and(eq(workflows.id, event.workflowId), eq(workflows.enabled, true))
        : eq(workflows.enabled, true);
  const candidates = await tx
    .select()
    .from(workflows)
    .where(
      and(
        sql`${workflows.trigger}->>'type' = ${event.type}`,
        scope,
      ),
    );
  const { contactId, type, ...rest } = event;
  const started: string[] = [];
  for (const wf of candidates) {
    if (!matches(wf, event)) continue;
    const runId = await enroll(tx, wf, contactId, { trigger: type, ...rest }, now);
    if (runId) started.push(runId);
  }
  return started;
}
