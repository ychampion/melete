import { describe, expect, test } from 'bun:test';
import {
  COMMAND_LINE_ADAPTERS,
  CONNECTION_KIND_DESCRIPTORS,
  CONNECTION_KIND_SCOPES,
  type ConnectorManifest,
} from '@melete/contracts';
import { createCommandLineConnector } from '../egress/connector.ts';
import { storedSandboxConnection } from '../sandbox/connection.ts';
import {
  DEFAULT_SANDBOX_LIFETIME_SECONDS,
  defaultSandboxConfig,
  dockerSandboxSettings,
} from '../sandbox/docker-default.ts';
import { artifactsManifest } from './artifacts.ts';
import { BUILTIN_CONNECTIONS, builtinEnvironment } from './builtin.ts';
import { calendarManifest } from './calendar.ts';
import { emailManifest } from './email.ts';
import { execManifest } from './exec.ts';
import { filesManifest } from './files.ts';
import { sandboxExecManifest } from './sandbox-exec.ts';
import { webManifest } from './web.ts';

const toolNames = (manifest: ConnectorManifest) => manifest.tools.map((tool) => tool.name).sort();

describe('default connections', () => {
  test('only connectors that declare no credential are defaults, each granted exactly its own tools', () => {
    const manifests: Record<string, ConnectorManifest> = {
      files: filesManifest,
      web: webManifest,
      artifacts: artifactsManifest,
      exec: execManifest,
      sandbox: sandboxExecManifest,
    };
    expect(BUILTIN_CONNECTIONS.map((builtin) => builtin.provider).sort()).toEqual([
      'artifacts',
      'exec',
      'files',
      // Speech and transcription: two rows of the one generation provider.
      'generation',
      'generation',
      'sandbox',
      'web',
    ]);
    for (const builtin of BUILTIN_CONNECTIONS) {
      const manifest = manifests[builtin.provider];
      if (!manifest) continue;
      expect(manifest.credentials).toEqual([]);
      expect([...builtin.scopes].sort()).toEqual(toolNames(manifest));
    }
    for (const credentialed of [emailManifest, calendarManifest])
      expect(credentialed.credentials.length).toBeGreaterThan(0);
  });

  test('a sandbox is a default only where the operator asked for one on the local engine', () => {
    const env = {
      MELETE_RUNTIME_ADAPTER: 'docker',
      MELETE_DOCKER_SOCKET: '/var/run/docker.sock',
      MELETE_SANDBOX_PROVIDER: 'docker' as const,
      MELETE_SANDBOX_PROJECT: 'house',
    };
    const inContainer = '3f2a9c1b7e4d';
    expect(defaultSandboxConfig({ ...env, MELETE_SANDBOX_PROVIDER: undefined }, inContainer)).toBe(
      null,
    );
    expect(defaultSandboxConfig({ ...env, MELETE_SANDBOX_PROJECT: undefined }, inContainer)).toBe(
      null,
    );
    expect(defaultSandboxConfig(env, inContainer)).toEqual({
      adapter: 'docker',
      image: 'melete-sandbox:local',
      egress: 'open',
      persistence: 'pause',
      lifetime_seconds: DEFAULT_SANDBOX_LIFETIME_SECONDS,
    });
    // Outside a container the service cannot be the sandbox's only way out: no network, never more.
    expect(defaultSandboxConfig(env, 'laptop')?.egress).toBe('deny_all');
    expect(
      defaultSandboxConfig({ ...env, MELETE_RUNTIME_ADAPTER: 'hermes' }, inContainer)?.egress,
    ).toBe('deny_all');
    expect(
      defaultSandboxConfig({ ...env, MELETE_SANDBOX_DOCKER_EGRESS: 'deny_all' }, inContainer)
        ?.egress,
    ).toBe('deny_all');
    // Held to connected hosts is still the service's guard, so it narrows the same way.
    const held = { ...env, MELETE_SANDBOX_DOCKER_EGRESS: 'connected_hosts_only' as const };
    expect(defaultSandboxConfig(held, inContainer)?.egress).toBe('connected_hosts_only');
    expect(defaultSandboxConfig(held, 'laptop')?.egress).toBe('deny_all');
    const wanted = BUILTIN_CONNECTIONS.find((builtin) => builtin.key === 'sandbox');
    const sandbox = defaultSandboxConfig(env, inContainer);
    expect(
      wanted?.when?.({
        cellIsolated: true,
        speechConfigured: false,
        transcriptionConfigured: false,
        sandbox,
      }),
    ).toBe(true);
    expect(
      wanted?.when?.({
        cellIsolated: true,
        speechConfigured: false,
        transcriptionConfigured: false,
        sandbox: null,
      }),
    ).toBe(false);
    // The row reads back as an ordinary sandbox connection.
    expect(
      storedSandboxConnection.parse({
        ...wanted?.configuration?.({
          cellIsolated: true,
          speechConfigured: false,
          transcriptionConfigured: false,
          sandbox,
        }),
        builtin: 'sandbox',
      }).sandbox.adapter,
    ).toBe('docker');
    expect(dockerSandboxSettings(env, inContainer)).toMatchObject({
      socket: '/var/run/docker.sock',
      selfId: inContainer,
      cpus: 1,
      memoryMb: 2048,
    });
    expect(dockerSandboxSettings(env, 'laptop').selfId).toBeUndefined();
  });

  test('every default effect that leaves the space waits for approval', () => {
    for (const manifest of [filesManifest, webManifest, artifactsManifest, execManifest])
      for (const tool of manifest.tools)
        if (tool.effect_class === 'write_external' || tool.effect_class === 'spend')
          expect(tool.requires_approval).toBe(true);
  });

  test('in-cell execution and speech are defaults only where the deployment supports them', () => {
    const base = { MELETE_RUNTIME_ADAPTER: 'hermes', MELETE_RUNTIME_SUPERVISOR: 'process' };
    expect(builtinEnvironment(base)).toEqual({
      cellIsolated: false,
      speechConfigured: false,
      transcriptionConfigured: false,
      sandbox: null,
    });
    expect(builtinEnvironment({ ...base, MELETE_RUNTIME_SUPERVISOR: 'docker' }).cellIsolated).toBe(
      true,
    );
    expect(builtinEnvironment({ ...base, MELETE_RUNTIME_ADAPTER: 'docker' }).cellIsolated).toBe(
      true,
    );
    expect(
      builtinEnvironment({
        MELETE_RUNTIME_ADAPTER: 'stub',
        MELETE_RUNTIME_SUPERVISOR: 'docker',
      }).cellIsolated,
    ).toBe(false);
    expect(builtinEnvironment({ ...base, OPENAI_API_KEY: 'configured' })).toMatchObject({
      speechConfigured: true,
      transcriptionConfigured: false,
    });
    // ElevenLabs speaks and transcribes; it wins over an OpenAI key beside it.
    expect(
      builtinEnvironment({ ...base, OPENAI_API_KEY: 'configured', ELEVENLABS_API_KEY: 'key' }),
    ).toMatchObject({ speechConfigured: true, transcriptionConfigured: true });
    const wanted = (environment: ReturnType<typeof builtinEnvironment>) =>
      BUILTIN_CONNECTIONS.filter((builtin) => builtin.when?.(environment) ?? true).map(
        (builtin) => builtin.key,
      );
    expect(wanted(builtinEnvironment(base))).toEqual(['files', 'web', 'artifacts']);
    expect(
      wanted({ cellIsolated: true, speechConfigured: true, transcriptionConfigured: true }),
    ).toEqual(['files', 'web', 'artifacts', 'generation', 'transcription', 'exec']);
  });
});

