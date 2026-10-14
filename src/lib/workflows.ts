import type { WorkflowCondition, WorkflowStep, WorkflowTrigger } from "@/db/schema";
import { INTENT_LABEL, isIntent } from "@/lib/ai";

// Words for the workflow builder, shared by the server and the browser.

export const TRIGGER_LABEL: Record<WorkflowTrigger["type"], string> = {
  manual: "Added by hand",
  contact_created: "New contact",
  tag_added: "Tag added",
  sms_received: "Text received",
  email_received: "Email received",
  missed_call: "Missed call",
  appointment_booked: "Appointment booked",
  appointment_canceled: "Appointment canceled",
  deal_stage_changed: "Deal moved to a stage",
  deal_status_changed: "Deal won or lost",
  form_submitted: "Form filled in",
  intent_detected: "AI tagged a message",
  webhook: "Data sent in",
};

export const TRIGGER_HELP: Record<WorkflowTrigger["type"], string> = {
  manual: "You add contacts yourself, from this page.",
  contact_created: "Anyone added: by hand, a booking, a text or email, or another app.",
  tag_added: "A contact gets a certain tag.",
  sms_received: "A contact texts in by text, iMessage or WhatsApp, optionally with a keyword.",
  email_received: "A contact emails in.",
  missed_call: "Someone calls and nobody picks up.",
  appointment_booked: "An appointment is booked, online or by you.",
  appointment_canceled: "An appointment is canceled.",
  deal_stage_changed: "A deal lands in a pipeline stage.",
  deal_status_changed: "A deal is marked won or lost.",
  form_submitted: "Someone fills in one of your website forms.",
  intent_detected: "The AI reads a text, iMessage, WhatsApp or email and tags what it's about. Connect an AI in Settings first.",
  webhook: "Your website or another app (Zapier, Make…) sends a lead in.",
};

export type StepType = WorkflowStep["type"];
export type StepTone = "msg" | "wait" | "do" | "if";

export const STEP_GROUPS: { label: string; types: StepType[] }[] = [
  { label: "Send", types: ["send_sms", "send_email", "notify"] },
  { label: "Wait", types: ["wait", "wait_until_appointment"] },
  { label: "Contact", types: ["add_tag", "remove_tag", "add_note"] },
  { label: "Deals and to-dos", types: ["create_deal", "move_deal", "create_todo"] },
  { label: "Logic and other apps", types: ["if", "webhook"] },
];

export const STEP_LABEL: Record<StepType, string> = {
  send_sms: "Send text",
  send_email: "Send email",
  notify: "Notify me",
  wait: "Wait",
  wait_until_appointment: "Wait until before appointment",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  add_note: "Add note",
  create_deal: "Create deal",
  move_deal: "Move deal",
  create_todo: "Create to-do for me",
  if: "If / else",
  webhook: "Send to another app",
};

export const STEP_TONE: Record<StepType, StepTone> = {
  send_sms: "msg",
  send_email: "msg",
  notify: "msg",
  wait: "wait",
  wait_until_appointment: "wait",
  add_tag: "do",
  remove_tag: "do",
  add_note: "do",
  create_deal: "do",
  move_deal: "do",
  create_todo: "do",
  webhook: "do",
  if: "if",
};

export const CONDITION_LABEL: Record<WorkflowCondition["type"], string> = {
  replied: "Replied since starting",
  has_upcoming_appointment: "Has an upcoming appointment",
  text_consent: "Agreed to texts",
  has_tag: "Has a tag",
  has_email: "Has an email address",
  has_phone: "Has a phone number",
};

export function describeCondition(c: WorkflowCondition) {
  return c.type === "has_tag" ? `Has tag "${c.tag}"` : CONDITION_LABEL[c.type];
}

