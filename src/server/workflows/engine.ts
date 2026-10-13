import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import {
  activities,
  appointments,
  bookingPages,
  contacts,
  deals,
  messages,
  pipelineStages,
  workflowQueue,
  workflowRunLogs,
  workflowRuns,
  workflows,
  workspaces,
  type Contact,
  type Workflow,
  type WorkflowCondition,
  type WorkflowRun,
  type WorkflowStep,
  type Workspace,
} from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { contactName } from "@/lib/format";
import { describeCondition } from "@/lib/workflows";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { MessagingError, sendMessage, type Providers } from "@/server/messaging";
import { createDeal, moveDeal } from "@/server/pipelines";
import { addTodo } from "@/server/todos";
import { findStep, stepAfter } from "./steps";
import { fireTrigger } from "./triggers";

export type EngineDeps = {
  providers: Providers;
  /** Public app URL, for booking links and delivery updates. */
  appUrl?: string;
  /** Whether Twilio is live (delivery updates need a reachable URL). */
  statusCallbacks?: boolean;
  fetch?: typeof fetch;
};

const LOCK_MINUTES = 5;
const MAX_STEPS_PER_TURN = 100;

/**
 * Runs every workflow step that's due, across all accounts. Safe to call from
 * several servers at once: each due run is claimed with SKIP LOCKED.
 */
export async function runDueWorkflows(db: Db, deps: EngineDeps, now = new Date(), limit = 50) {
  const at = now.toISOString();
  const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
  const claimed = await db.execute<{ run_id: string; workspace_id: string }>(sql`
    update workflow_queue set locked_until = ${lockUntil}
    where run_id in (
      select run_id from workflow_queue
      where wake_at <= ${at} and (locked_until is null or locked_until < ${at})
      order by wake_at
      limit ${limit}
      for update skip locked
    )
    returning run_id, workspace_id
  `);
  for (const row of claimed) {
    try {
      await processRun(db, row.workspace_id, row.run_id, deps, now);
    } catch (err) {
      console.error(`Workflow run ${row.run_id} failed`, err);
      await withWorkspace(db, row.workspace_id, async (tx) => {
        await tx
          .update(workflowRuns)
          .set({ status: "failed", finishedAt: now, note: err instanceof Error ? err.message : String(err) })
          .where(eq(workflowRuns.id, row.run_id));
        await tx.delete(workflowQueue).where(eq(workflowQueue.runId, row.run_id));
      });
    }
  }
  return claimed.length;
}

type Loaded = { run: WorkflowRun; workflow: Workflow; contact: Contact; workspace: Workspace };

async function load(db: Db, workspaceId: string, runId: string): Promise<Loaded | null> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ run: workflowRuns, workflow: workflows, contact: contacts })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .innerJoin(contacts, eq(contacts.id, workflowRuns.contactId))
      .where(eq(workflowRuns.id, runId));
    if (!row) return null;
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    return { ...row, workspace };
  });
}

async function log(db: Db, workspaceId: string, runId: string, stepId: string | null, outcome: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.insert(workflowRunLogs).values({ workspaceId, runId, stepId, outcome }));
}

async function finish(db: Db, workspaceId: string, runId: string, now: Date, note?: string) {
  await withWorkspace(db, workspaceId, async (tx) => {
    await tx.update(workflowRuns).set({ status: "completed", nextStepId: null, wakeAt: null, finishedAt: now, note }).where(eq(workflowRuns.id, runId));
    await tx.delete(workflowQueue).where(eq(workflowQueue.runId, runId));
  });
}

