CREATE TABLE "triage_item" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"connection_id" text,
	"event_seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"fields" jsonb NOT NULL,
	"verdict" text,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"sentence" text,
	"reason" text,
	"decided_by" text,
	"model" text,
	"unsorted" text,
	"tries" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"acked_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"triaged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_item_verdict_check" CHECK ("triage_item"."verdict" is null or "triage_item"."verdict" in ('needs_you', 'fyi', 'ignore')),
	CONSTRAINT "triage_item_urgency_check" CHECK ("triage_item"."urgency" in ('normal', 'soon')),
	CONSTRAINT "triage_item_state_check" CHECK ("triage_item"."state" in ('open', 'acked', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "triage_verdict" (
	"principal_id" text NOT NULL,
	"space_id" text NOT NULL,
	"event_seq" bigint NOT NULL,
	"connection_id" text,
	"subject_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"urgency" text NOT NULL,
	"sentence" text NOT NULL,
	"reason" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "triage_verdict_principal_id_space_id_subject_key_content_hash_pk" PRIMARY KEY("principal_id","space_id","subject_key","content_hash"),
	CONSTRAINT "triage_verdict_verdict_check" CHECK ("triage_verdict"."verdict" in ('needs_you', 'fyi', 'ignore')),
	CONSTRAINT "triage_verdict_urgency_check" CHECK ("triage_verdict"."urgency" in ('normal', 'soon'))
);
--> statement-breakpoint
ALTER TABLE "triage_item" ADD CONSTRAINT "triage_item_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_item" ADD CONSTRAINT "triage_item_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_item" ADD CONSTRAINT "triage_item_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_item" ADD CONSTRAINT "triage_item_event_seq_event_seq_fk" FOREIGN KEY ("event_seq") REFERENCES "public"."event"("seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_verdict" ADD CONSTRAINT "triage_verdict_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_verdict" ADD CONSTRAINT "triage_verdict_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_verdict" ADD CONSTRAINT "triage_verdict_event_seq_event_seq_fk" FOREIGN KEY ("event_seq") REFERENCES "public"."event"("seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_verdict" ADD CONSTRAINT "triage_verdict_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "triage_item_event_idx" ON "triage_item" USING btree ("principal_id","event_seq");--> statement-breakpoint
CREATE INDEX "triage_item_principal_idx" ON "triage_item" USING btree ("principal_id","state","created_at");--> statement-breakpoint
CREATE INDEX "triage_item_pending_idx" ON "triage_item" USING btree ("principal_id","space_id") WHERE "triage_item"."verdict" is null;--> statement-breakpoint
CREATE INDEX "triage_item_space_idx" ON "triage_item" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "triage_item_seq_idx" ON "triage_item" USING btree ("event_seq");--> statement-breakpoint
CREATE INDEX "triage_verdict_expires_idx" ON "triage_verdict" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "triage_verdict_space_idx" ON "triage_verdict" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "triage_verdict_connection_idx" ON "triage_verdict" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "triage_verdict_seq_idx" ON "triage_verdict" USING btree ("event_seq");