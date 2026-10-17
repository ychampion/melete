CREATE TABLE "composio_usage" (
	"period" text NOT NULL,
	"dimension" text NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reported" bigint,
	"used_at_report" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_usage_period_dimension_pk" PRIMARY KEY("period","dimension"),
	CONSTRAINT "composio_usage_period_check" CHECK ("composio_usage"."period" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "composio_usage_dimension_check" CHECK ("composio_usage"."dimension" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "composio_usage_used_check" CHECK ("composio_usage"."used" >= 0)
);