export const MERGE_FIELDS: { key: string; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "company", label: "Company" },
  { key: "business_name", label: "Business name" },
  { key: "booking_link", label: "Booking link" },
  { key: "appointment_time", label: "Appointment time" },
];

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One-line description of a step, shown on its card. */
export function summarizeStep(step: WorkflowStep, stageName: (id: string) => string | undefined = () => undefined): string {
  switch (step.type) {
    case "send_sms":
      return step.body ? `"${clip(step.body)}"` : "Write the text";
    case "send_email":
      return step.subject ? clip(step.subject) : "Write the email";
    case "notify":
      return step.to ? `${step.channel === "sms" ? "Text" : "Email"} ${step.to}` : "Choose who to notify";
    case "wait":
      return "Then carry on";
    case "wait_until_appointment":
      return step.hoursBefore ? `${plural(step.hoursBefore, "hour")} before` : "Until it starts";
    case "add_tag":
    case "remove_tag":
      return step.tag || "Choose a tag";
    case "add_note":
      return step.body ? clip(step.body) : "Write the note";
    case "create_deal":
      return step.title ? `${clip(step.title, 40)} in ${stageName(step.stageId) ?? "a stage"}` : "Name the deal";
    case "move_deal":
      return stageName(step.stageId) ? `To ${stageName(step.stageId)}` : "Pick a stage";
    case "create_todo":
      return step.title ? `${clip(step.title, 50)}${step.dueInDays ? `, due in ${plural(step.dueInDays, "day")}` : ", due today"}` : "Write the to-do";
    case "webhook":
      return step.url ? clip(step.url.replace(/^https:\/\//, ""), 50) : "Paste the address";
    case "if":
      return describeCondition(step.condition) + "?";
  }
}

export function stepTitle(step: WorkflowStep) {
  if (step.type === "wait") return `Wait ${plural(step.amount, step.unit.slice(0, -1))}`;
  return STEP_LABEL[step.type];
}

export function summarizeTrigger(
  t: WorkflowTrigger,
  stageName: (id: string) => string | undefined = () => undefined,
  formName: (id: string) => string | undefined = () => undefined,
) {
  switch (t.type) {
    case "form_submitted":
      return formName(t.formId) ? `"${formName(t.formId)}" filled in` : "Pick a form";
    case "tag_added":
      return t.tag ? `Tag "${t.tag}" added` : "Choose a tag";
    case "sms_received":
      return t.keyword ? `Text containing "${t.keyword}"` : "Any text";
    case "deal_stage_changed":
      return stageName(t.stageId) ? `Deal moved to ${stageName(t.stageId)}` : "Pick a stage";
    case "deal_status_changed":
      return `Deal marked ${t.status}`;
    case "intent_detected":
      return isIntent(t.intent) ? `Tagged "${INTENT_LABEL[t.intent]}"` : "Pick a tag";
    default:
      return TRIGGER_HELP[t.type];
  }
}

export function newStepId() {
  return Math.random().toString(36).slice(2, 10);
}

/** A fresh step of a given type, with sensible starting values. */
export function blankStep(type: StepType, defaults: { pipelineId?: string; stageId?: string } = {}): WorkflowStep {
  const id = newStepId();
  switch (type) {
    case "send_sms":
      return { id, type, body: "" };
    case "send_email":
      return { id, type, subject: "", body: "" };
    case "notify":
      return { id, type, channel: "email", to: "", message: "{{full_name}} needs attention." };
    case "wait":
      return { id, type, amount: 1, unit: "days" };
    case "wait_until_appointment":
      return { id, type, hoursBefore: 24 };
    case "add_tag":
    case "remove_tag":
      return { id, type, tag: "" };
    case "add_note":
      return { id, type, body: "" };
    case "create_deal":
      return { id, type, pipelineId: defaults.pipelineId ?? "", stageId: defaults.stageId ?? "", title: "{{full_name}}", value: 0 };
    case "move_deal":
      return { id, type, stageId: defaults.stageId ?? "" };
    case "create_todo":
      return { id, type, title: "", dueInDays: 0 };
    case "webhook":
      return { id, type, url: "" };
    case "if":
      return { id, type, condition: { type: "replied" }, then: [], else: [] };
  }
}

export function blankTrigger(type: WorkflowTrigger["type"], defaults: { stageId?: string; formId?: string } = {}): WorkflowTrigger {
  switch (type) {
    case "form_submitted":
      return { type, formId: defaults.formId ?? "" };
    case "tag_added":
      return { type, tag: "" };
    case "sms_received":
      return { type, keyword: "" };
    case "deal_stage_changed":
      return { type, stageId: defaults.stageId ?? "" };
    case "deal_status_changed":
      return { type, status: "won" };
    case "intent_detected":
      return { type, intent: "wants_to_book" };
    default:
      return { type };
  }
}
