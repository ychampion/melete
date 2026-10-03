CREATE TABLE "app_data_release" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"binding" text NOT NULL,
	"path" text NOT NULL,
	"source_job_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"size" integer NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_data_release_hash_shape" CHECK ("app_data_release"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version_id" text NOT NULL,
	"collection" text NOT NULL,
	"principal_id" text,
	"data" jsonb NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "app_submission_size" CHECK ("app_submission"."size" between 0 and 16384)
);
--> statement-breakpoint
ALTER TABLE "app_data_release" ADD CONSTRAINT "app_data_release_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_data_release" ADD CONSTRAINT "app_data_release_approved_by_principal_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_submission" ADD CONSTRAINT "app_submission_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_submission" ADD CONSTRAINT "app_submission_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_submission" ADD CONSTRAINT "app_submission_deleted_by_principal_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_data_release_artifact_idx" ON "app_data_release" USING btree ("app_id","binding","artifact_id");--> statement-breakpoint
CREATE INDEX "app_data_release_newest_idx" ON "app_data_release" USING btree ("app_id","binding","approved_at");--> statement-breakpoint
CREATE INDEX "app_submission_list_idx" ON "app_submission" USING btree ("app_id","collection","id");--> statement-breakpoint
CREATE INDEX "app_submission_sender_idx" ON "app_submission" USING btree ("app_id","principal_id","created_at");