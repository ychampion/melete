ALTER TABLE "question" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "source" text DEFAULT 'job' NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "space_id" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_open_memory_idx" ON "question" USING btree ("space_id","key") WHERE state = 'open' and source = 'memory';