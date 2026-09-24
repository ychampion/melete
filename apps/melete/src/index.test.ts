import { describe, expect, spyOn, test } from 'bun:test';
import { schema } from './db/schema.ts';
import { loadEnv, readEnv } from './env.ts';
import { bootstrap, createApp, VERSION } from './index.ts';

const testApp = (database: 'ok' | 'unreachable' | 'not_configured' = 'not_configured') =>
  createApp({
    env: loadEnv({}),
    db: null,
    checkDatabase: async () => database,
  });

describe('health', () => {
  test('reports the supervisor and warns only for unsandboxed Hermes', async () => {
    for (const mode of ['process', 'docker'] as const) {
      const warnings: string[] = [];
      const stderr = spyOn(process.stderr, 'write').mockImplementation((message) => {
        warnings.push(String(message));
        return true;
      });
      const service = await bootstrap({
        env: loadEnv({ MELETE_RUNTIME_SUPERVISOR: mode }),
        workers: false,
      });
      try {
        expect(await (await service.app.request('/health')).json()).toMatchObject({
          runtime_adapter: 'hermes',
          runtime_supervisor: mode,
        });
        expect(warnings.join('').includes('not sandboxed')).toBe(mode === 'process');
      } finally {
        await service.close();
        stderr.mockRestore();
      }
    }
  });
  test('reports ok with no database configured', async () => {
    const res = await testApp().request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; database: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe(VERSION);
    expect(body.database).toBe('not_configured');
  });

  test('reports degraded when the database is unreachable', async () => {
    const res = await testApp('unreachable').request('/health');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('degraded');
  });

  test('a sign-in request is dropped once its body is too big, not read whole', async () => {
    // A streamed body declares no length, so only the bytes that arrive can stop it.
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 32 * 1024 * 1024) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await testApp().request('/signin/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'request_too_large',
    );
    expect(pulled).toBeLessThan(1024 * 1024);
  });

  test('a protected endpoint requires a session', async () => {
    const res = await testApp().request('/jobs');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });
});

describe('environment', () => {
  test('defaults are usable with an empty environment', () => {
    const result = readEnv({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PORT).toBe(8787);
      expect(result.env.MELETE_SPACES_DIR).toBe('/data/spaces');
    }
  });

  test('a short master key is refused, with the field named', () => {
    const result = readEnv({ MELETE_MASTER_KEY: 'too-short' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toContain('MELETE_MASTER_KEY');
  });

  test('a nonsense port is refused', () => {
    expect(readEnv({ PORT: 'eight' }).ok).toBe(false);
  });
  test('unknown runtime adapters and supervisors fail fast with the field named', () => {
    for (const field of ['MELETE_RUNTIME_ADAPTER', 'MELETE_RUNTIME_SUPERVISOR']) {
      const result = readEnv({ [field]: 'unknown' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.join()).toContain(field);
    }
  });
});

describe('schema', () => {
  test('every entity in the contract has a table', () => {
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        'action',
        'approval',
        'artifact',
        'attempt',
        'budgetLedger',
        'connection',
        'event',
        'job',
        'knowledgeRecord',
        'owner',
        'secret',
        'skill',
        'space',
        'trigger',
      ]),
    );
  });
});
