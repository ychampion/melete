CREATE TABLE "egress_record" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"action_id" text,
	"token_kind" text,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"count" integer DEFAULT 1 NOT NULL,
	"connection_id" text,
	"reads" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"bytes_up" bigint DEFAULT 0 NOT NULL,
	"bytes_down" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "egress_record_verdict_check" CHECK ("egress_record"."verdict" in ('tunnel', 'refused', 'credentialed', 'unattributed', 'suppressed')),
	CONSTRAINT "egress_record_token_kind_check" CHECK ("egress_record"."token_kind" is null or "egress_record"."token_kind" in ('command', 'process'))
);
--> statement-breakpoint
ALTER TABLE "egress_record" ADD CONSTRAINT "egress_record_session_id_sandbox_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sandbox_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_record" ADD CONSTRAINT "egress_record_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "egress_record_job_idx" ON "egress_record" USING btree ("job_id","opened_at");--> statement-breakpoint
CREATE INDEX "egress_record_space_idx" ON "egress_record" USING btree ("space_id","opened_at");--> statement-breakpoint
CREATE INDEX "egress_record_session_idx" ON "egress_record" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "egress_record_opened_idx" ON "egress_record" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "egress_record_action_idx" ON "egress_record" USING btree ("action_id") WHERE "egress_record"."action_id" is not null;