ALTER TABLE "space_removal" DROP CONSTRAINT "space_removal_state";--> statement-breakpoint
DROP INDEX "space_removal_live_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "space_removal_live_idx" ON "space_removal" USING btree ("space_id") WHERE "space_removal"."state" not in ('complete','cleaning');--> statement-breakpoint
ALTER TABLE "space_removal" ADD CONSTRAINT "space_removal_state" CHECK ("space_removal"."state" in ('pending','running','blocked','cleaning','complete'));