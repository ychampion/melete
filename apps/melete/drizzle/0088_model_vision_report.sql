CREATE TABLE "model_vision_report" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"supports_vision" boolean NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_vision_report_provider_model_pk" PRIMARY KEY("provider","model")
);
