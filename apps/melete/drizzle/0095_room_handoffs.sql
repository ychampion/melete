CREATE TABLE "room_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"room_job_id" text,
	"room_turn_id" text,
	"thread_id" text NOT NULL,
	"action_id" text NOT NULL,
	"connection_id" text,
	"trigger_id" text,
	"target_principal_id" text NOT NULL,
	"task_text" text NOT NULL,
	"task_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"personal_job_id" text,
	"result_text" text,
	"result_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_handoff_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "room_handoff_state" CHECK ("room_handoff"."state" in ('pending', 'accepted', 'declined', 'running', 'settled', 'shared', 'kept', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_room_job_id_job_id_fk" FOREIGN KEY ("room_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_thread_id_room_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."room_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_trigger_id_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_target_principal_id_principal_id_fk" FOREIGN KEY ("target_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_handoff" ADD CONSTRAINT "room_handoff_personal_job_id_job_id_fk" FOREIGN KEY ("personal_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_handoff_target_idx" ON "room_handoff" USING btree ("target_principal_id","created_at");--> statement-breakpoint
CREATE INDEX "room_handoff_personal_job_idx" ON "room_handoff" USING btree ("personal_job_id");--> statement-breakpoint
CREATE INDEX "room_handoff_room_idx" ON "room_handoff" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "room_handoff_due_idx" ON "room_handoff" USING btree ("state","expires_at");