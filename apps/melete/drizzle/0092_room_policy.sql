CREATE TABLE "room_policy" (
	"space_id" text PRIMARY KEY NOT NULL,
	"approvers" text DEFAULT 'requester' NOT NULL,
	"agent_turns" text DEFAULT 'asked' NOT NULL,
	"guests_may_ask" boolean DEFAULT true NOT NULL,
	"requests_per_hour" integer DEFAULT 30 NOT NULL,
	"requests_per_person_hour" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "room_policy_approvers" CHECK ("room_policy"."approvers" in ('requester', 'any_member', 'owners')),
	CONSTRAINT "room_policy_agent_turns" CHECK ("room_policy"."agent_turns" in ('asked', 'every_message')),
	CONSTRAINT "room_policy_limits" CHECK ("room_policy"."requests_per_hour" between 1 and 1000 and "room_policy"."requests_per_person_hour" between 1 and "room_policy"."requests_per_hour")
);
--> statement-breakpoint
ALTER TABLE "room_policy" ADD CONSTRAINT "room_policy_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_policy" ADD CONSTRAINT "room_policy_updated_by_principal_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;