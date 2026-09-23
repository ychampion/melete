/**
 * One place that decides what the engine is configured to do.
 *
 * Every surface that starts the engine — the image's baked configuration, the
 * boot script, the process supervisor, the container supervisor, the evaluation
 * stack and the local end-to-end harness — used to spell its own subset of these
 * keys, and they had drifted apart. They now all render the same object from the
 * same options, so a setting is changed once and every surface moves with it.
 *
 * The renderer is pure and holds no secrets. The attempt capability is a
 * per-attempt value and the surrogate model key is an environment name, so the
 * image's copy carries neither; the boot script writes the capability into the
 * rendered object at start-up, and callers that already hold it (a supervisor on
 * the host, a test harness) may pass it here instead.
 */
import {
  GATEWAY_MAX_REQUEST_BYTES,
  hasKnownContextWindow,
  modelContextWindow,
} from '@melete/contracts';

/** Where in-cell commands run, once the native terminal toolset is turned on. */
export type TerminalBackend = 'local' | 'melete_sandbox';

/** The brokered tool a sandbox connection serves; its presence is what selects the sandbox. */
export const SANDBOX_TERMINAL_TOOL = 'terminal.run';

/**
 * The engine's toolset holding its terminal and nothing else. The `terminal`
 * toolset also carries `process_manage`, whose background polls would each
 * become a broker action; background processes in a remote sandbox are not
 * offered.
 */
export const SANDBOX_TERMINAL_TOOLSET = 'terminal_tools';

/**
 * The engine features an attempt's catalog calls for. A space with one active
 * sandbox connection is offered exactly one `terminal.run`, and then the
 * engine's own terminal is built and pinned to the sandbox backend, which
 * forwards every command to the broker. Anything else keeps today's
 * configuration: no terminal at all, and never a local one.
 */
export function attemptEngineFeatures(
  tools: readonly { name: string; connection_id: string | null }[],
): Partial<EngineFeatures> {
  const connections = new Set(
    tools
      .filter((tool) => tool.name === SANDBOX_TERMINAL_TOOL && tool.connection_id)
      .map((tool) => tool.connection_id),
  );
  if (connections.size !== 1) return {};
  return {
    toolsets: [...DEFAULT_FEATURES.toolsets, SANDBOX_TERMINAL_TOOLSET],
    terminalBackend: 'melete_sandbox',
  };
}

/**
 * Engine capabilities that are switched on one at a time, each by its own
 * change. Every default here is what the runtime does today, so rendering with
 * no features named reproduces the current behaviour exactly.
 */
export type EngineFeatures = {
  /** Toolsets the API-server agent is built with. Naming only the plugin's toolset is what turns every built-in off. */
  toolsets: readonly string[];
  /** The engine's own tool-search bridge, in place of the plugin's scoped search. */
  toolSearch: boolean;
  /** The native skills index and viewer. */
  skills: boolean;
  /** Absent while no terminal toolset is built. */
  terminalBackend: TerminalBackend | null;
};

export type EngineConfigOptions = {
  /** The gateway path segment naming which upstream the gateway injects a key for. */
  provider: string;
  /** The model id the attempt is allowed to spend on. */
  model: string;
  /** Base address of the broker, which carries the metered model paths. */
  brokerUrl: string;
  /** The wire protocol the gateway expects for this model, when it is not the default. */
  modelApiMode?: string;
  /** Overrides the catalog window; a proof that needs a small window states it here. */
  contextWindow?: number;
  /** The window an operator stated for this deployment's models. */
  contextWindowLimit?: number;
  /** The largest body the model gateway will accept. */
  gatewayMaxRequestBytes?: number;
  /** The owner's ceiling on the compaction trigger. */
  compactionMaxTokens?: number;
  /** The engine's per-run iteration ceiling. */
  maxTurns?: number;
  /** Written into the model and provider headers when the caller may hold it. */
  capability?: string;
  features?: Partial<EngineFeatures>;
};

/**
 * A runaway ceiling, not a cost control: a run that has taken 150 turns is
 * looping, and the job's own accounting decides what an attempt may spend.
 */
export const DEFAULT_ENGINE_MAX_TURNS = 150;

/**
 * The owner's cap on the compaction trigger. Without it a million-token window
 * would let half a million tokens accumulate before the first summary, and every
 * request until then carries the whole history.
 */
export const DEFAULT_COMPACTION_MAX_TOKENS = 200_000;

/** The provider entry name every rendered configuration uses. */
export const GATEWAY_PROVIDER = 'melete-gateway';

/** The header the model gateway meters by. */
export const CAPABILITY_HEADER = 'x-melete-capability';

/** What the image is built with when nothing names a model. */
export const DEFAULT_ENGINE_PROVIDER = 'fireworks';
export const DEFAULT_ENGINE_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
export const DEFAULT_BROKER_URL = 'http://melete:8788';

