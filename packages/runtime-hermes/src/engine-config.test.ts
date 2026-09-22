import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GATEWAY_MAX_REQUEST_BYTES } from '@melete/contracts';
import { parse } from 'yaml';
import {
  API_SERVER_HINT,
  attemptEngineFeatures,
  compactionThresholdTokens,
  DEFAULT_COMPACTION_MAX_TOKENS,
  DEFAULT_ENGINE_MAX_TURNS,
  engineCompactionTrigger,
  engineConfigEnvironment,
  engineContextWindow,
  engineSettingsFromEnvironment,
  IMAGE_ENGINE_OPTIONS,
  renderEngineConfig,
} from './engine-config.ts';
import { renderSoul } from './instructions.ts';

const base = {
  provider: 'fireworks',
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  brokerUrl: 'http://melete:8788',
};

/** The one gateway provider entry every rendered configuration carries. */
const gatewayEntry = (config: Record<string, unknown>): Record<string, unknown> =>
  (config.providers as Record<string, Record<string, unknown>>)['melete-gateway'] ?? {};

test('the engine trigger follows the engine, including the floor that binds at 64K', () => {
  expect(engineCompactionTrigger(64_000)).toBe(54_400);
  expect(engineCompactionTrigger(128_000)).toBe(96_000);
  expect(engineCompactionTrigger(1_000_000)).toBe(500_000);
});

test('the rendered threshold is the lowest of trigger, owner cap and body limit', () => {
  expect(compactionThresholdTokens({ contextWindow: 64_000 })).toBe(54_400);
  expect(compactionThresholdTokens({ contextWindow: 128_000 })).toBe(96_000);
  // Half of a million-token window is far past what an owner wants to pay for
  // on every request, so the cap decides instead of the engine.
  expect(compactionThresholdTokens({ contextWindow: 1_000_000 })).toBe(200_000);
  expect(compactionThresholdTokens({ contextWindow: 1_000_000, compactionMaxTokens: 40_000 })).toBe(
    40_000,
  );
});

test('the rendered threshold stays below the gateway body limit', () => {
  // Four characters to the token is the engine's own estimate, and the gateway
  // now counts the same way, so this comparison is in one unit.
  const bodyLimit = GATEWAY_MAX_REQUEST_BYTES / 4;
  for (const contextWindow of [64_000, 128_000, 1_000_000, 8_000_000]) {
    const threshold = compactionThresholdTokens({ contextWindow });
    expect(threshold).toBeLessThan(bodyLimit);
    expect(threshold).toBeLessThanOrEqual(Math.floor((0.8 * GATEWAY_MAX_REQUEST_BYTES) / 4));
  }
  // A smaller body limit lowers the threshold rather than being ignored.
  expect(
    compactionThresholdTokens({ contextWindow: 1_000_000, gatewayMaxRequestBytes: 256 * 1024 }),
  ).toBe(52_428);
});

test('the rendered configuration pins the keys the engine actually reads', () => {
  const config = renderEngineConfig(base) as Record<string, Record<string, unknown>>;
  expect(config.memory).toEqual({
    memory_enabled: false,
    user_profile_enabled: false,
    provider: '',
  });
  expect(config.skills).toBeUndefined();
  // environment_probe is read under `agent:` (agent/agent_init.py:1336);
  // host_prompt is the checked prompt seam in patches/observer_bridge.py.
  expect(config.agent).toEqual({
    max_turns: DEFAULT_ENGINE_MAX_TURNS,
    environment_probe: false,
    host_prompt: false,
  });
  // platform_hints is read at the top level (agent/agent_init.py:1352).
  expect(config.platform_hints).toEqual({ api_server: { replace: API_SERVER_HINT } });
  expect(config.tool_loop_guardrails).toEqual({ hard_stop_enabled: true });
  expect(config.checkpoints).toEqual({ enabled: false });
  expect(config.curator).toEqual({ enabled: false });
  expect(config.compression).toEqual({
    enabled: true,
    in_place: true,
    abort_on_summary_failure: false,
    threshold_tokens: 200_000,
  });
  expect(config.auxiliary).toEqual({
    title_generation: { enabled: false },
    background_review: { enabled: false },
    compression: { provider: 'melete-gateway', fallback_chain: [] },
  });
  expect(config.model).toEqual({
    provider: 'melete-gateway',
    default: base.model,
    context_length: 1_000_000,
  });
});

test('this change turns nothing else on', () => {
  const config = renderEngineConfig(base) as Record<string, Record<string, unknown>>;
  expect(config.platform_toolsets).toEqual({ api_server: ['melete'] });
  expect(config.tools).toEqual({ tool_search: { enabled: 'off' } });
  expect(config.terminal).toBeUndefined();
});

