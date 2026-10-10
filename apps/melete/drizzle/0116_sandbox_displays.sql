CREATE TABLE "sandbox_display" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"adapter" text NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"display" integer NOT NULL,
	"owner_job_id" text NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "sandbox_display_number_check" CHECK ("sandbox_display"."display" >= 0 and "sandbox_display"."display" < 64)
);
--> statement-breakpoint
ALTER TABLE "sandbox_display" ADD CONSTRAINT "sandbox_display_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_display" ADD CONSTRAINT "sandbox_display_owner_job_id_job_id_fk" FOREIGN KEY ("owner_job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_display" ADD CONSTRAINT "sandbox_display_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_display" ADD CONSTRAINT "sandbox_display_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_display_number_idx" ON "sandbox_display" USING btree ("provider_sandbox_id","display") WHERE "sandbox_display"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_display_owner_idx" ON "sandbox_display" USING btree ("provider_sandbox_id","owner_job_id") WHERE "sandbox_display"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "sandbox_display_attempt_idx" ON "sandbox_display" USING btree ("attempt_id") WHERE "sandbox_display"."ended_at" is null;