/** The engine home's skills directory is filled from this path; it must not exist. */
export const BUNDLED_SKILLS_DIR = '/opt/melete-runtime/no-bundled-skills';

const DEFAULT_FEATURES: EngineFeatures = {
  toolsets: ['melete'],
  toolSearch: false,
  skills: false,
  terminalBackend: null,
};

/**
 * Below this window the engine treats the conversation as short enough to keep
 * whole, and its own minimum overrides the percentage.
 */
const MINIMUM_TRIGGER_WINDOW = 64_000;

/** Above this window the engine keeps the configured half rather than raising it. */
const LARGE_WINDOW = 512_000;

/** The share of the window the engine will not let the minimum push past. */
const MINIMUM_TRIGGER_CEILING = 0.85;

/** Headroom between the compaction trigger and the body the gateway will accept. */
const BODY_LIMIT_HEADROOM = 0.8;

/** The engine's own estimate: four characters of request body to the token. */
const CHARS_PER_TOKEN = 4;

/**
 * The number of tokens at which the engine itself would start a compaction for a
 * window, reproducing its arithmetic: half the window, raised to three quarters
 * below 512,000 tokens, then floored at 64,000 but never above 85% of the
 * window. At 64,000 tokens the floor binds and the ceiling applies, which is why
 * the answer there is 54,400 rather than the 48,000 the percentage alone gives.
 */
export function engineCompactionTrigger(contextWindow: number): number {
  const percent = contextWindow < LARGE_WINDOW ? 0.75 : 0.5;
  const scaled = Math.floor(contextWindow * percent);
  if (scaled >= MINIMUM_TRIGGER_WINDOW) return scaled;
  return Math.min(MINIMUM_TRIGGER_WINDOW, Math.floor(contextWindow * MINIMUM_TRIGGER_CEILING));
}

/**
 * The window to tell the engine about.
 *
 * The catalog names the models Melete knows, and anything else falls back to
 * 128,000 tokens — a guess, and one that is too generous for a smaller model: it
 * would be told to compact at 96,000 tokens, never reach that, and have every
 * request past its own window refused by the provider with nothing summarized.
 * So an operator may state the window their deployment's models really have. For
 * a model the catalog names their number may lower the window and never raise
 * it, because the catalog is what the gateway's own accounting is keyed on; for
 * one it does not name, their number is the only real one there is.
 */
export function engineContextWindow(model: string, stated?: number): number {
  const catalog = modelContextWindow(model);
  if (stated === undefined) return catalog;
  return hasKnownContextWindow(model) ? Math.min(catalog, stated) : stated;
}

/**
 * The trigger Melete configures: the engine's own trigger, lowered by the
 * owner's cap, and lowered again to stay inside the body the gateway accepts.
 * The last term is what keeps proactive compaction ahead of the gateway's
 * refusal rather than behind it.
 */
export function compactionThresholdTokens(options: {
  contextWindow: number;
  compactionMaxTokens?: number;
  gatewayMaxRequestBytes?: number;
}): number {
  const bodyLimit = Math.floor(
    (BODY_LIMIT_HEADROOM * (options.gatewayMaxRequestBytes ?? GATEWAY_MAX_REQUEST_BYTES)) /
      CHARS_PER_TOKEN,
  );
  return Math.min(
    engineCompactionTrigger(options.contextWindow),
    options.compactionMaxTokens ?? DEFAULT_COMPACTION_MAX_TOKENS,
    bodyLimit,
  );
}

export type EngineConfig = Record<string, unknown>;

/** The engine configuration these options describe, secrets included only if given. */
/**
 * What the engine tells the model about the surface its reply reaches. Melete
 * shows replies as chat text, and files the model makes arrive as artifacts.
 */
export const API_SERVER_HINT =
  'Replies are shown to the person as chat text. Keep them brief and natural. Files you make reach them as artifacts, never as paths in the reply.';

