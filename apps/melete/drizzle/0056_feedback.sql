CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"principal_id" text,
	"message" text NOT NULL,
	"route" text,
	"app_version" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" in ('open', 'fixing', 'fixed', 'wontfix'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_installation_id_owner_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_installation_created_idx" ON "feedback" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_principal_created_idx" ON "feedback" USING btree ("principal_id","created_at");