CREATE TABLE "setup_code" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_link" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_link" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "magic_link" ALTER COLUMN "connection_generation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_link" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;