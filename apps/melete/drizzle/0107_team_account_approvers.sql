ALTER TABLE "room_policy" ADD COLUMN "team_account_approvers" text DEFAULT 'any_member' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_policy" ADD CONSTRAINT "room_policy_team_account_approvers" CHECK ("room_policy"."team_account_approvers" in ('any_member', 'owners'));--> statement-breakpoint
-- A room whose owners already chose to answer everything themselves keeps that for its own accounts too.
UPDATE "room_policy" SET "team_account_approvers" = 'owners' WHERE "approvers" = 'owners';