describe('installable kinds against the connectors they select', () => {
  test('the grants a kind offers are the tools its connector declares', () => {
    const sorted = (scopes: readonly string[]) => [...scopes].sort();
    expect(sorted(CONNECTION_KIND_SCOPES.mail)).toEqual(toolNames(emailManifest));
    expect(sorted(CONNECTION_KIND_SCOPES.caldav)).toEqual(toolNames(calendarManifest));
    expect(sorted(CONNECTION_KIND_SCOPES.ics)).toEqual(['calendar.list']);
    expect(sorted(CONNECTION_KIND_SCOPES.sandbox)).toEqual(toolNames(sandboxExecManifest));
    // The read grant is checked by the egress relay itself; the write grant is the broker tool.
    expect(sorted(CONNECTION_KIND_SCOPES.command_line)).toEqual(
      sorted(
        COMMAND_LINE_ADAPTERS.flatMap((adapter) => [
          `egress.${adapter}_read`,
          ...toolNames(createCommandLineConnector(adapter).manifest),
        ]),
      ),
    );
  });

  test('a form says a grant asks first exactly when the connector requires approval', () => {
    const tools = new Map(
      [
        ...emailManifest.tools,
        ...calendarManifest.tools,
        ...sandboxExecManifest.tools,
        ...COMMAND_LINE_ADAPTERS.flatMap(
          (adapter) => createCommandLineConnector(adapter).manifest.tools,
        ),
      ].map((tool) => [tool.name, tool]),
    );
    for (const descriptor of CONNECTION_KIND_DESCRIPTORS)
      for (const scope of descriptor.scopes) {
        // Reading through the relay is no tool: it never asks.
        if (/^egress\.[a-z0-9]+_read$/.test(scope.scope)) {
          expect([scope.effect_class, scope.asks_first]).toEqual(['read', false]);
          continue;
        }
        const tool = tools.get(scope.scope);
        expect(tool).toBeDefined();
        expect(scope.effect_class).toBe(tool?.effect_class ?? 'read');
        expect(scope.asks_first).toBe(tool?.requires_approval ?? false);
      }
  });
});
