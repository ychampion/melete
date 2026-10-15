CREATE TABLE "spend_limit" (
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"monthly_usd" double precision NOT NULL,
	"set_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_limit_kind_target_id_pk" PRIMARY KEY("kind","target_id"),
	CONSTRAINT "spend_limit_kind" CHECK ("spend_limit"."kind" in ('member', 'space')),
	CONSTRAINT "spend_limit_usd" CHECK ("spend_limit"."monthly_usd" >= 0)
);
