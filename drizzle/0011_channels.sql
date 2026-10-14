ALTER TYPE "public"."message_channel" ADD VALUE 'whatsapp';--> statement-breakpoint
ALTER TYPE "public"."message_channel" ADD VALUE 'imessage';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "whatsapp_number" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "imessage_number" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_whatsapp_number_unique" UNIQUE("whatsapp_number");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_imessage_number_unique" UNIQUE("imessage_number");