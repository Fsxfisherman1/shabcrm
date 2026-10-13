ALTER TABLE "forms" ADD COLUMN "source" text DEFAULT 'shabcrm' NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "capture_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "forms_external_key_idx" ON "forms" USING btree ("workspace_id","external_key");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_capture_key_unique" UNIQUE("capture_key");