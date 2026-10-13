CREATE TABLE "saved_sign_in" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"origin" text NOT NULL,
	"label" text NOT NULL,
	"username" text NOT NULL,
	"secret_ref" text NOT NULL,
	"key_id" text NOT NULL,
	"has_code" boolean DEFAULT false NOT NULL,
	"policy" text DEFAULT 'whenever_needed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_outcome" text,
	CONSTRAINT "saved_sign_in_policy" CHECK ("saved_sign_in"."policy" in ('whenever_needed', 'ask_first')),
	CONSTRAINT "saved_sign_in_origin_lower" CHECK ("saved_sign_in"."origin" = lower("saved_sign_in"."origin"))
);
--> statement-breakpoint
CREATE TABLE "saved_sign_in_use" (
	"id" text PRIMARY KEY NOT NULL,
	"sign_in_id" text NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"job_id" text,
	"action_id" text,
	"origin" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_sign_in" ADD CONSTRAINT "saved_sign_in_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sign_in" ADD CONSTRAINT "saved_sign_in_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sign_in_use" ADD CONSTRAINT "saved_sign_in_use_sign_in_id_saved_sign_in_id_fk" FOREIGN KEY ("sign_in_id") REFERENCES "public"."saved_sign_in"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_sign_in_use" ADD CONSTRAINT "saved_sign_in_use_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_sign_in_person_site_idx" ON "saved_sign_in" USING btree ("space_id","principal_id","origin","username");--> statement-breakpoint
CREATE INDEX "saved_sign_in_use_sign_in_idx" ON "saved_sign_in_use" USING btree ("sign_in_id","created_at");--> statement-breakpoint
UPDATE "connection" SET "scopes" = "scopes" || '["browser.sign_in"]'::jsonb WHERE "provider" = 'web' AND "scopes" ? 'browser.observe' AND NOT ("scopes" ? 'browser.sign_in');