import { z } from "zod";
import type { WorkflowStep, WorkflowTrigger } from "@/db/schema";

// ---------------------------------------------------------------------------
// Walking the step tree. Steps are a list; an "if" step holds two more lists.
// A run remembers the id of its next step, so edits to a workflow don't
// confuse contacts already in it (a removed step just ends their run).
// ---------------------------------------------------------------------------

type Location = { list: WorkflowStep[]; index: number; parent: Location | null };

function locate(steps: WorkflowStep[], id: string, parent: Location | null = null): Location | null {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const here: Location = { list: steps, index, parent };
    if (step.id === id) return here;
    if (step.type === "if") {
      const found = locate(step.then, id, here) ?? locate(step.else, id, here);
      if (found) return found;
    }
  }
  return null;
}

export function findStep(steps: WorkflowStep[], id: string): WorkflowStep | null {
  const at = locate(steps, id);
  return at ? at.list[at.index] : null;
}

/** The step that runs after `id` finishes: its next sibling, or (at the end of a branch) whatever follows the if/else. */
export function stepAfter(steps: WorkflowStep[], id: string): string | null {
  let at = locate(steps, id);
  while (at) {
    const next = at.list[at.index + 1];
    if (next) return next.id;
    at = at.parent;
  }
  return null;
}

export function countSteps(steps: WorkflowStep[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === "if" ? countSteps(s.then) + countSteps(s.else) : 0), 0);
}

// ---------------------------------------------------------------------------
// Validation of what the builder saves
// ---------------------------------------------------------------------------

const text = (max: number, what: string) => z.string().trim().min(1, `${what} can't be empty.`).max(max);

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("has_tag"), tag: text(60, "The tag") }),
  z.object({ type: z.literal("replied") }),
  z.object({ type: z.literal("has_upcoming_appointment") }),
  z.object({ type: z.literal("text_consent") }),
  z.object({ type: z.literal("has_email") }),
  z.object({ type: z.literal("has_phone") }),
]);

const id = z.string().min(1).max(40);

export const stepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ id, type: z.literal("send_sms"), body: text(1600, "The text") }),
    z.object({ id, type: z.literal("send_email"), subject: text(200, "The subject"), body: text(20000, "The email") }),
    z.object({ id, type: z.literal("wait"), amount: z.number().int().min(1).max(365), unit: z.enum(["minutes", "hours", "days"]) }),
    z.object({ id, type: z.literal("wait_until_appointment"), hoursBefore: z.number().min(0).max(24 * 30) }),
    z.object({ id, type: z.literal("add_tag"), tag: text(60, "The tag") }),
    z.object({ id, type: z.literal("remove_tag"), tag: text(60, "The tag") }),
    z.object({
      id,
      type: z.literal("create_deal"),
      pipelineId: z.uuid("Pick a pipeline."),
      stageId: z.uuid("Pick a stage."),
      title: text(200, "The deal name"),
      value: z.number().min(0).max(100_000_000),
    }),
    z.object({ id, type: z.literal("move_deal"), stageId: z.uuid("Pick a stage.") }),
    z.object({ id, type: z.literal("create_todo"), title: text(300, "The to-do"), dueInDays: z.number().int().min(0).max(365) }),
    z.object({ id, type: z.literal("notify"), channel: z.enum(["email", "sms"]), to: text(200, "Who to notify"), message: text(1600, "The message") }),
    z.object({ id, type: z.literal("add_note"), body: text(5000, "The note") }),
    z.object({ id, type: z.literal("webhook"), url: z.url({ protocol: /^https$/, error: "The web address must start with https://." }) }),
    z.object({ id, type: z.literal("if"), condition: conditionSchema, then: z.array(stepSchema), else: z.array(stepSchema) }),
  ]),
) as z.ZodType<WorkflowStep>;

export const triggerSchema: z.ZodType<WorkflowTrigger> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("contact_created") }),
  z.object({ type: z.literal("tag_added"), tag: text(60, "The tag") }),
  z.object({ type: z.literal("sms_received"), keyword: z.string().trim().max(60).optional() }),
  z.object({ type: z.literal("email_received") }),
  z.object({ type: z.literal("missed_call") }),
  z.object({ type: z.literal("appointment_booked") }),
  z.object({ type: z.literal("appointment_canceled") }),
  z.object({ type: z.literal("deal_stage_changed"), stageId: z.uuid("Pick a stage.") }),
  z.object({ type: z.literal("deal_status_changed"), status: z.enum(["won", "lost"]) }),
  z.object({ type: z.literal("webhook") }),
]);

/** Checks step ids are unique, so a run's "next step" always means one step. */
export function duplicateIds(steps: WorkflowStep[]): boolean {
  const seen = new Set<string>();
  const walk = (list: WorkflowStep[]): boolean =>
    list.some((s) => {
      if (seen.has(s.id)) return true;
      seen.add(s.id);
      return s.type === "if" && (walk(s.then) || walk(s.else));
    });
  return walk(steps);
}
