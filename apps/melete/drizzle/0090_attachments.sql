CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text,
	"job_id" text,
	"turn_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"kind" text NOT NULL,
	"size" integer NOT NULL,
	"blob_key" text NOT NULL,
	"preview_key" text,
	"text" text,
	"pages" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "attachment_kind" CHECK ("attachment"."kind" in ('image', 'pdf', 'docx', 'xlsx', 'csv', 'text'))
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_job_idx" ON "attachment" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "attachment_space_idx" ON "attachment" USING btree ("space_id");