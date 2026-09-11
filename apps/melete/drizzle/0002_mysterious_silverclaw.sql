CREATE TABLE "memory_dense_entries" (
	"space_id" text NOT NULL,
	"generation" integer NOT NULL,
	"claim_id" text NOT NULL,
	"revision" integer NOT NULL,
	"model" text NOT NULL,
	"version" text NOT NULL,
	"dimensions" integer NOT NULL,
	"recipe" text NOT NULL,
	"vector" jsonb NOT NULL,
	CONSTRAINT "memory_dense_entries_space_id_generation_claim_id_revision_pk" PRIMARY KEY("space_id","generation","claim_id","revision")
);
--> statement-breakpoint
ALTER TABLE "memory_dense_entries" ADD CONSTRAINT "memory_dense_entries_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;