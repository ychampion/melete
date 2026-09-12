CREATE TABLE "principal" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"passkey" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "space_membership" (
	"principal_id" text NOT NULL,
	"space_id" text NOT NULL,
	"role" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_membership_principal_id_space_id_pk" PRIMARY KEY("principal_id","space_id"),
	CONSTRAINT "membership_role" CHECK ("space_membership"."role" in ('owner', 'member')),
	CONSTRAINT "membership_generation" CHECK ("space_membership"."generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "acceptance_journal" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "membership_generation" integer;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "space" ADD COLUMN "owner_principal_id" text;--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "space_membership" ADD CONSTRAINT "space_membership_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_membership" ADD CONSTRAINT "space_membership_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_journal" ADD CONSTRAINT "acceptance_journal_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_owner_principal_id_principal_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Preserve existing identities, sessions, jobs and private ownership on upgrade.
INSERT INTO principal (id, email, password_hash, passkey, created_at)
  SELECT id, email, password_hash, passkey, created_at FROM owner ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE space SET owner_principal_id = (SELECT id FROM owner LIMIT 1);
--> statement-breakpoint
UPDATE job SET principal_id = (SELECT id FROM owner LIMIT 1);
--> statement-breakpoint
UPDATE session SET principal_id = owner_id;
--> statement-breakpoint
UPDATE submission SET principal_id = (SELECT id FROM owner LIMIT 1);
--> statement-breakpoint
UPDATE acceptance_journal SET principal_id = (SELECT id FROM owner LIMIT 1);
