ALTER TABLE "company_message" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_scan" ADD COLUMN "model_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "company_scan_principal_started_idx" ON "company_scan" USING btree ("principal_id","started_at");