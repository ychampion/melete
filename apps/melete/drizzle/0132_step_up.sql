CREATE TABLE "step_up" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"principal_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"action_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "step_up_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "step_up_method" CHECK ("step_up"."method" in ('password', 'passkey', 'oidc'))
);
--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "step_up_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "step_up_id" text;--> statement-breakpoint
ALTER TABLE "step_up" ADD CONSTRAINT "step_up_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up" ADD CONSTRAINT "step_up_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up" ADD CONSTRAINT "step_up_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_up_approval_idx" ON "step_up" USING btree ("approval_id");