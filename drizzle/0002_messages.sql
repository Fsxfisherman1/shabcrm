CREATE TYPE "public"."message_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'received');--> statement-breakpoint
ALTER TYPE "public"."activity_kind" ADD VALUE 'missed_call';--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"provider_id" text,
	"error" text,
	"created_by" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "sms_number" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "forward_calls_to" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "missed_call_text_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "missed_call_text" text DEFAULT 'Sorry we missed your call! How can we help? You can reply right here by text.' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "email_from_name" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "email_from_address" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_contact_idx" ON "messages" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_workspace_idx" ON "messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages" USING btree ("provider_id") WHERE "messages"."provider_id" is not null;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_sms_number_unique" UNIQUE("sms_number");