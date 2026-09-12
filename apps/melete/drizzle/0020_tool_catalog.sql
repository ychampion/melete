CREATE TABLE attempt_tool_context (
  attempt_id text PRIMARY KEY REFERENCES attempt(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  core jsonb NOT NULL CHECK (jsonb_typeof(core) = 'array'),
  loaded jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(loaded) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
