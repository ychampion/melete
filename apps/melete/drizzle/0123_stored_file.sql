CREATE TABLE "stored_file" (
	"space_id" text NOT NULL,
	"place" text NOT NULL,
	"job_id" text,
	"principal_id" text,
	"bytes" bigint NOT NULL,
	"trash_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_file_space_id_place_pk" PRIMARY KEY("space_id","place"),
	CONSTRAINT "stored_file_bytes" CHECK ("stored_file"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stored_file_principal_idx" ON "stored_file" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "stored_file_job_idx" ON "stored_file" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "attachment_principal_idx" ON "attachment" USING btree ("principal_id");