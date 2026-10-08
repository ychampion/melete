CREATE TABLE "service_path" (
	"space_id" text NOT NULL,
	"service_key" text NOT NULL,
	"operation_key" text NOT NULL,
	"task_kind" text NOT NULL,
	"path" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"unknowns" integer DEFAULT 0 NOT NULL,
	"handed" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_fault" text,
	"last_fault_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_path_space_id_service_key_operation_key_task_kind_path_pk" PRIMARY KEY("space_id","service_key","operation_key","task_kind","path"),
	CONSTRAINT "service_path_path" CHECK ("service_path"."path" in ('api', 'browser', 'person')),
	CONSTRAINT "service_path_counts" CHECK ("service_path"."attempts" >= 0 and "service_path"."successes" >= 0 and "service_path"."failures" >= 0 and "service_path"."unknowns" >= 0 and "service_path"."handed" >= 0 and "service_path"."streak" >= 0)
);
--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "service_key" text;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "operation_intent" text;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "stands_in_for" text;--> statement-breakpoint
ALTER TABLE "service_path" ADD CONSTRAINT "service_path_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;