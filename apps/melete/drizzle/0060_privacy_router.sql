CREATE TABLE "privacy_conversation" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"sensitive" text,
	"consent" text,
	"consent_turn_id" text,
	"asked_attempt_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_request" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" text,
	"conversation_id" text,
	"job_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"turn_id" text,
	"route" text NOT NULL,
	"protected" integer DEFAULT 0 NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placeholders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"local_detection" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_settings" (
	"space_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sealed" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_vault" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"sealed" text NOT NULL,
	"entries" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "private_origin" text;--> statement-breakpoint
ALTER TABLE "privacy_conversation" ADD CONSTRAINT "privacy_conversation_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request" ADD CONSTRAINT "privacy_request_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_vault" ADD CONSTRAINT "privacy_vault_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_request_conversation_idx" ON "privacy_request" USING btree ("conversation_id","turn_id");--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_private_origin" CHECK ("memory_sources"."private_origin" is null or "memory_sources"."private_origin" in ('space','agent','health','therapy','finance'));