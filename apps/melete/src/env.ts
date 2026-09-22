/**
 * Configuration. Everything the service needs comes from the environment and
 * is validated once at start-up, so a missing master key is a clear message on
 * boot rather than a decryption failure three hours into a job.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COMPACTION_MAX_TOKENS, DEFAULT_ENGINE_MAX_TURNS } from '@melete/runtime-hermes';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** `host:port`, with brackets around an IPv6 host. */
export function parseBrokerBind(bind: string): { hostname: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(bind);
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { hostname: match[1].replace(/^\[|\]$/g, ''), port };
}

const WILDCARD_HOSTS: Record<string, string> = { '0.0.0.0': '127.0.0.1', '::': '::1' };
const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname === '::1' || /^127(\.\d{1,3}){3}$/.test(hostname);

/**
 * Where this service reaches the broker it bound. A wildcard bind is not a
 * destination, so it is reached over loopback on the same port.
 */
export function brokerUrlForBind(bind: string): string | null {
  const parsed = parseBrokerBind(bind);
  if (!parsed) return null;
  const hostname = WILDCARD_HOSTS[parsed.hostname] ?? parsed.hostname;
  return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${parsed.port}`;
}

/** Why a configured broker address cannot reach the bound listener, if it cannot. */
function brokerUrlMismatch(bind: string, url: string): string | null {
  const bound = parseBrokerBind(bind);
  if (!bound) return null;
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  if (port !== bound.port)
    return `MELETE_BROKER_URL names port ${port}, but MELETE_BROKER_BIND listens on ${bound.port}`;
  if (bound.hostname in WILDCARD_HOSTS) return null;
  if (isLoopback(bound.hostname) !== isLoopback(hostname))
    return `MELETE_BROKER_URL host ${hostname} cannot reach a broker bound to ${bound.hostname} (MELETE_BROKER_BIND)`;
  return null;
}

/**
 * Compose writes `${NAME:-}` as an empty string, so an optional setting left
 * blank in deploy/.env arrives as '' and means the same as leaving it out.
 */
const unsetWhenBlank = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/**
 * Whether the Postgres client can read this address. It is judged here, the
 * way the client reads it (only the first of several hosts goes through the URL
 * parser), because the client's own parse error quotes the whole address,
 * password included, and does not say which setting it came from.
 *
 * The client ignores the scheme name, so any `scheme://` address it can parse
 * is kept, in any case and after leading whitespace. The one exception is an
 * address that names another database, which cannot be what was meant.
 */
const OTHER_DATABASE =
  /^\s*(?:mysql|mariadb|mssql|sqlserver|sqlite|mongodb(?:\+srv)?|rediss?):\/\//i;

export function isPostgresUrl(value: string): boolean {
  if (!/^\s*[a-z][a-z0-9+.-]*:\/\//i.test(value) || OTHER_DATABASE.test(value)) return false;
  const authority = value.slice(value.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
  try {
    const hosts = decodeURIComponent(authority.slice(authority.indexOf('@') + 1));
    const url = new URL(value.replace(hosts, hosts.split(',')[0] ?? ''));
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return true;
  } catch {
    return false;
  }
}

const variables = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Compose resolves an alias assigned only to edge; local development uses loopback. */
  MELETE_API_BIND: z.string().min(1).default('127.0.0.1'),
  /**
   * The web proxy on the edge network, by service name or address. Only a
   * connection from it may state a browser's address; unset, no peer is believed.
   */
  MELETE_TRUSTED_PROXY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Seals connection secrets and provider keys at rest. The operator holds it;
   * losing it means re-entering every credential, which is the intended trade.
   */
  MELETE_MASTER_KEY: z.string().min(32).optional(),

  DATABASE_URL: z
    .string()
    .refine(
      isPostgresUrl,
      'must be a postgres:// address, for example postgres://melete:password@postgres:5432/melete',
    )
    .optional(),
  MELETE_PUBLIC_URL: unsetWhenBlank(
    z
      .url()
      .refine((value) => {
        const address = new URL(value);
        return (
          ['http:', 'https:'].includes(address.protocol) && !address.username && !address.password
        );
      }, 'Use your public web address.')
      .optional(),
  ),
  /** Signs bounded attempt capabilities; this key never enters an AttemptBundle. */
  MELETE_CAPABILITY_KEY: z.string().min(32).optional(),
  /**
   * `hermes` starts one pinned engine per attempt through the selected supervisor;
   * `docker` is the deploy lane's supervised container path; `external` expects an
   * injected RuntimeAdapter; `stub` is an explicit scripted development choice.
   */
  MELETE_RUNTIME_ADAPTER: z.enum(['hermes', 'stub', 'external', 'docker']).default('hermes'),
  MELETE_RUNTIME_SUPERVISOR: z.enum(['process', 'docker']).default('process'),
  MELETE_HERMES_ROOT: z.string().default(join(root, '.hermes-src')),
  MELETE_HERMES_PYTHON: z
    .string()
    .default(
      join(
        root,
        '.hermes-venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
    ),
  MELETE_RUNTIME_PACKAGE: z.string().default(join(root, 'packages/runtime-hermes')),
  MELETE_RUNTIME_NETWORK: z.string().default('melete_internal'),
  MELETE_RUNTIME_WORK_VOLUME: z.string().default('melete_work'),

  /** Where space git repositories and workspace files live. */
  MELETE_SPACES_DIR: z.string().default('/data/spaces'),
  MELETE_ARTIFACTS_DIR: z.string().default('/data/artifacts'),
  MELETE_RESTRICTIONS_DIR: z.string().default('/data/restrictions'),

  /** The address the runtime container reaches the broker on, internal network only. */
  MELETE_BROKER_BIND: z
    .string()
    .default('127.0.0.1:3112')
    .refine((bind) => parseBrokerBind(bind) !== null, 'must be hostname:port'),
  /**
   * Where the service reads its own tool catalog, and the address process-mode
   * attempts are handed. Left out, it follows MELETE_BROKER_BIND.
   */
  MELETE_BROKER_URL: z.string().url().optional(),
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
  /** Browser credentials and endpoint are service-owned; neither is sent to the runtime cell. */
  MELETE_BROWSER_URL: z.url().optional(),
  MELETE_BROWSER_SPACE: z
    .string()
    .regex(/^sp_[A-Za-z0-9_-]+$/)
    .optional(),
  MELETE_BROWSER_TOKEN: z.string().min(32).optional(),
  MELETE_BROWSER_IDLE_MS: z.coerce.number().int().positive().default(300_000),

  /** Provider keys. The gateway injects these; the runtime never sees them. */
  FIREWORKS_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  /**
   * OAuth for the OpenAI-compatible endpoint, for a provider that issues access
   * tokens instead of keys. The owner signs in once; the gateway refreshes.
   */
  OPENAI_COMPAT_OAUTH_ISSUER: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_AUTHORIZE_URL: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_TOKEN_URL: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_REVOKE_URL: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_CLIENT_ID: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_CLIENT_SECRET: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_SCOPES: unsetWhenBlank(z.string().optional()),
  OPENAI_COMPAT_OAUTH_REDIRECT_URL: unsetWhenBlank(z.string().optional()),

  MELETE_DEFAULT_PROVIDER: z.string().default('fireworks'),
  /** The identifier the provider serves, which for Fireworks is the full account path. */
  MELETE_DEFAULT_MODEL: z.string().default('accounts/fireworks/models/deepseek-v4p1-flash'),
  /**
   * The output limit the gateway gives a model request that names none. The
   * engine names none by default, so this is the usual ceiling on one reply.
   */
  MELETE_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  MELETE_SPEECH_MODEL: z.string().optional(),

  /**
   * What the engine in an attempt's cell is bounded by. Each is read again from
   * the environment when an attempt starts, which is where it is applied, but it
   * is checked here so a malformed value stops the service on boot rather than
   * failing every attempt one at a time afterwards. `docs/DEPLOYMENT.md` says
   * what each of them buys.
   */
  MELETE_ENGINE_MAX_TURNS: unsetWhenBlank(
    z.coerce.number().int().positive().default(DEFAULT_ENGINE_MAX_TURNS),
  ),
  MELETE_COMPACTION_MAX_TOKENS: unsetWhenBlank(
    z.coerce.number().int().positive().default(DEFAULT_COMPACTION_MAX_TOKENS),
  ),
  MELETE_MODEL_CONTEXT_WINDOW: unsetWhenBlank(z.coerce.number().int().positive().optional()),
});

/**
 * A catalog address that misses the bound broker fails every attempt before its
 * first model call, so the pair is settled here rather than at the first job.
 */
export const envSchema = variables.transform((value, context) => {
  const derived = brokerUrlForBind(value.MELETE_BROKER_BIND);
  const mismatch =
    value.MELETE_BROKER_URL === undefined
      ? null
      : brokerUrlMismatch(value.MELETE_BROKER_BIND, value.MELETE_BROKER_URL);
  if (mismatch)
    context.addIssue({ code: 'custom', path: ['MELETE_BROKER_URL'], message: mismatch });
  return { ...value, MELETE_BROKER_URL: value.MELETE_BROKER_URL ?? derived ?? '' };
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