export async function processRun(db: Db, workspaceId: string, runId: string, deps: EngineDeps, now = new Date()) {
  for (let i = 0; i < MAX_STEPS_PER_TURN; i++) {
    const loaded = await load(db, workspaceId, runId);
    if (!loaded || !["active", "waiting"].includes(loaded.run.status)) {
      await withWorkspace(db, workspaceId, (tx) => tx.delete(workflowQueue).where(eq(workflowQueue.runId, runId)));
      return;
    }
    const { run, workflow } = loaded;
    if (!run.nextStepId) return finish(db, workspaceId, runId, now);
    const step = findStep(workflow.steps, run.nextStepId);
    if (!step) {
      await log(db, workspaceId, runId, run.nextStepId, "Ended: this step was removed from the workflow");
      return finish(db, workspaceId, runId, now);
    }

    // Branches and waits only move the run along.
    if (step.type === "if") {
      const yes = await checkCondition(db, loaded, step.condition, now);
      const branch = yes ? step.then : step.else;
      await log(db, workspaceId, runId, step.id, `${describeCondition(step.condition)}: ${yes ? "yes" : "no"}`);
      await advance(db, workspaceId, runId, branch[0]?.id ?? stepAfter(workflow.steps, step.id));
      continue;
    }
    if (step.type === "wait" || step.type === "wait_until_appointment") {
      const until = await waitUntil(db, loaded, step, now);
      const next = stepAfter(workflow.steps, step.id);
      if (!until) {
        await log(db, workspaceId, runId, step.id, "Skipped wait: no upcoming appointment far enough away");
        await advance(db, workspaceId, runId, next);
        continue;
      }
      await withWorkspace(db, workspaceId, async (tx) => {
        await tx.update(workflowRuns).set({ status: "waiting", nextStepId: next, wakeAt: until }).where(eq(workflowRuns.id, runId));
        await tx.update(workflowQueue).set({ wakeAt: until, lockedUntil: null }).where(eq(workflowQueue.runId, runId));
        await tx.insert(workflowRunLogs).values({ workspaceId, runId, stepId: step.id, outcome: `Waiting until ${DateTime.fromJSDate(until, { zone: loaded.workspace.timezone }).toFormat("ccc, LLL d 'at' h:mm a")}` });
      });
      return;
    }

    // Move past the step before doing it, so a crash can't send a text twice.
    await advance(db, workspaceId, runId, stepAfter(workflow.steps, step.id));
    let outcome: string;
    try {
      outcome = await perform(db, loaded, step, deps, now);
    } catch (err) {
      outcome = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await log(db, workspaceId, runId, step.id, outcome);
  }
}

async function advance(db: Db, workspaceId: string, runId: string, nextStepId: string | null) {
  await withWorkspace(db, workspaceId, (tx) => tx.update(workflowRuns).set({ status: "active", nextStepId }).where(eq(workflowRuns.id, runId)));
}

// ---------------------------------------------------------------------------
// Merge fields: {{first_name}}, {{first_name|there}} (with a fallback), {{data.city}}…
// ---------------------------------------------------------------------------

async function mergeValues(db: Db, { contact, workspace, run }: Loaded, deps: EngineDeps, now: Date): Promise<Record<string, string>> {
  const [page] = await db.select({ slug: bookingPages.slug }).from(bookingPages).where(eq(bookingPages.workspaceId, workspace.id));
  const appt = await nextAppointment(db, workspace.id, contact.id, run, now);
  const values: Record<string, string> = {
    first_name: contact.firstName,
    last_name: contact.lastName,
    full_name: `${contact.firstName} ${contact.lastName}`.trim(),
    email: contact.email ?? "",
    phone: formatPhone(contact.phone),
    company: contact.company ?? "",
    business_name: workspace.name,
    booking_link: page && deps.appUrl ? `${deps.appUrl}/book/${page.slug}` : "",
    appointment_time: appt ? DateTime.fromJSDate(appt, { zone: workspace.timezone }).toFormat("ccc, LLL d 'at' h:mm a") : "",
  };
  const data = run.context.data;
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (v !== null && typeof v !== "object") values[`data.${k}`] = String(v);
    }
  }
  return values;
}

export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_, key: string, fallback?: string) => values[key.toLowerCase()] || fallback?.trim() || "");
}

/**
 * The appointment a workflow is about: the one that started it (if it's still
 * booked), otherwise the contact's next booked appointment.
 */
