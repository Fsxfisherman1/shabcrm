CREATE TABLE "tab_seen" (
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tab" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tab_seen_user_id_workspace_id_tab_pk" PRIMARY KEY("user_id","workspace_id","tab")
);
--> statement-breakpoint
ALTER TABLE "tab_seen" ADD CONSTRAINT "tab_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tab_seen" ADD CONSTRAINT "tab_seen_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;