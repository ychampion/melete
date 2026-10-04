CREATE TABLE "memory_agent_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"job_id" text,
	"content" text NOT NULL,
	"private_origin" text,
	"embedding_model" text,
	"embedding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_agent_notes_content" CHECK (char_length("memory_agent_notes"."content") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "memory_agent_notes" ADD CONSTRAINT "memory_agent_notes_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_agent_notes_owner" ON "memory_agent_notes" USING btree ("space_id","principal_id","created_at");