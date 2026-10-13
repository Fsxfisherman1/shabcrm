import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Accounts (workspaces). The agency is one workspace; each client is another.
// ---------------------------------------------------------------------------

export const workspaceKind = pgEnum("workspace_kind", ["agency", "client"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: workspaceKind("kind").notNull().default("client"),
  timezone: text("timezone").notNull().default("America/New_York"),
  // Messaging settings
  smsNumber: text("sms_number").unique(), // this account's texting number, E.164
  forwardCallsTo: text("forward_calls_to"), // the business's real phone, E.164
  missedCallTextEnabled: boolean("missed_call_text_enabled").notNull().default(false),
  missedCallText: text("missed_call_text")
    .notNull()
    .default("Sorry we missed your call! How can we help? You can reply right here by text."),
  emailFromName: text("email_from_name"),
  emailFromAddress: text("email_from_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

// ---------------------------------------------------------------------------
// Tenant tables. Every row carries workspace_id and is protected by row-level
// security (see drizzle/0001_row_level_security.sql).
// ---------------------------------------------------------------------------

export const smsConsent = pgEnum("sms_consent", ["granted", "none", "revoked"]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    phone: text("phone"), // E.164, e.g. +15551234567
    company: text("company"),
    source: text("source"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
    smsConsent: smsConsent("sms_consent").notNull().default("none"),
    smsConsentSource: text("sms_consent_source"),
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    emailOptOut: boolean("email_opt_out").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contacts_workspace_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("contacts_workspace_email_uq")
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    uniqueIndex("contacts_workspace_phone_uq")
      .on(t.workspaceId, t.phone)
      .where(sql`${t.phone} is not null`),
    index("contacts_tags_idx").using("gin", t.tags),
  ],
);

export const activityKind = pgEnum("activity_kind", [
  "note",
  "created",
  "imported",
  "deal_created",
  "stage_changed",
  "consent_changed",
  "missed_call",
  "appointment",
]);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: activityKind("kind").notNull(),
    body: text("body").notNull().default(""),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activities_contact_idx").on(t.contactId, t.createdAt)],
);

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("stages_pipeline_idx").on(t.pipelineId, t.position)],
);

export const dealStatus = pgEnum("deal_status", ["open", "won", "lost"]);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    valueCents: integer("value_cents").notNull().default(0),
    status: dealStatus("status").notNull().default("open"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deals_stage_idx").on(t.stageId, t.position)],
);

