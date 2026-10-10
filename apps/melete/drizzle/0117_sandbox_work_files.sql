CREATE TABLE "sandbox_work_file" (
	"space_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text,
	"writers" text[] DEFAULT '{}'::text[] NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_work_file_space_id_agent_id_connection_id_path_pk" PRIMARY KEY("space_id","agent_id","connection_id","path")
);
--> statement-breakpoint
CREATE TABLE "sandbox_work_read" (
	"space_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_work_read_space_id_agent_id_connection_id_pk" PRIMARY KEY("space_id","agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_work_removal" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"job_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_work_file" ADD CONSTRAINT "sandbox_work_file_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_file" ADD CONSTRAINT "sandbox_work_file_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_file" ADD CONSTRAINT "sandbox_work_file_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_read" ADD CONSTRAINT "sandbox_work_read_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_read" ADD CONSTRAINT "sandbox_work_read_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_read" ADD CONSTRAINT "sandbox_work_read_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_removal" ADD CONSTRAINT "sandbox_work_removal_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_removal" ADD CONSTRAINT "sandbox_work_removal_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_work_removal" ADD CONSTRAINT "sandbox_work_removal_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_work_removal_computer_idx" ON "sandbox_work_removal" USING btree ("space_id","agent_id","connection_id");