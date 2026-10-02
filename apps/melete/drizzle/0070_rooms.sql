CREATE TABLE "room_message" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"author_principal_id" text NOT NULL,
	"kind" text DEFAULT 'person' NOT NULL,
	"via_agent" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_state" text DEFAULT 'none' NOT NULL,
	"request_job_id" text,
	"submission_id" text NOT NULL,
	"stream_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "room_message_submission_id_unique" UNIQUE("submission_id"),
	CONSTRAINT "room_message_kind" CHECK ("room_message"."kind" in ('person', 'handoff_result', 'system')),
	CONSTRAINT "room_message_request_state" CHECK ("room_message"."request_state" in ('none', 'pending', 'started'))
);
--> statement-breakpoint
CREATE TABLE "room_presence" (
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_presence_space_id_principal_id_pk" PRIMARY KEY("space_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "room_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "space_membership" DROP CONSTRAINT "membership_role";--> statement-breakpoint
ALTER TABLE "experience_turn" ADD COLUMN "author_principal_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "audience" text DEFAULT 'principal' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "requested_by_principal_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "room_thread_id" text;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "space" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_thread_id_room_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."room_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_author_principal_id_principal_id_fk" FOREIGN KEY ("author_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_request_job_id_job_id_fk" FOREIGN KEY ("request_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_presence" ADD CONSTRAINT "room_presence_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_presence" ADD CONSTRAINT "room_presence_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_thread" ADD CONSTRAINT "room_thread_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_thread" ADD CONSTRAINT "room_thread_created_by_principal_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_message_thread_idx" ON "room_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "room_message_stream_idx" ON "room_message" USING btree ("thread_id","stream_seq");--> statement-breakpoint
CREATE INDEX "room_message_pending_idx" ON "room_message" USING btree ("space_id","request_state") WHERE "room_message"."request_state" = 'pending';--> statement-breakpoint
CREATE INDEX "room_thread_space_idx" ON "room_thread" USING btree ("space_id","last_activity_at");--> statement-breakpoint
ALTER TABLE "experience_turn" ADD CONSTRAINT "experience_turn_author_principal_id_principal_id_fk" FOREIGN KEY ("author_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_requested_by_principal_id_principal_id_fk" FOREIGN KEY ("requested_by_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_room_thread_idx" ON "job" USING btree ("room_thread_id");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_audience" CHECK ("job"."audience" in ('principal', 'room'));--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_kind" CHECK ("principal"."kind" in ('person', 'guest', 'room'));--> statement-breakpoint
ALTER TABLE "space_membership" ADD CONSTRAINT "membership_role" CHECK ("space_membership"."role" in ('owner', 'member', 'guest', 'agent'));--> statement-breakpoint
-- Every shared space becomes a room: one room principal, which never signs in,
-- and its agent membership, whose generation is the room's roster generation.
INSERT INTO "principal" ("id", "email", "kind")
SELECT 'own_0' || upper(substr(md5('room:' || s."id"), 1, 25)), lower(s."id") || '@room.invalid', 'room'
FROM "space" s
WHERE s."kind" = 'shared'
  AND NOT EXISTS (SELECT 1 FROM "space_membership" m WHERE m."space_id" = s."id" AND m."role" = 'agent');--> statement-breakpoint
INSERT INTO "space_membership" ("principal_id", "space_id", "role")
SELECT p."id", s."id", 'agent'
FROM "space" s JOIN "principal" p ON p."email" = lower(s."id") || '@room.invalid' AND p."kind" = 'room'
WHERE s."kind" = 'shared'
  AND NOT EXISTS (SELECT 1 FROM "space_membership" m WHERE m."space_id" = s."id" AND m."role" = 'agent');
