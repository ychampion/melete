CREATE TABLE "room_board_item" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"assignee_principal_id" text,
	"visibility" text DEFAULT 'everyone' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"claimed_by" text,
	"choices" jsonb,
	"answer" text,
	"answered_at" timestamp with time zone,
	"source_thread_id" text,
	"answer_message_id" text,
	"action_id" text,
	"created_by" text NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_board_item_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "room_board_item_kind" CHECK ("room_board_item"."kind" in ('event', 'task', 'question', 'note')),
	CONSTRAINT "room_board_item_visibility" CHECK ("room_board_item"."visibility" in ('everyone', 'owners', 'assignee')),
	CONSTRAINT "room_board_item_state" CHECK ("room_board_item"."state" in ('open', 'claimed', 'done', 'answered')),
	CONSTRAINT "room_board_item_title" CHECK (length("room_board_item"."title") between 1 and 120),
	CONSTRAINT "room_board_item_detail" CHECK ("room_board_item"."detail" is null or length("room_board_item"."detail") <= 2000),
	CONSTRAINT "room_board_item_answer" CHECK ("room_board_item"."answer" is null or length("room_board_item"."answer") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "room_board_item" ADD CONSTRAINT "room_board_item_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_board_item" ADD CONSTRAINT "room_board_item_assignee_principal_id_principal_id_fk" FOREIGN KEY ("assignee_principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_board_item" ADD CONSTRAINT "room_board_item_claimed_by_principal_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_board_item" ADD CONSTRAINT "room_board_item_source_thread_id_room_thread_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."room_thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_board_item" ADD CONSTRAINT "room_board_item_created_by_principal_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_board_item_space_idx" ON "room_board_item" USING btree ("space_id","seq");--> statement-breakpoint
CREATE INDEX "room_board_item_assignee_idx" ON "room_board_item" USING btree ("assignee_principal_id","state");