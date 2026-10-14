CREATE TABLE "item_seen" (
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_seen_user_id_kind_item_id_pk" PRIMARY KEY("user_id","kind","item_id")
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"clear_per_item" boolean DEFAULT true NOT NULL,
	"per_item_since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "item_seen" ADD CONSTRAINT "item_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_seen" ADD CONSTRAINT "item_seen_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Counts are read inside withWorkspace(), as shab_app, and check this table.
GRANT SELECT ON item_seen TO shab_app;
