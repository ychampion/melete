CREATE TABLE "memory_capture" (
	"event_seq" bigint PRIMARY KEY NOT NULL,
	"job_id" text,
	"space_id" text,
	"outcome" text NOT NULL,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"space_id" text NOT NULL,
	"work_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"settlement" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"capture" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_settings" ADD CONSTRAINT "memory_settings_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_capture_source" ON "memory_capture" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "memory_model_calls_owner" ON "memory_model_calls" USING btree ("owner_id","created_at");--> statement-breakpoint
-- Automatic memory reads chat from here on. Earlier messages were never offered
-- to it, so the watermark keeps them out.
INSERT INTO "memory_capture" ("event_seq", "outcome") SELECT coalesce(max("seq"), 0), 'watermark' FROM "event";