export const messageChannel = pgEnum("message_channel", ["sms", "email"]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageStatus = pgEnum("message_status", ["queued", "sent", "delivered", "failed", "received"]);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: messageChannel("channel").notNull(),
    direction: messageDirection("direction").notNull(),
    status: messageStatus("status").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    providerId: text("provider_id"),
    error: text("error"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_contact_idx").on(t.contactId, t.createdAt),
    index("messages_workspace_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("messages_provider_uq").on(t.providerId).where(sql`${t.providerId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// Personal to-do list (per user, optionally tied to an account or contact)
// ---------------------------------------------------------------------------

export const todos = pgTable(
  "todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    dueDate: date("due_date"),
    done: boolean("done").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("todos_user_idx").on(t.userId, t.done)],
);

// ---------------------------------------------------------------------------
// Calendars and booking
// ---------------------------------------------------------------------------

/** Mon=1 … Sun=7 (ISO weekday) → open hours as "HH:MM" pairs in the account's time zone. */
export type WeeklyHours = Partial<Record<"1" | "2" | "3" | "4" | "5" | "6" | "7", { start: string; end: string }[]>>;

/**
 * The account's public booking page. Like `workspaces`, this is looked up by
 * slug from the public page, so it isn't behind row-level security; it holds
 * nothing private.
 */
export const bookingPages = pgTable("booking_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  minNoticeHours: integer("min_notice_hours").notNull().default(2),
  maxDaysAhead: integer("max_days_ahead").notNull().default(30),
  weeklyHours: jsonb("weekly_hours").$type<WeeklyHours>().notNull(),
  // Secret for the read-only calendar feed other calendar apps can subscribe to.
  feedToken: text("feed_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calendarKind = pgEnum("calendar_kind", ["google", "microsoft", "caldav", "ics"]);

/** An outside calendar connected to an account: checked for busy times, optionally written to. */
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: calendarKind("kind").notNull(),
    name: text("name").notNull(),
    // Google/Microsoft: the calendar id ("primary"); CalDAV: the calendar URL; ICS: the feed URL.
    externalId: text("external_id").notNull(),
    // Tokens or passwords, encrypted (see src/server/calendars/secrets.ts).
    credentials: text("credentials"),
    checkConflicts: boolean("check_conflicts").notNull().default(true),
    addBookings: boolean("add_bookings").notNull().default(false),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("calendars_workspace_idx").on(t.workspaceId)],
);

export const appointmentStatus = pgEnum("appointment_status", ["booked", "canceled"]);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatus("status").notNull().default("booked"),
    source: text("source").notNull().default("Manual"),
    // Where the event was copied to, so it can be removed if canceled.
    calendarId: uuid("calendar_id").references(() => calendars.id, { onDelete: "set null" }),
    externalEventId: text("external_event_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("appointments_workspace_idx").on(t.workspaceId, t.startsAt),
    index("appointments_contact_idx").on(t.contactId, t.startsAt),
  ],
);

// ---------------------------------------------------------------------------
// Workflow automations
// ---------------------------------------------------------------------------

export type WorkflowTrigger =
  | { type: "manual" }
  | { type: "contact_created" }
  | { type: "tag_added"; tag: string }
  | { type: "sms_received"; keyword?: string }
  | { type: "email_received" }
  | { type: "missed_call" }
  | { type: "appointment_booked" }
  | { type: "appointment_canceled" }
  | { type: "deal_stage_changed"; stageId: string }
  | { type: "deal_status_changed"; status: "won" | "lost" }
  | { type: "webhook" };

export type WorkflowCondition =
  | { type: "has_tag"; tag: string }
  | { type: "replied" }
  | { type: "has_upcoming_appointment" }
  | { type: "text_consent" }
  | { type: "has_email" }
  | { type: "has_phone" };

export type WorkflowStep = { id: string } & (
  | { type: "send_sms"; body: string }
  | { type: "send_email"; subject: string; body: string }
  | { type: "wait"; amount: number; unit: "minutes" | "hours" | "days" }
  | { type: "wait_until_appointment"; hoursBefore: number }
  | { type: "add_tag"; tag: string }
  | { type: "remove_tag"; tag: string }
  | { type: "create_deal"; pipelineId: string; stageId: string; title: string; value: number }
  | { type: "move_deal"; stageId: string }
  | { type: "create_todo"; title: string; dueInDays: number }
  | { type: "notify"; channel: "email" | "sms"; to: string; message: string }
  | { type: "add_note"; body: string }
  | { type: "webhook"; url: string }
  | { type: "if"; condition: WorkflowCondition; then: WorkflowStep[]; else: WorkflowStep[] }
);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull(),
    steps: jsonb("steps").$type<WorkflowStep[]>().notNull().default([]),
    // Stop a contact's run when they text or email back.
    stopOnReply: boolean("stop_on_reply").notNull().default(true),
    // Let a contact go through again while (or after) they've been through once.
    allowReentry: boolean("allow_reentry").notNull().default(false),
    // Secret for the "data sent in" (webhook) trigger URL.
    hookToken: text("hook_token").notNull().unique(),
    // To-dos the workflow creates go to this person.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflows_workspace_idx").on(t.workspaceId)],
);

export const workflowRunStatus = pgEnum("workflow_run_status", ["active", "waiting", "completed", "stopped", "failed"]);

/** One contact's trip through a workflow. */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: workflowRunStatus("status").notNull().default("active"),
    // The id of the next step to run; null when finished.
    nextStepId: text("next_step_id"),
    wakeAt: timestamp("wake_at", { withTimezone: true }),
    // What started it (e.g. the appointment, the text, data sent in).
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("workflow_runs_workflow_idx").on(t.workflowId, t.startedAt),
    index("workflow_runs_contact_idx").on(t.contactId, t.status),
  ],
);

export const workflowRunLogs = pgTable(
  "workflow_run_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id"),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_run_logs_run_idx").on(t.runId, t.createdAt)],
);

/**
 * Which runs are due, across all accounts. The background worker needs to find
 * them before it knows which account to switch into, so this holds only ids and
 * times, and has no row-level security.
 */
export const workflowQueue = pgTable(
  "workflow_queue",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    wakeAt: timestamp("wake_at", { withTimezone: true }).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("workflow_queue_wake_idx").on(t.wakeAt)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Pipeline = typeof pipelines.$inferSelect;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type Todo = typeof todos.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type BookingPage = typeof bookingPages.$inferSelect;
export type Calendar = typeof calendars.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
