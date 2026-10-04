CREATE TABLE "clock" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"rule" text NOT NULL,
	"subject_key" text NOT NULL,
	"connection_id" text,
	"subject_ref" text,
	"title" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"lead_s" integer NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"anchor" jsonb,
	"check" jsonb NOT NULL,
	"person_set" boolean DEFAULT false NOT NULL,
	"job_id" text,
	"state" text DEFAULT 'armed' NOT NULL,
	"claimed_until" timestamp with time zone,
	"tries" integer DEFAULT 0 NOT NULL,
	"note" text,
	"situation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	CONSTRAINT "clock_state" CHECK ("clock"."state" in ('armed', 'checking', 'fired', 'met', 'cleared', 'missed')),
	CONSTRAINT "clock_lead" CHECK ("clock"."lead_s" >= 0)
);
--> statement-breakpoint
CREATE TABLE "situation" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"connection_id" text,
	"key" text NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"person_set" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"because" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"routed_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sightings" integer DEFAULT 1 NOT NULL,
	"deadline_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "situation_state" CHECK ("situation"."state" in ('open', 'routed', 'dismissed', 'resolved', 'expired')),
	CONSTRAINT "situation_urgency" CHECK ("situation"."urgency" in ('normal', 'soon', 'urgent')),
	CONSTRAINT "situation_urgent_is_person_set" CHECK ("situation"."urgency" <> 'urgent' or "situation"."person_set"),
	CONSTRAINT "situation_because_not_empty" CHECK (jsonb_array_length("situation"."because") > 0),
	CONSTRAINT "situation_reason_not_empty" CHECK (length("situation"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "subject_link" (
	"subject_key" text NOT NULL,
	"job_id" text NOT NULL,
	"space_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_link_subject_key_job_id_pk" PRIMARY KEY("subject_key","job_id"),
	CONSTRAINT "subject_link_role" CHECK ("subject_link"."role" in ('deadline', 'watch', 'handling'))
);
--> statement-breakpoint
ALTER TABLE "push_intent" ADD COLUMN "urgency" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_intent" ADD COLUMN "person_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_intent" ADD COLUMN "situation_id" text;--> statement-breakpoint
ALTER TABLE "clock" ADD CONSTRAINT "clock_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock" ADD CONSTRAINT "clock_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock" ADD CONSTRAINT "clock_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock" ADD CONSTRAINT "clock_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation" ADD CONSTRAINT "situation_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation" ADD CONSTRAINT "situation_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "situation" ADD CONSTRAINT "situation_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_link" ADD CONSTRAINT "subject_link_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_link" ADD CONSTRAINT "subject_link_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clock_live_idx" ON "clock" USING btree ("rule","subject_key") WHERE "clock"."state" in ('armed', 'checking');--> statement-breakpoint
CREATE INDEX "clock_due_idx" ON "clock" USING btree ("fire_at") WHERE "clock"."state" in ('armed', 'checking');--> statement-breakpoint
CREATE INDEX "clock_space_idx" ON "clock" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "clock_subject_idx" ON "clock" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "clock_connection_idx" ON "clock" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "situation_live_key_idx" ON "situation" USING btree ("key") WHERE "situation"."state" in ('open', 'routed');--> statement-breakpoint
CREATE INDEX "situation_principal_idx" ON "situation" USING btree ("principal_id","state","created_at");--> statement-breakpoint
CREATE INDEX "situation_space_idx" ON "situation" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "situation_subject_idx" ON "situation" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "situation_connection_idx" ON "situation" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "subject_link_job_idx" ON "subject_link" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "subject_link_space_idx" ON "subject_link" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "push_intent_situation_idx" ON "push_intent" USING btree ("situation_id") WHERE "push_intent"."situation_id" is not null;--> statement-breakpoint
ALTER TABLE "push_intent" ADD CONSTRAINT "push_intent_urgency" CHECK ("push_intent"."urgency" in ('normal', 'soon', 'urgent'));