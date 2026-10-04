/**
 * Configuration. Everything the service needs comes from the environment and
 * is validated once at start-up, so a missing master key is a clear message on
 * boot rather than a decryption failure three hours into a job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACHMENT_LIMITS, EXEC_LIMITS, PROCESS_LIMITS } from '@melete/contracts';
import { DEFAULT_COMPACTION_MAX_TOKENS, DEFAULT_ENGINE_MAX_TURNS } from '@melete/runtime-hermes';
import { z } from 'zod';
import { REASONING_EFFORTS } from './gateway/effort.ts';
import { parseModelPrices } from './gateway/prices.ts';
import { parseModelChoice } from './gateway/routing.ts';

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
  /**
   * The database role the code that dispatches effects uses: the one role that
   * may read the `secret` table. Set, DATABASE_URL is the service's own role, which
   * cannot; the database's setup step creates both and runs the migrations, so
   * the service checks the roles and the journal instead of migrating
   * (docs/DEPLOYMENT.md, "Database roles"). Left unset, one role does all of it.
   */
  MELETE_EFFECTS_DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, 'must be a postgres:// address')
    .optional(),
  /**
   * Web Push: this installation's VAPID key pair, base64url, written once by
   * configure.ts. Unset, the web app does not offer push.
   */
  MELETE_VAPID_PUBLIC_KEY: unsetWhenBlank(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{86,88}$/)
      .optional(),
  ),
  MELETE_VAPID_PRIVATE_KEY: unsetWhenBlank(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{42,44}$/)
      .optional(),
  ),
  /** Who push services contact about this installation; defaults to mailto: the owner. */
  MELETE_VAPID_SUBJECT: unsetWhenBlank(
    z
      .string()
      .regex(/^(mailto:|https:\/\/)/)
      .optional(),
  ),
  /**
   * Push endpoints on origins other than the browser push services, comma separated:
   * a self-hosted push server, or a test's stand-in.
   */
  MELETE_PUSH_EXTRA_ORIGINS: unsetWhenBlank(z.string().optional()),
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
  /**
   * The operator's Google OAuth client, for signing in to Gmail and Google
   * Calendar (docs/mail-calendar.md). Both, or neither.
   */
  GOOGLE_OAUTH_CLIENT_ID: unsetWhenBlank(z.string().min(1).max(512).optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: unsetWhenBlank(z.string().min(1).max(512).optional()),
  /**
   * The operator's Microsoft Entra app, for signing in to Outlook mail and
   * calendar (docs/mail-calendar.md). Both, or neither. The tenant is `common`,
   * for personal and work accounts, unless a tenant id or domain is named.
   */
  MICROSOFT_OAUTH_CLIENT_ID: unsetWhenBlank(z.string().min(1).max(512).optional()),
  MICROSOFT_OAUTH_CLIENT_SECRET: unsetWhenBlank(z.string().min(1).max(512).optional()),
  MICROSOFT_OAUTH_TENANT: unsetWhenBlank(
    z
      .string()
      .regex(
        /^[A-Za-z0-9.-]{1,253}$/,
        'use common, organizations, consumers, a tenant id or a domain',
      )
      .default('common'),
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
  /**
   * How many engines are kept loaded ahead of the next attempts, so a reply does
   * not wait for an engine to start: `true` is one, `false` or `0` none. Each
   * holds an idle engine's memory while nothing runs. The process supervisor
   * keeps at most one; the Docker runtime keeps this many containers.
   */
  MELETE_ENGINE_PREWARM: unsetWhenBlank(
    z
      .union([z.enum(['true', 'false']), z.coerce.number().int().min(0).max(8)])
      .default('true')
      .transform((v) => (v === 'true' ? 1 : v === 'false' ? 0 : v)),
  ),
  /**
   * How many attempts run at once. Each runs its own engine; a further one
   * waits for a free slot, and its conversation says so.
   */
  MELETE_ATTEMPT_CONCURRENCY: unsetWhenBlank(z.coerce.number().int().min(1).max(32).default(4)),
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
  /** The root of the local blob store, which keeps write-once files by their sha256. */
  MELETE_ARTIFACTS_DIR: z.string().default('/data/artifacts'),
  MELETE_RESTRICTIONS_DIR: z.string().default('/data/restrictions'),
  /**
   * Where blobs are kept: `local` is MELETE_ARTIFACTS_DIR, `s3` an
   * S3-compatible bucket named by the MELETE_BLOB_S3_* settings.
   */
  MELETE_BLOB_STORE: unsetWhenBlank(z.enum(['local', 's3']).default('local')),
  /** Left out, the AWS endpoint for the region. */
  MELETE_BLOB_S3_ENDPOINT: unsetWhenBlank(z.string().url().optional()),
  MELETE_BLOB_S3_BUCKET: unsetWhenBlank(z.string().min(3).max(63).optional()),
  MELETE_BLOB_S3_REGION: unsetWhenBlank(z.string().default('us-east-1')),
  /** Every key is written under this prefix, so one bucket can serve more than one installation. */
  MELETE_BLOB_S3_PREFIX: unsetWhenBlank(
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'letters, digits, ".", "_", "-" and "/" only')
      .optional(),
  ),
  MELETE_BLOB_S3_ACCESS_KEY_ID: unsetWhenBlank(z.string().min(1).optional()),
  MELETE_BLOB_S3_SECRET_ACCESS_KEY: unsetWhenBlank(z.string().min(1).optional()),

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
  /**
   * The cell service that holds the Docker socket, when the service does not
   * (`http://melete-cells:8791` in Compose), and the key it was given. Set, the
   * service reaches the engine only through it.
   */
  MELETE_CELLS_URL: z.string().url().optional(),
  MELETE_CELLS_KEY: z.string().min(32).optional(),
  MELETE_COMPOSE_PROJECT: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .default('melete'),
  /**
   * This service instance's name among several on one database. Left out, the
   * container's host name. Each instance labels the containers it starts with
   * it, so one instance's start never removes another's running cells.
   */
  MELETE_INSTANCE_ID: unsetWhenBlank(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .optional(),
  ),
  MELETE_WORK_VOLUME: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    .default('melete_work'),
  MELETE_RUNTIME_START_TIMEOUT_MS: unsetWhenBlank(
    z.coerce.number().int().positive().default(120_000),
  ),
  /** Stdio MCP servers run in containers beside the attempts; these are the runners' images. */
  MELETE_MCP_NODE_IMAGE: unsetWhenBlank(
    z
      .string()
      .min(1)
      .default(
        'node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85',
      ),
  ),
  MELETE_MCP_PYTHON_IMAGE: unsetWhenBlank(
    z
      .string()
      .min(1)
      .default(
        'ghcr.io/astral-sh/uv:0.12.17-python3.12-alpine@sha256:4c7eb663267624fa1f5b0316b3a51b427578bcb1d93459e1b6dfb5e9875beb0f',
      ),
  ),
  /** The port a server with named destinations uses as its proxy, inside the service container. */
  MELETE_MCP_EGRESS_PORT: unsetWhenBlank(z.coerce.number().int().min(1).max(65535).default(8789)),
  MELETE_MCP_IDLE_MS: unsetWhenBlank(z.coerce.number().int().positive().default(600_000)),
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
   * A model server on this machine or network (OpenAI-compatible, for example
   * Ollama at http://127.0.0.1:11434/v1) that private conversations use until
   * the owner sets one in Settings → Privacy.
   */
  MELETE_LOCAL_MODEL_URL: unsetWhenBlank(z.string().url().optional()),
  MELETE_LOCAL_MODEL: unsetWhenBlank(z.string().max(200).optional()),
  MELETE_LOCAL_MODEL_KEY: unsetWhenBlank(z.string().max(500).optional()),
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
   * Whether the server's default model reads images: `true` or `false`. Left
   * blank, Melete's model catalog decides. A model chosen in the app carries the
   * owner's own answer instead.
   */
  MELETE_DEFAULT_MODEL_VISION: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
  ),
  /**
   * Whether the server's default model searches the web through its provider's
   * own search tool: `true` or `false`. Left blank, Melete's model catalog
   * decides. `false` sends its searches to Melete's own search instead.
   */
  MELETE_DEFAULT_MODEL_NATIVE_SEARCH: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
  ),
  /** A Brave Search API key. When set, `web.search` uses it after a Tavily key. */
  BRAVE_SEARCH_API_KEY: unsetWhenBlank(z.string().min(1).max(512).optional()),
  /**
   * A Tavily API key. When set, `web.search` uses Tavily before anything else,
   * and `web.fetch` reads a page through Tavily Extract when the direct read
   * gets no text from it.
   */
  TAVILY_API_KEY: unsetWhenBlank(z.string().min(1).max(512).optional()),
  /**
   * The output limit the gateway gives a model request that names none. The
   * engine names none by default, so this is the usual ceiling on one reply.
   */
  MELETE_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  MELETE_SPEECH_MODEL: unsetWhenBlank(z.string().optional()),
  /**
   * ElevenLabs, for everything voice (docs/VOICE.md). The key alone turns on
   * speech, transcription, push-to-talk and voice mode, and speech prefers it
   * over an OpenAI key. Each model and voice left empty uses the default there.
   */
  ELEVENLABS_API_KEY: unsetWhenBlank(z.string().min(1).max(512).optional()),
  ELEVENLABS_VOICE_ID: unsetWhenBlank(
    z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/, 'use a voice id from your ElevenLabs voice library')
      .optional(),
  ),
  ELEVENLABS_SECOND_VOICE_ID: unsetWhenBlank(
    z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/, 'use a voice id from your ElevenLabs voice library')
      .optional(),
  ),
  ELEVENLABS_SPEECH_MODEL: unsetWhenBlank(z.string().min(1).max(120).optional()),
  ELEVENLABS_STREAMING_MODEL: unsetWhenBlank(z.string().min(1).max(120).optional()),
  ELEVENLABS_TRANSCRIPTION_MODEL: unsetWhenBlank(z.string().min(1).max(120).optional()),
  /** Seconds of push-to-talk recording one person may have transcribed in a day. */
  MELETE_VOICE_DAILY_SECONDS: unsetWhenBlank(z.coerce.number().int().nonnegative().default(1800)),
  /** Characters of replies one person may have read aloud in a day. */
  MELETE_VOICE_DAILY_CHARACTERS: unsetWhenBlank(
    z.coerce.number().int().nonnegative().default(20_000),
  ),
  /** Voice mode sessions one person may start in a day. */
  MELETE_VOICE_DAILY_SESSIONS: unsetWhenBlank(z.coerce.number().int().nonnegative().default(30)),
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
   * Auto-review asks this model whether a reversible action may go ahead
   * without the person. Unset, it uses the default provider and model; `off`
   * runs no reviewer, and every action it would have reviewed asks the person.
   */
  MELETE_REVIEW_MODEL: z.string().optional(),
  MELETE_REVIEW_PROVIDER: z.string().optional(),
  /** How long one review may take before the action goes to the person. */
  MELETE_REVIEW_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(20_000).default(12_000),
  /** Reviews one space may ask for in an hour; past it, the person is asked. */
  MELETE_REVIEW_HOURLY_LIMIT: z.coerce.number().int().nonnegative().default(60),

  /**
   * Spending caps on model calls, in US dollars (estimated from the price
   * table) and in tokens, for the whole installation and for each person, per
   * UTC day and month. Unset is no limit. docs/DEPLOYMENT.md, "Spending caps".
   */
  MELETE_SPEND_MONTHLY_USD: unsetWhenBlank(z.coerce.number().positive().optional()),
  MELETE_SPEND_DAILY_USD: unsetWhenBlank(z.coerce.number().positive().optional()),
  MELETE_SPEND_PERSON_MONTHLY_USD: unsetWhenBlank(z.coerce.number().positive().optional()),
  MELETE_SPEND_PERSON_DAILY_USD: unsetWhenBlank(z.coerce.number().positive().optional()),
  MELETE_SPEND_MONTHLY_TOKENS: unsetWhenBlank(z.coerce.number().int().positive().optional()),
  MELETE_SPEND_DAILY_TOKENS: unsetWhenBlank(z.coerce.number().int().positive().optional()),
  MELETE_SPEND_PERSON_MONTHLY_TOKENS: unsetWhenBlank(z.coerce.number().int().positive().optional()),
  MELETE_SPEND_PERSON_DAILY_TOKENS: unsetWhenBlank(z.coerce.number().int().positive().optional()),
  /**
   * Each person's background model calls alone (watches, standing runs,
   * routines, memory and learning), beside the limits above. A person's own
   * messages never count here and are never held back by them. Unset is no
   * limit. docs/BACKGROUND-COMPUTE.md.
   */
  MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD: unsetWhenBlank(
    z.coerce.number().positive().optional(),
  ),
  MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD: unsetWhenBlank(z.coerce.number().positive().optional()),
  MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_TOKENS: unsetWhenBlank(
    z.coerce.number().int().positive().optional(),
  ),
  MELETE_SPEND_PERSON_BACKGROUND_DAILY_TOKENS: unsetWhenBlank(
    z.coerce.number().int().positive().optional(),
  ),
  /**
   * When true, a job's model calls count against its dollar limit
   * (`max_usd_est`) as well as its actions do. Off, only actions and search
   * fees count there.
   */
  MELETE_JOB_USD_COUNTS_MODELS: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  ),
  /**
   * Operator alerts on spending, through the same webhook and email as the
   * health alerts. Each is off unless set: the last hour's model spending
   * above this many times the installation's usual hour (the median hour of
   * the week before), or one person above this percent of today's spending.
   * Neither fires below MELETE_ALERT_SPEND_MIN_USD. docs/DEPLOYMENT.md, "Alerts".
   */
  MELETE_ALERT_SPEND_HOURLY_MULTIPLE: unsetWhenBlank(z.coerce.number().min(1).optional()),
  MELETE_ALERT_SPEND_PERSON_PERCENT: unsetWhenBlank(
    z.coerce.number().int().min(1).max(100).optional(),
  ),
  MELETE_ALERT_SPEND_MIN_USD: unsetWhenBlank(z.coerce.number().nonnegative().default(1)),
  /**
   * Files sent in chat: the largest file in MB and the most files in one
   * message, and, unset by default (no limit), how many uploads one person may
   * have under way at once and may start in a window of minutes. A hosted
   * install sets the last two. docs/DEPLOYMENT.md, "Attachments".
   */
  MELETE_ATTACHMENT_MAX_MB: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(ATTACHMENT_LIMITS.file_bytes_ceiling / (1024 * 1024))
      .default(ATTACHMENT_LIMITS.file_bytes / (1024 * 1024)),
  ),
  MELETE_ATTACHMENTS_PER_MESSAGE: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(ATTACHMENT_LIMITS.per_message_ceiling)
      .default(ATTACHMENT_LIMITS.per_message),
  ),
  MELETE_ATTACHMENT_UPLOADS_AT_ONCE: unsetWhenBlank(z.coerce.number().int().positive().optional()),
  MELETE_ATTACHMENT_UPLOADS_PER_WINDOW: unsetWhenBlank(
    z.coerce.number().int().positive().optional(),
  ),
  MELETE_ATTACHMENT_UPLOAD_WINDOW_MINUTES: unsetWhenBlank(
    z.coerce.number().int().min(1).max(1440).default(10),
  ),
  /**
   * Always on, for the service's own sake: uploads it holds in flight at once
   * from everyone, and the MB they may hold between them (never less than one
   * file at the largest size).
   */
  MELETE_ATTACHMENT_SERVER_UPLOADS: unsetWhenBlank(
    z.coerce.number().int().min(1).max(256).default(16),
  ),
  MELETE_ATTACHMENT_SERVER_UPLOAD_MB: unsetWhenBlank(
    z.coerce.number().int().min(1).max(8192).default(384),
  ),
  /** Percent of a limit at which the person is told it is close. */
  MELETE_SPEND_NOTICE_PERCENT: unsetWhenBlank(z.coerce.number().int().min(1).max(99).default(80)),
  /** Per-million-token prices that replace the built-in estimates, as JSON. */
  MELETE_MODEL_PRICES: unsetWhenBlank(
    z
      .string()
      .optional()
      .superRefine((value, context) => {
        try {
          parseModelPrices(value);
        } catch (error) {
          context.addIssue({ code: 'custom', message: (error as Error).message });
        }
      }),
  ),
  /**
   * Model routing, each `provider/model`: a fast model for the service's short
   * calls, a vision model for agent requests that carry pictures, and
   * fallbacks (comma-separated) for a provider that limits or fails.
   */
  MELETE_MODEL_FAST: unsetWhenBlank(z.string().max(400).optional()),
  MELETE_MODEL_VISION: unsetWhenBlank(z.string().max(400).optional()),
  MELETE_MODEL_FALLBACK: unsetWhenBlank(z.string().max(2000).optional()),
  /** Reasoning effort for the agent's turns and for the service's side calls. */
  MELETE_REASONING_EFFORT_AGENT: unsetWhenBlank(z.enum(REASONING_EFFORTS).default('medium')),
  MELETE_REASONING_EFFORT_SIDE: unsetWhenBlank(z.enum(REASONING_EFFORTS).default('low')),

  /**
   * Operator alerts when the service is unhealthy: a webhook that receives a
   * JSON POST, and/or email through an SMTP server. docs/DEPLOYMENT.md, "Alerts".
   */
  MELETE_ALERT_WEBHOOK_URL: unsetWhenBlank(z.url({ protocol: /^https?$/ }).optional()),
  MELETE_ALERT_EMAIL_TO: unsetWhenBlank(z.string().max(500).optional()),
  MELETE_ALERT_EMAIL_FROM: unsetWhenBlank(z.string().max(320).optional()),
  /** smtp:// or smtps://user:password@host:port, for alert email. */
  MELETE_ALERT_SMTP_URL: unsetWhenBlank(z.string().max(2000).optional()),
  /** How often the service checks its own health, in seconds. */
  MELETE_ALERT_INTERVAL_SECONDS: unsetWhenBlank(
    z.coerce.number().int().min(10).max(3600).default(60),
  ),
  /** While unhealthy, how often the alert is repeated, in minutes. */
  MELETE_ALERT_REPEAT_MINUTES: unsetWhenBlank(
    z.coerce.number().int().min(5).max(10_080).default(60),
  ),
  /** A bearer token that opens GET /health/detail to the operator. */
  MELETE_OPERATOR_TOKEN: unsetWhenBlank(z.string().min(24).max(512).optional()),

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
  /** How many background processes one agent's computer may run at once. */
  MELETE_PROCESS_MAX_PER_COMPUTER: unsetWhenBlank(
    z.coerce.number().int().positive().default(PROCESS_LIMITS.max_per_computer),
  ),
  /** How many background processes one space may run at once, over all its computers. */
  MELETE_PROCESS_MAX_PER_SPACE: unsetWhenBlank(
    z.coerce.number().int().positive().default(PROCESS_LIMITS.max_per_space),
  ),
  /** How long a background process runs when it is given no time limit. */
  MELETE_PROCESS_DEFAULT_TTL_MINUTES: unsetWhenBlank(
    z.coerce.number().int().positive().default(PROCESS_LIMITS.default_ttl_minutes),
  ),
  /** The longest time limit a background process may have. */
  MELETE_PROCESS_MAX_TTL_MINUTES: unsetWhenBlank(
    z.coerce.number().int().positive().default(PROCESS_LIMITS.max_ttl_minutes),
  ),
  /** The output a process keeps inside the computer, as a ring of two halves. */
  MELETE_PROCESS_OUTPUT_MAX_BYTES: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .default(PROCESS_LIMITS.output_max_bytes),
  ),
  /**
   * How long a space's background processes may keep its computers running
   * in one day (UTC), after the turns that used them ended, added up over its
   * computers. Past it they are stopped and new ones refused until the next
   * day.
   */
  MELETE_SANDBOX_AWAKE_SECONDS_PER_DAY: unsetWhenBlank(
    z.coerce.number().int().positive().default(PROCESS_LIMITS.awake_seconds_per_day),
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
  /**
   * The sandbox every space gets without anyone installing one. `docker` runs
   * one container per agent on this service's own Docker engine, reached through
   * MELETE_DOCKER_SOCKET; it needs MELETE_SANDBOX_PROJECT. Left unset, a space
   * has a sandbox only when a person installs a connection for one.
   */
  MELETE_SANDBOX_PROVIDER: unsetWhenBlank(z.enum(['docker']).optional()),
  /** The image a docker sandbox starts from; it must already be on the engine. */
  MELETE_SANDBOX_DOCKER_IMAGE: unsetWhenBlank(
    z.string().min(1).max(200).default('melete-sandbox:local'),
  ),
  MELETE_SANDBOX_DOCKER_CPUS: unsetWhenBlank(z.coerce.number().positive().max(64).default(1)),
  MELETE_SANDBOX_DOCKER_MEMORY_MB: unsetWhenBlank(
    z.coerce.number().int().min(512).max(262_144).default(2048),
  ),
  MELETE_SANDBOX_DOCKER_PIDS: unsetWhenBlank(
    z.coerce.number().int().min(64).max(65_536).default(512),
  ),
  /** What the agent's two volumes may hold together, and the largest one file may grow. */
  MELETE_SANDBOX_DOCKER_DISK_MB: unsetWhenBlank(
    z.coerce.number().int().min(256).max(1_048_576).default(4096),
  ),
  /**
   * What the default sandbox may reach: `open` is public HTTPS sites through the
   * service's egress guard, `connected_hosts_only` the hosts listed below,
   * `deny_all` is nothing at all.
   */
  MELETE_SANDBOX_DOCKER_EGRESS: unsetWhenBlank(
    z.enum(['open', 'connected_hosts_only', 'deny_all']).default('open'),
  ),
  /** A container nothing has used for this long is stopped; it starts again when it is used. */
  MELETE_SANDBOX_DOCKER_IDLE_SECONDS: unsetWhenBlank(
    z.coerce.number().int().min(60).max(86_400).default(900),
  ),
  /** The port the egress guard listens on inside the service's container. */
  MELETE_SANDBOX_EGRESS_PORT: unsetWhenBlank(
    z.coerce.number().int().min(1024).max(65_535).default(8791),
  ),
  /**
   * The hosts a `connected_hosts_only` computer may reach, such as a package
   * registry: comma-separated names, or `.example.com` for every name below
   * one. A suffix needs two labels at least, so `.com` alone is refused.
   */
  MELETE_SANDBOX_EGRESS_EXTRA_HOSTS: unsetWhenBlank(
    z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .max(253)
              .regex(
                /^\.?(?=[a-z0-9.-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
                'each extra host is a DNS name, or .name for the names below it',
              )
              .refine(
                (host) => !host.startsWith('.') || host.slice(1).includes('.'),
                'a suffix covers too much with one label; name at least two, as in .example.com',
              ),
          )
          .max(64),
      ),
  ),
  /** How many days a deleted file stays in the trash, where it can be restored. */
  MELETE_TRASH_DAYS: unsetWhenBlank(z.coerce.number().int().min(1).max(365).default(7)),
  /** The most one conversation's trash holds, in MiB; older trash makes room first. */
  MELETE_TRASH_MAX_MB: unsetWhenBlank(z.coerce.number().int().min(1).max(1048576).default(1024)),
  /** How many days the record of where each computer connected is kept. */
  MELETE_EGRESS_RECORD_DAYS: unsetWhenBlank(z.coerce.number().int().min(1).max(3650).default(30)),
  /**
   * The largest change from the command line the egress relay holds while it
   * asks for approval. A larger one is refused with a plain message.
   */
  MELETE_EGRESS_HOLD_MAX_BYTES: unsetWhenBlank(
    z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(512 * 1024 * 1024)
      .default(64 * 1024 * 1024),
  ),
  /**
   * How long a change from the command line waits inside its command for an
   * answer, always ending at least ten seconds before the command's own time.
   */
  MELETE_EGRESS_APPROVAL_HOLD_SECONDS: unsetWhenBlank(
    z.coerce.number().int().min(0).max(600).default(90),
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
  if (value.MELETE_PROCESS_DEFAULT_TTL_MINUTES > value.MELETE_PROCESS_MAX_TTL_MINUTES)
    context.addIssue({
      code: 'custom',
      path: ['MELETE_PROCESS_DEFAULT_TTL_MINUTES'],
      message: `a process's default time limit cannot exceed the longest one: ${value.MELETE_PROCESS_DEFAULT_TTL_MINUTES} is more than MELETE_PROCESS_MAX_TTL_MINUTES=${value.MELETE_PROCESS_MAX_TTL_MINUTES}`,
    });
  if (Boolean(value.MICROSOFT_OAUTH_CLIENT_ID) !== Boolean(value.MICROSOFT_OAUTH_CLIENT_SECRET))
    context.addIssue({
      code: 'custom',
      path: [
        value.MICROSOFT_OAUTH_CLIENT_ID
          ? 'MICROSOFT_OAUTH_CLIENT_SECRET'
          : 'MICROSOFT_OAUTH_CLIENT_ID',
      ],
      message: 'set both MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET, or neither',
    });
  if (value.MELETE_SANDBOX_PROVIDER && !value.MELETE_SANDBOX_PROJECT)
    context.addIssue({
      code: 'custom',
      path: ['MELETE_SANDBOX_PROJECT'],
      message: `MELETE_SANDBOX_PROVIDER=${value.MELETE_SANDBOX_PROVIDER} needs MELETE_SANDBOX_PROJECT, the label that says which sandboxes are this installation's`,
    });
  if (value.MELETE_BLOB_STORE === 's3')
    for (const name of [
      'MELETE_BLOB_S3_BUCKET',
      'MELETE_BLOB_S3_ACCESS_KEY_ID',
      'MELETE_BLOB_S3_SECRET_ACCESS_KEY',
    ] as const)
      if (!value[name])
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `MELETE_BLOB_STORE=s3 needs ${name}`,
        });
  for (const name of ['MELETE_MODEL_FAST', 'MELETE_MODEL_VISION', 'MELETE_MODEL_FALLBACK'] as const)
    for (const entry of (value[name] ?? '').split(',').filter((part) => part.trim()))
      try {
        parseModelChoice(entry, name);
      } catch (error) {
        context.addIssue({ code: 'custom', path: [name], message: (error as Error).message });
      }
  if (value.MELETE_ALERT_EMAIL_TO && !value.MELETE_ALERT_SMTP_URL)
    context.addIssue({
      code: 'custom',
      path: ['MELETE_ALERT_SMTP_URL'],
      message: 'MELETE_ALERT_EMAIL_TO needs MELETE_ALERT_SMTP_URL to send through',
    });
  if (Boolean(value.GOOGLE_OAUTH_CLIENT_ID) !== Boolean(value.GOOGLE_OAUTH_CLIENT_SECRET))
    context.addIssue({
      code: 'custom',
      path: [
        value.GOOGLE_OAUTH_CLIENT_ID ? 'GOOGLE_OAUTH_CLIENT_SECRET' : 'GOOGLE_OAUTH_CLIENT_ID',
      ],
      message: 'set both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or neither',
    });
  return { ...value, MELETE_BROKER_URL: value.MELETE_BROKER_URL ?? derived ?? '' };
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; issues: string[] };

/** Parse without throwing, so the caller decides how loudly to fail. */
/**
 * Settings that may be given as a file instead (`NAME_FILE`), for values a
 * setup step writes into a volume rather than an operator into deploy/.env.
 */
export const FILE_SETTINGS = [
  'DATABASE_URL',
  'MELETE_EFFECTS_DATABASE_URL',
  'MELETE_CELLS_KEY',
] as const;

/** The source with each `NAME_FILE` read into `NAME`, where `NAME` itself is unset. */
export function withFileSettings(
  source: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, string | undefined> {
  const out = { ...source };
  for (const name of FILE_SETTINGS) {
    const path = source[`${name}_FILE`]?.trim();
    if (!path || source[name]?.trim()) continue;
    try {
      out[name] = read(path).trim();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
      throw new Error(`${name}_FILE names ${path}, which could not be read (${code})`);
    }
  }
  return out;
}

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
  // Only the process that starts reads the files; a check of the settings does not.
  const result = readEnv(withFileSettings(source));
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
