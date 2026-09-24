CREATE TABLE "engine_skill_prohibition" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text,
	"principal_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"body_sha256" text,
	"reason" text NOT NULL,
	"source_candidate_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "procedure_candidate" ALTER COLUMN "episode_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "origin" text DEFAULT 'owner_correction' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "source_job_id" text;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "source_attempt_id" text;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "ordinal" integer;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "skill_name" text;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "engine_skill_prohibition" ADD CONSTRAINT "engine_skill_prohibition_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_skill_prohibition" ADD CONSTRAINT "engine_skill_prohibition_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_skill_prohibition" ADD CONSTRAINT "engine_skill_prohibition_source_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engine_skill_prohibition_principal_idx" ON "engine_skill_prohibition" USING btree ("principal_id");--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_candidate_source_job_id_job_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_candidate_source_attempt_id_attempt_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_engine_name_idx" ON "procedure_candidate" USING btree ("source_attempt_id","skill_name");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_engine_ordinal_idx" ON "procedure_candidate" USING btree ("source_attempt_id","ordinal");--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_origin_check" CHECK ("procedure_candidate"."origin" in ('owner_correction','engine_staged'));--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_engine_shape_check" CHECK (case when "procedure_candidate"."origin" = 'engine_staged' then "procedure_candidate"."episode_id" is null
        and "procedure_candidate"."source_job_id" is not null and "procedure_candidate"."source_attempt_id" is not null
        and "procedure_candidate"."skill_name" is not null and "procedure_candidate"."ordinal" between 1 and 5
        else "procedure_candidate"."episode_id" is not null and "procedure_candidate"."source_attempt_id" is null and "procedure_candidate"."ordinal" is null end);