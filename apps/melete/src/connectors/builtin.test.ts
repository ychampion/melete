import { describe, expect, test } from 'bun:test';
import {
  CONNECTION_KIND_DESCRIPTORS,
  CONNECTION_KIND_SCOPES,
  type ConnectorManifest,
} from '@melete/contracts';
import { artifactsManifest } from './artifacts.ts';
import { BUILTIN_CONNECTIONS, builtinEnvironment } from './builtin.ts';
import { calendarManifest } from './calendar.ts';
import { emailManifest } from './email.ts';
import { execManifest } from './exec.ts';
import { filesManifest } from './files.ts';
import { webManifest } from './web.ts';

const toolNames = (manifest: ConnectorManifest) => manifest.tools.map((tool) => tool.name).sort();

describe('default connections', () => {
  test('only connectors that declare no credential are defaults, each granted exactly its own tools', () => {
    const manifests: Record<string, ConnectorManifest> = {
      files: filesManifest,
      web: webManifest,
      artifacts: artifactsManifest,
      exec: execManifest,
    };
    expect(BUILTIN_CONNECTIONS.map((builtin) => builtin.provider).sort()).toEqual([
      'artifacts',
      'exec',
      'files',
      'generation',
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

  test('every default effect that leaves the space waits for approval', () => {
    for (const manifest of [filesManifest, webManifest, artifactsManifest, execManifest])
      for (const tool of manifest.tools)
        if (tool.effect_class === 'write_external' || tool.effect_class === 'spend')
          expect(tool.requires_approval).toBe(true);
  });

  test('in-cell execution and speech are defaults only where the deployment supports them', () => {
    const base = { MELETE_RUNTIME_ADAPTER: 'hermes', MELETE_RUNTIME_SUPERVISOR: 'process' };
    expect(builtinEnvironment(base)).toEqual({ cellIsolated: false, speechConfigured: false });
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
    expect(builtinEnvironment({ ...base, OPENAI_API_KEY: 'configured' }).speechConfigured).toBe(
      true,
    );
    const wanted = (environment: ReturnType<typeof builtinEnvironment>) =>
      BUILTIN_CONNECTIONS.filter((builtin) => builtin.when?.(environment) ?? true).map(
        (builtin) => builtin.key,
      );
    expect(wanted(builtinEnvironment(base))).toEqual(['files', 'web', 'artifacts']);
    expect(wanted({ cellIsolated: true, speechConfigured: true })).toEqual([
      'files',
      'web',
      'artifacts',
      'generation',
      'exec',
    ]);
  });
});

describe('installable kinds against the connectors they select', () => {
  test('the grants a kind offers are the tools its connector declares', () => {
    const sorted = (scopes: readonly string[]) => [...scopes].sort();
    expect(sorted(CONNECTION_KIND_SCOPES.mail)).toEqual(toolNames(emailManifest));
    expect(sorted(CONNECTION_KIND_SCOPES.caldav)).toEqual(toolNames(calendarManifest));
    expect(sorted(CONNECTION_KIND_SCOPES.ics)).toEqual(['calendar.list']);
  });

  test('a form says a grant asks first exactly when the connector requires approval', () => {
    const tools = new Map(
      [...emailManifest.tools, ...calendarManifest.tools].map((tool) => [tool.name, tool]),
    );
    for (const descriptor of CONNECTION_KIND_DESCRIPTORS)
      for (const scope of descriptor.scopes) {
        const tool = tools.get(scope.scope);
        expect(tool).toBeDefined();
        expect(scope.effect_class).toBe(tool?.effect_class ?? 'read');
        expect(scope.asks_first).toBe(tool?.requires_approval ?? false);
      }
  });
});