async function nextAppointment(db: Db, workspaceId: string, contactId: string, run: WorkflowRun, now: Date): Promise<Date | null> {
  const appointmentId = typeof run.context.appointmentId === "string" ? run.context.appointmentId : null;
  const [row] = await withWorkspace(db, workspaceId, (tx) =>
    tx
      .select({ startsAt: appointments.startsAt })
      .from(appointments)
      .where(
        appointmentId
          ? and(eq(appointments.id, appointmentId), eq(appointments.status, "booked"))
          : and(eq(appointments.contactId, contactId), eq(appointments.status, "booked"), gt(appointments.startsAt, now)),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(1),
  );
  return row?.startsAt ?? null;
}

// ---------------------------------------------------------------------------
// Waits and conditions
// ---------------------------------------------------------------------------

async function waitUntil(db: Db, loaded: Loaded, step: Extract<WorkflowStep, { type: "wait" | "wait_until_appointment" }>, now: Date): Promise<Date | null> {
  if (step.type === "wait") {
    const ms = { minutes: 60_000, hours: 3600_000, days: 86400_000 }[step.unit];
    return new Date(now.getTime() + step.amount * ms);
  }
  const appt = await nextAppointment(db, loaded.workspace.id, loaded.contact.id, loaded.run, now);
  if (!appt) return null;
  const until = new Date(appt.getTime() - step.hoursBefore * 3600_000);
  return until > now ? until : null;
}


async function checkCondition(db: Db, { contact, run, workspace }: Loaded, c: WorkflowCondition, now: Date): Promise<boolean> {
  switch (c.type) {
    case "has_tag":
      return contact.tags.includes(c.tag.toLowerCase());
    case "text_consent":
      return contact.smsConsent === "granted";
    case "has_email":
      return Boolean(contact.email);
    case "has_phone":
      return Boolean(contact.phone);
    case "replied": {
      const [m] = await withWorkspace(db, workspace.id, (tx) =>
        tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.contactId, contact.id), eq(messages.direction, "inbound"), gte(messages.createdAt, run.startedAt)))
          .limit(1),
      );
      return Boolean(m);
    }
    case "has_upcoming_appointment": {
      const [a] = await withWorkspace(db, workspace.id, (tx) =>
        tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(and(eq(appointments.contactId, contact.id), eq(appointments.status, "booked"), gt(appointments.startsAt, now)))
          .limit(1),
      );
      return Boolean(a);
    }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function perform(db: Db, loaded: Loaded, step: WorkflowStep, deps: EngineDeps, now: Date): Promise<string> {
  const { contact, workspace, workflow } = loaded;
  const fill = async (t: string) => fillTemplate(t, await mergeValues(db, loaded, deps, now));
  const opts = { appUrl: deps.statusCallbacks ? deps.appUrl : undefined };

  switch (step.type) {
    case "send_sms":
    case "send_email": {
      try {
        const msg = await sendMessage(
          db,
          workspace.id,
          step.type === "send_sms"
            ? { contactId: contact.id, channel: "sms", body: await fill(step.body) }
            : { contactId: contact.id, channel: "email", subject: await fill(step.subject), body: await fill(step.body) },
          null,
          deps.providers,
          opts,
        );
        if (msg.status === "failed") return `Failed: ${msg.error}`;
        return step.type === "send_sms" ? "Sent text" : "Sent email";
      } catch (err) {
        if (err instanceof MessagingError) return `Skipped: ${err.message}`;
        throw err;
      }
    }

    case "add_tag":
    case "remove_tag": {
      const tag = step.tag.trim().toLowerCase();
      const has = contact.tags.includes(tag);
      if (step.type === "add_tag" ? has : !has) return `Already ${has ? "had" : "didn't have"} tag "${tag}"`;
      await withWorkspace(db, workspace.id, async (tx) => {
        const tags = step.type === "add_tag" ? [...contact.tags, tag] : contact.tags.filter((t) => t !== tag);
        await tx.update(contacts).set({ tags, updatedAt: now }).where(eq(contacts.id, contact.id));
        if (step.type === "add_tag") await fireTrigger(tx, workspace.id, { type: "tag_added", contactId: contact.id, tag }, now);
      });
      return step.type === "add_tag" ? `Added tag "${tag}"` : `Removed tag "${tag}"`;
    }

    case "create_deal": {
      await createDeal(
        db,
        workspace.id,
        { pipelineId: step.pipelineId, stageId: step.stageId, title: await fill(step.title), valueCents: Math.round(step.value * 100), contactId: contact.id },
        null,
      );
      return "Created a deal";
    }

    case "move_deal": {
      const target = await withWorkspace(db, workspace.id, async (tx) => {
        const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, step.stageId));
        if (!stage) return null;
        const [deal] = await tx
          .select()
          .from(deals)
          .where(and(eq(deals.contactId, contact.id), eq(deals.pipelineId, stage.pipelineId), eq(deals.status, "open")))
          .orderBy(desc(deals.updatedAt))
          .limit(1);
        return deal ? { deal, stage } : { deal: null, stage };
      });
      if (!target) return "Skipped: that stage no longer exists";
      if (!target.deal) return "Skipped: no open deal in that pipeline";
      if (target.deal.stageId === step.stageId) return `Already in ${target.stage.name}`;
      await moveDeal(db, workspace.id, target.deal.id, step.stageId, 0, null);
      return `Moved deal to ${target.stage.name}`;
    }

    case "create_todo": {
      if (!workflow.createdBy) return "Skipped: the person who made this workflow no longer exists";
      const due = DateTime.fromJSDate(now, { zone: workspace.timezone }).plus({ days: step.dueInDays }).toISODate();
      await addTodo(db, workflow.createdBy, { title: await fill(step.title), dueDate: due, workspaceId: workspace.id });
      return "Created a to-do";
    }

    case "notify": {
      const message = await fill(step.message);
      if (step.channel === "email") {
        if (!workspace.emailFromAddress) return "Skipped: set a from email address in Settings first";
        await deps.providers.email.sendEmail({
          from: workspace.emailFromAddress,
          fromName: "ShabCRM",
          to: step.to,
          subject: `${workflow.name}: ${contactName(contact)}`,
          text: message,
        });
        return `Notified ${step.to}`;
      }
      const to = normalizePhone(step.to);
      if (!to) return "Skipped: the phone number to notify isn't valid";
      if (!workspace.smsNumber) return "Skipped: set a texting number in Settings first";
      await deps.providers.sms.sendSms({ from: workspace.smsNumber, to, body: message });
      return `Notified ${formatPhone(to)}`;
    }

    case "add_note": {
      await withWorkspace(db, workspace.id, (tx) =>
        fill(step.body).then((body) => tx.insert(activities).values({ workspaceId: workspace.id, contactId: contact.id, kind: "note", body })),
      );
      return "Added a note";
    }

    case "webhook": {
      const res = await (deps.fetch ?? fetch)(step.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "ShabCRM-Workflows" },
        body: JSON.stringify({
          workflow: { id: workflow.id, name: workflow.name },
          account: { id: workspace.id, name: workspace.name },
          contact: {
            id: contact.id,
            first_name: contact.firstName,
            last_name: contact.lastName,
            email: contact.email,
            phone: contact.phone,
            company: contact.company,
            tags: contact.tags,
          },
          trigger: loaded.run.context,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? `Sent data (${res.status})` : `Failed: the other app answered ${res.status}`;
    }

    case "if":
    case "wait":
    case "wait_until_appointment":
      return "";
  }
}

/** Ends everyone's runs in a workflow (the "stop everyone" button). */
export async function stopAllRuns(db: Db, workspaceId: string, workflowId: string, now = new Date()) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const runs = await tx
      .update(workflowRuns)
      .set({ status: "stopped", nextStepId: null, finishedAt: now, note: "Stopped by hand" })
      .where(and(eq(workflowRuns.workflowId, workflowId), inArray(workflowRuns.status, ["active", "waiting"])))
      .returning({ id: workflowRuns.id });
    if (runs.length) await tx.delete(workflowQueue).where(inArray(workflowQueue.runId, runs.map((r) => r.id)));
    return runs.length;
  });
}
