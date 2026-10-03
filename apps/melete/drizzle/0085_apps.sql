CREATE TABLE "app" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"publisher_principal_id" text NOT NULL,
	"current_version_id" text,
	"grant_generation" integer DEFAULT 0 NOT NULL,
	"last_action_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_status" CHECK ("app"."status" in ('active', 'unpublished')),
	CONSTRAINT "app_grant_generation" CHECK ("app"."grant_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"grantee_kind" text NOT NULL,
	"grantee_id" text NOT NULL,
	"role" text DEFAULT 'view' NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_grant_kind" CHECK ("app_grant"."grantee_kind" in ('principal', 'room', 'installation')),
	CONSTRAINT "app_grant_role" CHECK ("app_grant"."role" in ('view', 'manage'))
);
--> statement-breakpoint
CREATE TABLE "app_version" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"job_id" text,
	"action_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_version_id_shape" CHECK ("app_version"."id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "app_version_manifest_hash_shape" CHECK ("app_version"."manifest_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_publisher_principal_id_principal_id_fk" FOREIGN KEY ("publisher_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grant" ADD CONSTRAINT "app_grant_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grant" ADD CONSTRAINT "app_grant_granted_by_principal_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_version" ADD CONSTRAINT "app_version_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_version" ADD CONSTRAINT "app_version_created_by_principal_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_space_slug_idx" ON "app" USING btree ("space_id","slug");--> statement-breakpoint
CREATE INDEX "app_publisher_idx" ON "app" USING btree ("publisher_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_grant_live_idx" ON "app_grant" USING btree ("app_id","grantee_kind","grantee_id") WHERE "app_grant"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "app_grant_grantee_idx" ON "app_grant" USING btree ("grantee_kind","grantee_id");--> statement-breakpoint
CREATE INDEX "app_version_app_idx" ON "app_version" USING btree ("app_id","created_at");