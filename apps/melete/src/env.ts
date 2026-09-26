/**
 * Configuration. Everything the service needs comes from the environment and
 * is validated once at start-up, so a missing master key is a clear message on
 * boot rather than a decryption failure three hours into a job.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEC_LIMITS } from '@melete/contracts';
import { DEFAULT_COMPACTION_MAX_TOKENS, DEFAULT_ENGINE_MAX_TURNS } from '@melete/runtime-hermes';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** How long a sandbox command's workspace may take to sync in and out, around the command. */
export const SANDBOX_SYNC_ALLOWANCE_MS = 120_000;

/**
 * The shortest lease a sandbox session may have: the longest command it can
 * be sent and the syncs around it, with a minute to spare, so a lease renewed
 * as a command is sent cannot run out while that command runs.
 */
export const SANDBOX_LEASE_FLOOR_SECONDS =
  Math.ceil((EXEC_LIMITS.max_timeout_ms + SANDBOX_SYNC_ALLOWANCE_MS) / 1000) + 60;

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
  /**
   * Whether an https:// MELETE_PUBLIC_URL publishes this service's OAuth Client
   * ID Metadata Document. Turn it off when that address is reachable only on a
   * private network, so authorization servers are offered dynamic registration.
   */
  MELETE_OAUTH_CLIENT_METADATA: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  ),
  /** Signs bounded attempt capabilities; this key never enters an AttemptBundle. */
  MELETE_CAPABILITY_KEY: z.string().min(32).optional(),
  /**
   * `hermes` starts one pinned engine per attempt through the selected supervisor;
   * `docker` is the deployment's supervised container path; `external` expects an
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
  /** Stdio MCP servers run in containers beside the attempts; these are the runners' images. */
  MELETE_MCP_NODE_IMAGE: z
    .string()
    .min(1)
    .default(
      'node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85',
    ),
  MELETE_MCP_PYTHON_IMAGE: z
    .string()
    .min(1)
    .default(
      'ghcr.io/astral-sh/uv:0.12.17-python3.12-alpine@sha256:4c7eb663267624fa1f5b0316b3a51b427578bcb1d93459e1b6dfb5e9875beb0f',
    ),
  /** The port a server with named destinations uses as its proxy, inside the service container. */
  MELETE_MCP_EGRESS_PORT: z.coerce.number().int().min(1).max(65535).default(8789),
  MELETE_MCP_IDLE_MS: z.coerce.number().int().positive().default(600_000),
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
   * The OAuth client ChatGPT sign-in presents. Left empty, the Codex CLI's
   * public client, the only one OpenAI has registered for this sign-in.
   */
  MELETE_CHATGPT_CLIENT_ID: unsetWhenBlank(z.string().max(200).optional()),
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
  /** The provider's name on the sign-in button, for example "Acme Models". */
  OPENAI_COMPAT_OAUTH_LABEL: unsetWhenBlank(z.string().max(60).optional()),

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
   * Automatic memory reads what a person says in chat with this model, through
   * the model gateway. Unset, it uses the default provider and model; `off`
   * keeps structured observations only and makes no model call.
   */
  MELETE_MEMORY_MODEL: z.string().optional(),
  MELETE_MEMORY_PROVIDER: z.string().optional(),
  /** Extraction calls one person's memory may make in a day. */
  MELETE_MEMORY_DAILY_CALLS: z.coerce.number().int().nonnegative().default(200),

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

  /**
   * Which sandboxes at a provider belong to this installation. It is the
   * `melete.project` label, and reconciliation destroys only sandboxes that
   * carry it, so two installations sharing one provider account never touch
   * each other's. Pick something random once and keep it: changing it orphans
   * whatever the old value labelled.
   */
  MELETE_SANDBOX_PROJECT: unsetWhenBlank(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,40}$/)
      .optional(),
  ),
  /** How long a sandbox session may go unrenewed before the sweep ends it. */
  MELETE_SANDBOX_LEASE_SECONDS: unsetWhenBlank(
    z.coerce.number().int().min(SANDBOX_LEASE_FLOOR_SECONDS).default(900),
  ),
  /** The most sandboxes this installation may have running at once, over every connection. */
  MELETE_SANDBOX_MAX_CONCURRENT: unsetWhenBlank(z.coerce.number().int().positive().default(4)),
  /**
   * The most any one connection may have running. A provider quota belongs to
   * an account, and a connection is an account here, so this keeps one busy
   * space from spending another's. Left unset it is the ceiling above, and it
   * is never allowed past it.
   */
  MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION: unsetWhenBlank(
    z.coerce.number().int().positive().optional(),
  ),
  /** How long a suspended workspace is kept while nobody resumes it. */
  MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 3600),
  ),
  /**
   * How long Modal keeps a workspace snapshot, and Daytona a stopped
   * workspace, that this service never deletes. It
   * must outlast the retention period, or a workspace would be offered a
   * snapshot the provider has already collected. A snapshot deletion the
   * provider acknowledged is not re-checked; anything it missed expires with
   * the snapshot TTL (MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS).
   */
  MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 24 * 3600),
  ),
  /** E2B's maximum continuous runtime follows the account's plan. */
  MELETE_E2B_PLAN: unsetWhenBlank(z.enum(['hobby', 'pro']).default('hobby')),
  /**
   * Modal's SDK speaks gRPC, and its transport honours `grpc_proxy`,
   * `https_proxy`, `http_proxy` and `GRPC_DEFAULT_SSL_ROOTS_FILE_PATH` from
   * this process's own environment. Where one of those is set, the Modal
   * adapter is refused unless the operator says here that the proxy and its
   * trust anchors are theirs.
   */
  MELETE_SANDBOX_ALLOW_PROXY_ENVIRONMENT: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  ),
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
  if (value.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS < value.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS)
    context.addIssue({
      code: 'custom',
      path: ['MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS'],
      message: `a workspace snapshot must outlast the retention period: ${value.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS}s is shorter than MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS=${value.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS}s`,
    });
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
 * Settings that belong to the scripted demonstration, left on beside a real
 * model provider. The test connector accepts sends to a fixture destination,
 * and the scripted provider answers without a model, so on a production
 * installation either is a way for work to look done when nothing was.
 */
export function demonstrationWarnings(env: Env): string[] {
  if (env.MELETE_DEFAULT_PROVIDER === 'fake') return [];
  const provider = env.MELETE_DEFAULT_PROVIDER;
  return [
    ...(env.MELETE_ENABLE_TEST_CONNECTOR
      ? [
          `MELETE_ENABLE_TEST_CONNECTOR=true is set beside the real provider ${provider}. The test connector is for the scripted demonstration; set it to false in deploy/.env unless you mean to keep a test destination.`,
        ]
      : []),
    ...(env.MELETE_ENABLE_FAKE_PROVIDER
      ? [
          `MELETE_ENABLE_FAKE_PROVIDER=true is set beside the real provider ${provider}. The scripted provider is for the demonstration; set it to false in deploy/.env so no job can be served by it.`,
        ]
      : []),
  ];
}

/**
 * Secret writes require the master key; parsing and decryption stay in the
 * service-owned sealed store.
 */
export const canSealSecrets = (env: Env): boolean => Boolean(env.MELETE_MASTER_KEY);