test('a feature switch renders the section it belongs to and nothing else', () => {
  const config = renderEngineConfig({
    ...base,
    features: {
      toolsets: ['melete', 'terminal', 'file'],
      toolSearch: true,
      skills: true,
      terminalBackend: 'melete_sandbox',
    },
  }) as Record<string, Record<string, unknown>>;
  expect(config.platform_toolsets).toEqual({ api_server: ['melete', 'terminal', 'file'] });
  expect(config.tools).toEqual({ tool_search: { enabled: 'on' } });
  expect(config.terminal).toEqual({ backend: 'melete_sandbox', cwd: '/work' });
  expect(config.skills).toEqual({
    project_discovery: false,
    external_dirs: [],
    inline_shell: false,
    write_approval: false,
  });
});

test('the capability is written into the model headers as well as the provider', () => {
  const withSecret = renderEngineConfig({ ...base, capability: 'attempt-token' }) as Record<
    string,
    Record<string, unknown>
  >;
  const header = { 'x-melete-capability': 'attempt-token' };
  expect((withSecret.model as { extra_headers?: unknown }).extra_headers).toEqual(header);
  expect(gatewayEntry(withSecret).extra_headers).toEqual(header);
  // The auxiliary summary client reads only the model section, so a provider
  // copy on its own leaves that call unauthenticated.
  const withoutSecret = renderEngineConfig(base) as Record<string, Record<string, unknown>>;
  expect((withoutSecret.model as { extra_headers?: unknown }).extra_headers).toBeUndefined();
});

test('the provider entry addresses the broker and names the wire protocol when asked', () => {
  const config = renderEngineConfig({
    ...base,
    brokerUrl: 'http://127.0.0.1:8788/',
    modelApiMode: 'chat_completions',
  });
  expect(gatewayEntry(config)).toEqual({
    base_url: 'http://127.0.0.1:8788/providers/fireworks/v1',
    key_env: 'MELETE_MODEL_KEY',
    default_model: base.model,
    api_mode: 'chat_completions',
  });
});

test('the numbers handed to a container are the numbers the renderer computed', () => {
  expect(engineConfigEnvironment(base)).toEqual({
    MELETE_ENGINE_MAX_TURNS: '150',
    MELETE_ENGINE_CONTEXT_LENGTH: '1000000',
    MELETE_ENGINE_COMPACTION_THRESHOLD: '200000',
  });
  expect(engineConfigEnvironment({ ...base, model: 'a-model-nobody-listed' })).toEqual({
    MELETE_ENGINE_MAX_TURNS: '150',
    MELETE_ENGINE_CONTEXT_LENGTH: '128000',
    MELETE_ENGINE_COMPACTION_THRESHOLD: '96000',
  });
});

test('a window an operator states decides for a model the catalog cannot', () => {
  // The 128,000-token fallback is a guess, and on a model whose real window is
  // 32,000 it is four times too generous: the engine is told to compact at
  // 96,000, never reaches it, and every request past the model's own window
  // comes back refused by the provider with nothing summarized.
  const small = renderEngineConfig({
    ...base,
    model: 'a-model-nobody-listed',
    contextWindowLimit: 32_000,
  }) as Record<string, Record<string, unknown>>;
  expect(small.model?.context_length).toBe(32_000);
  expect(small.compression?.threshold_tokens).toBe(27_200);
  expect(engineContextWindow('a-model-nobody-listed', 32_000)).toBe(32_000);
  // For a model the catalog does name, a stated window may lower it and never
  // raise it: the catalog is what the gateway's own accounting is keyed on.
  expect(engineContextWindow(base.model, 250_000)).toBe(250_000);
  expect(engineContextWindow(base.model, 2_000_000)).toBe(1_000_000);
  expect(engineContextWindow(base.model)).toBe(1_000_000);
  expect(
    engineConfigEnvironment({
      ...base,
      model: 'a-model-nobody-listed',
      contextWindowLimit: 32_000,
    }),
  ).toEqual({
    MELETE_ENGINE_MAX_TURNS: '150',
    MELETE_ENGINE_CONTEXT_LENGTH: '32000',
    MELETE_ENGINE_COMPACTION_THRESHOLD: '27200',
  });
});

