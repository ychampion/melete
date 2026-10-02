CREATE TABLE "activity_record" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text,
	"action_id" text NOT NULL,
	"kind" text NOT NULL,
	"effect_class" text NOT NULL,
	"connection_id" text,
	"connection_label" text NOT NULL,
	"provider" text NOT NULL,
	"destination" text,
	"external_ref" text,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_record_action_idx" ON "activity_record" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "activity_record_space_idx" ON "activity_record" USING btree ("space_id","happened_at");