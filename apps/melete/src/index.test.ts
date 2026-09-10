import { describe, expect, test } from 'bun:test';
import { openDatabase, pingDatabase } from './db/client.ts';
import { schema } from './db/schema.ts';
import { loadEnv, readEnv } from './env.ts';
import { createApp, VERSION } from './index.ts';

const testApp = (database: 'ok' | 'unreachable' | 'not_configured' = 'not_configured') =>
  createApp({
    env: loadEnv({}),
    db: null,
    checkDatabase: async () => database,
  });

describe('health', () => {
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

  test('an unimplemented endpoint says so instead of pretending', async () => {
    const res = await testApp().request('/jobs');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
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
});

describe('schema', () => {
  test('every entity in the contract has a table', () => {
    expect(Object.keys(schema).sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

// The service must be testable with no database. These run only when one is
// configured, and say plainly why they were skipped when it is not.
const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  process.stdout.write('db tests skipped: set DATABASE_URL to run them against a real Postgres\n');
}

describeWithDb('against a real database', () => {
  test('answers a ping', async () => {
    const handle = openDatabase(DATABASE_URL as string);
    try {
      expect(await pingDatabase(handle)).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
