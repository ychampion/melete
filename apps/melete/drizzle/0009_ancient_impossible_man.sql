CREATE TABLE "memory_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"domain_key" text NOT NULL,
	"audience" text NOT NULL,
	"head_revision" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"job_revision" integer NOT NULL,
	"policy_generation" integer NOT NULL,
	"data_revision" integer NOT NULL,
	"access_generation" integer NOT NULL,
	"audience" jsonb NOT NULL,
	"purpose" text NOT NULL,
	"items" jsonb NOT NULL,
	"recipe" text NOT NULL,
	"token_budget" jsonb NOT NULL,
	"recall_status" text NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_contexts_attempt_id_unique" UNIQUE("attempt_id")
);
--> statement-breakpoint
CREATE TABLE "memory_derivations" (
	"space_id" text NOT NULL,
	"input_kind" text NOT NULL,
	"input_id" text NOT NULL,
	"input_version" text NOT NULL,
	"output_kind" text NOT NULL,
	"output_id" text NOT NULL,
	"output_version" text NOT NULL,
	CONSTRAINT "memory_derivations_space_id_input_kind_input_id_input_version_output_kind_output_id_output_version_pk" PRIMARY KEY("space_id","input_kind","input_id","input_version","output_kind","output_id","output_version")
);
--> statement-breakpoint
CREATE TABLE "memory_index_entries" (
	"space_id" text NOT NULL,
	"generation" integer NOT NULL,
	"claim_id" text NOT NULL,
	"revision" integer NOT NULL,
	"tokens" "tsvector" NOT NULL,
	CONSTRAINT "memory_index_entries_space_id_generation_claim_id_revision_pk" PRIMARY KEY("space_id","generation","claim_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_invalidations" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"type" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text,
	"claim_ids" jsonb NOT NULL,
	"data_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_index_manifest" (
	"space_id" text PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"coverage_revision" integer DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'lexical' NOT NULL,
	"recipe" text DEFAULT 'simple-lexical-v1' NOT NULL,
	"embedding" jsonb
);
--> statement-breakpoint
CREATE TABLE "memory_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_prepared" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"content" text,
	"data_revision" integer NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_profile" (
	"space_id" text PRIMARY KEY NOT NULL,
	"data_revision" integer NOT NULL,
	"items" jsonb NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"work_id" text NOT NULL,
	"fence" integer NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_references" (
	"claim_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_id" text NOT NULL,
	"source_version" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	CONSTRAINT "memory_references_claim_id_revision_source_id_start_end_pk" PRIMARY KEY("claim_id","revision","source_id","start","end"),
	CONSTRAINT "memory_span" CHECK ("memory_references"."start" >= 0 and "memory_references"."end" > "memory_references"."start")
);
--> statement-breakpoint
CREATE TABLE "memory_revision_content" (
	"claim_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "memory_revision_content_claim_id_revision_pk" PRIMARY KEY("claim_id","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"claim_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"factual_status" text NOT NULL,
	"status" text NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"data_revision" integer NOT NULL,
	CONSTRAINT "memory_revisions_claim_id_revision_pk" PRIMARY KEY("claim_id","revision"),
	CONSTRAINT "memory_valid_window" CHECK ("memory_revisions"."valid_until" is null or "memory_revisions"."valid_until" >= "memory_revisions"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "memory_source_content" (
	"source_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"publisher" text NOT NULL,
	"stream" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_version" text NOT NULL,
	"stream_sequence" integer NOT NULL,
	"source_type" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audience" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"eligibility_generation" integer NOT NULL,
	"content_length" integer NOT NULL,
	CONSTRAINT "memory_source_state" CHECK ("memory_sources"."state" in ('active','suppressed','deleted','revoked'))
);
--> statement-breakpoint
CREATE TABLE "memory_spaces" (
	"space_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"policy_generation" integer DEFAULT 1 NOT NULL,
	"data_revision" integer DEFAULT 0 NOT NULL,
	"access_generation" integer DEFAULT 1 NOT NULL,
	"eligibility_generation" integer DEFAULT 1 NOT NULL,
	"restore_ready" boolean DEFAULT false NOT NULL,
	"require_review" boolean DEFAULT false NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_streams" (
	"space_id" text NOT NULL,
	"publisher" text NOT NULL,
	"stream" text NOT NULL,
	"committed_sequence" integer DEFAULT 0 NOT NULL,
	"consumed_sequence" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "memory_streams_space_id_publisher_stream_pk" PRIMARY KEY("space_id","publisher","stream")
);
--> statement-breakpoint
CREATE TABLE "memory_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"source_id" text,
	"publisher" text,
	"stream" text,
	"source_identity" text,
	"start" integer,
	"end" integer,
	"eligibility_cutoff" integer NOT NULL,
	"operation" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_work" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"source_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"segment_start" integer NOT NULL,
	"segment_end" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"continuation" integer,
	"calls" integer DEFAULT 0 NOT NULL,
	"reserved_usd" text DEFAULT '0' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_claims" ADD CONSTRAINT "memory_claims_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_contexts" ADD CONSTRAINT "memory_contexts_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_index_entries" ADD CONSTRAINT "memory_index_entries_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_invalidations" ADD CONSTRAINT "memory_invalidations_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_index_manifest" ADD CONSTRAINT "memory_index_manifest_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_outbox" ADD CONSTRAINT "memory_outbox_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_prepared" ADD CONSTRAINT "memory_prepared_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_profile" ADD CONSTRAINT "memory_profile_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_references" ADD CONSTRAINT "memory_references_claim_id_memory_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."memory_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_references" ADD CONSTRAINT "memory_references_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revision_content" ADD CONSTRAINT "memory_revision_content_claim_id_memory_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."memory_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_claim_id_memory_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."memory_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_content" ADD CONSTRAINT "memory_source_content_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_spaces" ADD CONSTRAINT "memory_spaces_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_spaces" ADD CONSTRAINT "memory_spaces_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_streams" ADD CONSTRAINT "memory_streams_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suppressions" ADD CONSTRAINT "memory_suppressions_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_work" ADD CONSTRAINT "memory_work_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_work" ADD CONSTRAINT "memory_work_source_id_memory_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_claim_domain_head" ON "memory_claims" USING btree ("space_id","audience","domain_key") WHERE not "memory_claims"."hidden";--> statement-breakpoint
CREATE INDEX "memory_lexical_tokens" ON "memory_index_entries" USING gin ("tokens");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_one_active_revision" ON "memory_revisions" USING btree ("claim_id") WHERE "memory_revisions"."status" in ('active','disputed');--> statement-breakpoint
CREATE UNIQUE INDEX "memory_source_identity" ON "memory_sources" USING btree ("space_id","publisher","stream","source_identity","source_version");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_source_sequence" ON "memory_sources" USING btree ("space_id","publisher","stream","stream_sequence");--> statement-breakpoint
CREATE INDEX "memory_work_pending" ON "memory_work" USING btree ("space_id","status","lease_until");