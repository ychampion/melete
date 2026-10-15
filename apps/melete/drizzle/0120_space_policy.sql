CREATE TABLE "space_policy" (
	"space_id" text PRIMARY KEY NOT NULL,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_connector_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"denied_tool_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_policy" ADD CONSTRAINT "space_policy_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_policy" ADD CONSTRAINT "space_policy_updated_by_principal_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;