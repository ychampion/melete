CREATE TABLE "source_cursor" (
	"connection_id" text NOT NULL,
	"stream" text NOT NULL,
	"space_id" text NOT NULL,
	"cursor" jsonb,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"interval_s" integer DEFAULT 300 NOT NULL,
	"last_ok_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"push_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_cursor_connection_id_stream_pk" PRIMARY KEY("connection_id","stream"),
	CONSTRAINT "source_cursor_stream_check" CHECK ("source_cursor"."stream" in ('mail', 'calendar')),
	CONSTRAINT "source_cursor_interval_check" CHECK ("source_cursor"."interval_s" > 0)
);
--> statement-breakpoint
CREATE TABLE "subject_state" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"type" text NOT NULL,
	"fields" jsonb NOT NULL,
	"version" text NOT NULL,
	"origin" text NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_cursor" ADD CONSTRAINT "source_cursor_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_cursor" ADD CONSTRAINT "source_cursor_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_state" ADD CONSTRAINT "subject_state_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_state" ADD CONSTRAINT "subject_state_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_cursor_due_idx" ON "source_cursor" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "source_cursor_space_idx" ON "source_cursor" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "subject_state_connection_idx" ON "subject_state" USING btree ("connection_id","type");--> statement-breakpoint
CREATE INDEX "subject_state_space_idx" ON "subject_state" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "event_connector_observation_idx" ON "event" USING btree (("payload"->>'connection_id')) WHERE "event"."job_id" is null and "event"."payload"->>'kind' = 'connector_event';