test('operator settings are read once and refused when they are not numbers', () => {
  expect(engineSettingsFromEnvironment({})).toEqual({
    maxTurns: DEFAULT_ENGINE_MAX_TURNS,
    compactionMaxTokens: DEFAULT_COMPACTION_MAX_TOKENS,
    contextWindowLimit: undefined,
  });
  expect(
    engineSettingsFromEnvironment({
      MELETE_ENGINE_MAX_TURNS: '40',
      MELETE_COMPACTION_MAX_TOKENS: '60000',
      MELETE_MODEL_CONTEXT_WINDOW: '32000',
    }),
  ).toEqual({ maxTurns: 40, compactionMaxTokens: 60_000, contextWindowLimit: 32_000 });
  expect(() => engineSettingsFromEnvironment({ MELETE_ENGINE_MAX_TURNS: '0' })).toThrow(RangeError);
  expect(() => engineSettingsFromEnvironment({ MELETE_COMPACTION_MAX_TOKENS: 'lots' })).toThrow(
    RangeError,
  );
  expect(() => engineSettingsFromEnvironment({ MELETE_MODEL_CONTEXT_WINDOW: '-1' })).toThrow(
    RangeError,
  );
});

test('the identity in the image is the one every attempt is given', () => {
  expect(readFileSync(join(import.meta.dir, '..', 'config', 'SOUL.md'), 'utf8')).toBe(renderSoul());
});

test('the configuration in the image is what the renderer produces', () => {
  const committed = parse(
    readFileSync(join(import.meta.dir, '..', 'config', 'config.yaml'), 'utf8'),
  );
  expect(committed).toEqual(renderEngineConfig(IMAGE_ENGINE_OPTIONS));
});

/**
 * Files that may name a provider entry without rendering one: the renderer
 * itself, the copy the image carries, and the tests and fixtures that assert
 * against what those two produce. Nothing here starts an engine.
 */
const SPELLED_BY_HAND = [
  'apps/melete/src/runtime/supervisor.test.ts',
  'packages/runtime-hermes/config/config.yaml',
  'packages/runtime-hermes/src/engine-config.test.ts',
  'packages/runtime-hermes/src/engine-config.ts',
  'packages/runtime-hermes/tests/test_engine_surface.py',
  'packages/runtime-hermes/tests/test_entrypoint.py',
];

test('nothing that starts an engine spells its configuration by hand', () => {
  // The claim this module makes is that every surface renders from it. A second
  // spelling is that claim quietly becoming false, and the one this first caught
  // had been starting an engine with both of its built-in memory stores on,
  // because `memory.enabled` is not a key the engine reads.
  const root = join(import.meta.dir, '..', '..', '..');
  const spelled: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
      } else if (/\.(ts|py|sh|ya?ml)$/.test(entry.name)) {
        // `key_env` names the environment variable a provider entry takes its
        // key from, and appears nowhere but in an engine configuration.
        if (readFileSync(path, 'utf8').includes('key_env'))
          spelled.push(relative(root, path).replaceAll('\\', '/'));
      }
    }
  };
  for (const directory of ['apps', 'conformance', 'deploy', 'evals', 'packages'])
    walk(join(root, directory));
  expect(spelled.sort()).toEqual(SPELLED_BY_HAND);
});

test('a catalog with one sandbox terminal pins the engine terminal to the sandbox', () => {
  const sandbox = { name: 'terminal.run', connection_id: 'conn_sandbox' };
  const features = attemptEngineFeatures([{ name: 'react', connection_id: null }, sandbox]);
  expect(features).toEqual({ toolsets: ['melete', 'terminal'], terminalBackend: 'melete_sandbox' });
  const config = renderEngineConfig({ ...base, features }) as Record<
    string,
    Record<string, unknown>
  >;
  expect(config.platform_toolsets).toEqual({ api_server: ['melete', 'terminal'] });
  expect(config.terminal).toEqual({ backend: 'melete_sandbox', cwd: '/work' });
  expect(engineConfigEnvironment({ ...base, features }).TERMINAL_ENV).toBe('melete_sandbox');
});

test('no sandbox, or two, leaves the engine without a terminal', () => {
  for (const tools of [
    [],
    [{ name: 'exec.run', connection_id: 'conn_exec' }],
    [{ name: 'terminal.run', connection_id: null }],
    [
      { name: 'terminal.run', connection_id: 'conn_a' },
      { name: 'terminal.run', connection_id: 'conn_b' },
    ],
  ]) {
    const features = attemptEngineFeatures(tools);
    expect(features).toEqual({});
    const config = renderEngineConfig({ ...base, features }) as Record<string, unknown>;
    expect(config.terminal).toBeUndefined();
    expect(engineConfigEnvironment({ ...base, features }).TERMINAL_ENV).toBeUndefined();
  }
});