export function renderEngineConfig(options: EngineConfigOptions): EngineConfig {
  const features = { ...DEFAULT_FEATURES, ...options.features };
  const contextWindow =
    options.contextWindow ?? engineContextWindow(options.model, options.contextWindowLimit);
  const thresholdTokens = compactionThresholdTokens({
    contextWindow,
    compactionMaxTokens: options.compactionMaxTokens,
    gatewayMaxRequestBytes: options.gatewayMaxRequestBytes,
  });
  const headers = options.capability
    ? { extra_headers: { [CAPABILITY_HEADER]: options.capability } }
    : {};
  const provider: Record<string, unknown> = {
    base_url: `${options.brokerUrl.replace(/\/+$/, '')}/providers/${options.provider}/v1`,
    key_env: 'MELETE_MODEL_KEY',
    default_model: options.model,
    ...headers,
  };
  if (options.modelApiMode) provider.api_mode = options.modelApiMode;
  const config: EngineConfig = {
    platform_toolsets: { api_server: [...features.toolsets] },
    plugins: { enabled: ['melete'], allow_deprecated_imports: false },
    tools: { tool_search: { enabled: features.toolSearch ? 'on' : 'off' } },
    // The two keys the engine actually reads. A store built from either one
    // loads its files out of the engine home whatever the toolset list says.
    memory: { memory_enabled: false, user_profile_enabled: false, provider: '' },
    curator: { enabled: false },
    checkpoints: { enabled: false },
    agent: {
      max_turns: options.maxTurns ?? DEFAULT_ENGINE_MAX_TURNS,
      // Read under `agent:` (agent/agent_init.py:1336). The probe describes the
      // host's Python toolchain, which no tool offered to an attempt uses.
      environment_probe: false,
      // The prompt seam in patches/observer_bridge.py: leaves out the engine's
      // product pointer, its profile line and its host runtime block.
      host_prompt: false,
    },
    // Read at the top level, not under `agent:` (agent/agent_init.py:1352).
    // Replaces the engine's api_server hint, which describes MEDIA: file tags
    // no Melete surface renders.
    platform_hints: { api_server: { replace: API_SERVER_HINT } },
    tool_loop_guardrails: { hard_stop_enabled: true },
    compression: {
      enabled: true,
      in_place: true,
      abort_on_summary_failure: false,
      threshold_tokens: thresholdTokens,
    },
    auxiliary: {
      title_generation: { enabled: false },
      background_review: { enabled: false },
      compression: { provider: GATEWAY_PROVIDER, fallback_chain: [] },
    },
    approvals: { unattended_mode: 'deny', timeout: 300 },
    model: {
      provider: GATEWAY_PROVIDER,
      default: options.model,
      context_length: contextWindow,
      ...headers,
    },
    providers: { [GATEWAY_PROVIDER]: provider },
    gateway: { platforms: { api_server: { max_concurrent_runs: 1 } } },
  };
  if (features.skills)
    config.skills = {
      project_discovery: false,
      external_dirs: [],
      inline_shell: false,
      write_approval: false,
    };
  if (features.terminalBackend)
    config.terminal = { backend: features.terminalBackend, cwd: '/work' };
  return config;
}

/** The options the image's own copy is rendered from. */
export const IMAGE_ENGINE_OPTIONS: EngineConfigOptions = {
  provider: DEFAULT_ENGINE_PROVIDER,
  model: DEFAULT_ENGINE_MODEL,
  brokerUrl: DEFAULT_BROKER_URL,
};

/**
 * The per-attempt numbers the boot script applies over the image's copy. They
 * are not secret, but they follow the model the attempt was given, which the
 * image cannot know.
 */
export function engineConfigEnvironment(options: EngineConfigOptions): Record<string, string> {
  const contextWindow =
    options.contextWindow ?? engineContextWindow(options.model, options.contextWindowLimit);
  const terminal = options.features?.terminalBackend;
  return {
    // The engine reads its backend from here as well as from the file; the
    // boot script writes the terminal section from it and refuses any other.
    ...(terminal ? { TERMINAL_ENV: terminal } : {}),
    MELETE_ENGINE_MAX_TURNS: String(options.maxTurns ?? DEFAULT_ENGINE_MAX_TURNS),
    MELETE_ENGINE_CONTEXT_LENGTH: String(contextWindow),
    MELETE_ENGINE_COMPACTION_THRESHOLD: String(
      compactionThresholdTokens({
        contextWindow,
        compactionMaxTokens: options.compactionMaxTokens,
        gatewayMaxRequestBytes: options.gatewayMaxRequestBytes,
      }),
    ),
  };
}

const positive = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new RangeError(`${name} must be a positive whole number of tokens`);
  return parsed;
};

/** The settings an operator may state, read once and validated once. */
export function engineSettingsFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): { maxTurns: number; compactionMaxTokens: number; contextWindowLimit: number | undefined } {
  return {
    maxTurns:
      positive(environment.MELETE_ENGINE_MAX_TURNS, 'MELETE_ENGINE_MAX_TURNS') ??
      DEFAULT_ENGINE_MAX_TURNS,
    compactionMaxTokens:
      positive(environment.MELETE_COMPACTION_MAX_TOKENS, 'MELETE_COMPACTION_MAX_TOKENS') ??
      DEFAULT_COMPACTION_MAX_TOKENS,
    contextWindowLimit: positive(
      environment.MELETE_MODEL_CONTEXT_WINDOW,
      'MELETE_MODEL_CONTEXT_WINDOW',
    ),
  };
}
