CREATE TABLE "artifact_publication" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"action_id" text NOT NULL,
	"destination" text NOT NULL,
	"external_ref" text,
	"content_hash" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_validation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"class" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"advisory" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "source_job_id" text;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "area" text DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "kind" text DEFAULT 'binary' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "expectation" jsonb;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_publication" ADD CONSTRAINT "artifact_publication_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_validation" ADD CONSTRAINT "artifact_validation_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_publication_artifact_idx" ON "artifact_publication" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_publication_action_idx" ON "artifact_publication" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "artifact_validation_artifact_idx" ON "artifact_validation" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_validation_name_idx" ON "artifact_validation" USING btree ("artifact_id","name");--> statement-breakpoint
CREATE INDEX "artifact_job_path_idx" ON "artifact" USING btree ("job_id","area","path","created_at");