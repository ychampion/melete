/**
 * Configuration. Everything the service needs comes from the environment and
 * is validated once at start-up, so a missing master key is a clear message on
 * boot rather than a decryption failure three hours into a job.
 */
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Compose resolves an alias assigned only to edge; local development uses loopback. */
  MELETE_API_BIND: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Seals connection secrets and provider keys at rest. The operator holds it;
   * losing it means re-entering every credential, which is the intended trade.
   */
  MELETE_MASTER_KEY: z.string().min(32).optional(),

  DATABASE_URL: z.string().min(1).optional(),
  /** Signs bounded attempt capabilities; this key never enters an AttemptBundle. */
  MELETE_CAPABILITY_KEY: z.string().min(32).optional(),
  /** Docker supervises isolated attempts; stub is an explicit local test choice. */
  MELETE_RUNTIME_ADAPTER: z.enum(['stub', 'external', 'docker']).default('external'),

  /** Where space git repositories and workspace files live. */
  MELETE_SPACES_DIR: z.string().default('/data/spaces'),
  MELETE_ARTIFACTS_DIR: z.string().default('/data/artifacts'),
  MELETE_RESTRICTIONS_DIR: z.string().default('/data/restrictions'),

  /** The address the runtime container reaches the broker on, internal network only. */
  MELETE_BROKER_BIND: z.string().default('127.0.0.1:3112'),
  MELETE_APPROVAL_KEY: z.string().min(32).optional(),
  MELETE_WORK_DIR: z.string().default('/work'),
  MELETE_CONNECTIONS_FILE: z.string().optional(),
  MELETE_GATEWAY_TLS_DIR: z.string().optional(),
  MELETE_ENABLE_TEST_CONNECTOR: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MELETE_ENABLE_FAKE_PROVIDER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MELETE_RUNTIME_URL: z.string().default('http://runtime:8790'),
  MELETE_RUNTIME_KEY: z.string().min(32).optional(),
  MELETE_RUNTIME_IMAGE: z.string().default('melete-runtime:local'),
  MELETE_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  MELETE_COMPOSE_PROJECT: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .default('melete'),
  MELETE_WORK_VOLUME: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    .default('melete_work'),
  MELETE_RUNTIME_START_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Provider keys. The gateway injects these; the runtime never sees them. */
  FIREWORKS_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),

  MELETE_DEFAULT_PROVIDER: z.string().default('fireworks'),
  MELETE_DEFAULT_MODEL: z.string().default('deepseek-v4p1-flash'),
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; issues: string[] };

/** Parse without throwing, so the caller decides how loudly to fail. */
export function readEnv(source: Record<string, string | undefined> = process.env): EnvResult {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}

/** Start-up path: a bad environment stops the process before it accepts traffic. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = readEnv(source);
  if (!result.ok) {
    throw new Error(`invalid environment:\n  ${result.issues.join('\n  ')}`);
  }
  return result.env;
}

/**
 * Secret writes require the master key; parsing and decryption stay in the
 * service-owned sealed store.
 */
export const canSealSecrets = (env: Env): boolean => Boolean(env.MELETE_MASTER_KEY);
