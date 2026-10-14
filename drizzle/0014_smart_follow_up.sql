CREATE TABLE "ai_queue" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"about" text DEFAULT '' NOT NULL,
	"tag_messages" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "lead_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "lead_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "stop_on_booking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "stop_on_won" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lead_alert_minutes" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lead_alert_email" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lead_alert_phone" text;--> statement-breakpoint
ALTER TABLE "ai_queue" ADD CONSTRAINT "ai_queue_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_queue" ADD CONSTRAINT "ai_queue_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- AI settings hold an API key: tenant data, same row-level security as contacts.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_settings, ai_queue TO shab_app;
--> statement-breakpoint
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_settings TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Like workflow_queue: only ids and times, read across accounts by the worker,
-- so row-level security is enabled but not forced.
ALTER TABLE ai_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_queue TO shab_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
