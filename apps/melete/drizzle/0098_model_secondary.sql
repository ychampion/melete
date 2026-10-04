CREATE TABLE "model_secondary" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"provider" text,
	"model" text,
	"side_tasks" text DEFAULT 'secondary' NOT NULL,
	"scheduled" text DEFAULT 'primary' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_secondary_pair" CHECK (("model_secondary"."provider" is null) = ("model_secondary"."model" is null)),
	CONSTRAINT "model_secondary_side_tasks" CHECK ("model_secondary"."side_tasks" in ('primary', 'secondary')),
	CONSTRAINT "model_secondary_scheduled" CHECK ("model_secondary"."scheduled" in ('primary', 'secondary'))
);
--> statement-breakpoint
ALTER TABLE "model_secondary" ADD CONSTRAINT "model_secondary_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;