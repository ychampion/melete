CREATE TABLE "task_autonomy" (
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"level" text,
	"set_by" text,
	"turn_id" text,
	"ask_id" text,
	"asked_job_id" text,
	"asked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_autonomy_principal_id_kind_pk" PRIMARY KEY("principal_id","kind"),
	CONSTRAINT "task_autonomy_kind" CHECK ("task_autonomy"."kind" in ('email', 'chat_message', 'calendar_invite', 'public_post', 'other_send')),
	CONSTRAINT "task_autonomy_level" CHECK ("task_autonomy"."level" is null or "task_autonomy"."level" in ('draft', 'when_confident', 'always')),
	CONSTRAINT "task_autonomy_set_by" CHECK ("task_autonomy"."set_by" is null or "task_autonomy"."set_by" in ('settings', 'card', 'chat'))
);
