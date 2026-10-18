CREATE TABLE "connection_page" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"action_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text,
	"trigger_id" text,
	"resource_uri" text NOT NULL,
	"html" text NOT NULL,
	"domains" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"open_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_origin" text NOT NULL,
	"tool_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"report_data" jsonb,
	"report_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "connection_page_state_check" CHECK ("connection_page"."state" in ('open', 'completed', 'failed', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "person_entitlement" (
	"principal_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "person_entitlement_principal_id_key_pk" PRIMARY KEY("principal_id","key")
);
--> statement-breakpoint
ALTER TABLE "connection_page" ADD CONSTRAINT "connection_page_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_page" ADD CONSTRAINT "connection_page_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_page" ADD CONSTRAINT "connection_page_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_page" ADD CONSTRAINT "connection_page_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_entitlement" ADD CONSTRAINT "person_entitlement_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_page_job_idx" ON "connection_page" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_page_action_idx" ON "connection_page" USING btree ("action_id");