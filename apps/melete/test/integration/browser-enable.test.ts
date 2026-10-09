import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  configuredBrowserSessions,
  configuredConnectors,
} from '../../src/connectors/configured.ts';
import { loadEnv } from '../../src/env.ts';
import { bootstrap } from '../../src/index.ts';
import {
  BROWSER_SCOPES,
  BrowserEnableRefusal,
  enableBrowser,
} from '../../src/workers/browser/enable.ts';
import { testDatabase } from '../helpers/database.ts';

const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-browser-enable-'));
const fixture = await testDatabase();
afterAll(async () => {
  await fixture?.close();
  if (dirname(await realpath(root)) !== (await realpath(tmpdir())))
    throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
}, 60_000);

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserEnableRefusal);
    return (error as Error).message;
  }
  throw new Error('Expected a refusal');
};

(fixture ? test : test.skip)(
  "the browser connection is made once, in the first person's space, beside its own web connection",
  async () => {
    if (!fixture) throw new Error('Postgres unavailable');
    const running = await bootstrap({
      workers: false,
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: fixture.url,
        MELETE_CAPABILITY_KEY: 'browser-enable-key'.repeat(3),
        MELETE_RUNTIME_ADAPTER: 'stub',
        MELETE_SPACES_DIR: root,
        MELETE_WORK_DIR: root,
      }),
    });
    try {
      const options = { sql: fixture.sql, db: fixture.db, spacesRoot: root };
      // Before anyone has an account there is no space to serve, and nothing is made.
      expect(await refusal(enableBrowser(options))).toContain('There is no account yet');
      expect(await fixture.sql`select id from connection where label = 'Browser'`).toHaveLength(0);

      const setup = await running.app.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.test', password: 'browser-enable-password' }),
      });
      expect(setup.status).toBe(201);
      const [space] = await fixture.sql<
        { id: string }[]
      >`select id from space where kind = 'personal'`;
      if (!space) throw new Error('Missing personal space');

      const first = await enableBrowser(options);
      expect(first).toEqual({
        space_id: space.id,
        connection_id: expect.stringMatching(/^conn_/),
        created: true,
      });
      // The worker mounts the space's own directory, so it exists now.
      expect((await stat(join(root, space.id))).isDirectory()).toBe(true);

      // A second run finds the same connection and makes nothing.
      expect(await enableBrowser(options)).toEqual({ ...first, created: false });
      expect(await enableBrowser({ ...options, space: space.id })).toEqual({
        ...first,
        created: false,
      });
      const rows = await fixture.sql<
        { id: string; label: string; scopes: string[]; status: string; configuration: object }[]
      >`select id, label, scopes, status, configuration from connection
        where space_id = ${space.id} and provider = 'web' order by id`;
      expect(rows).toHaveLength(2);
      const browser = rows.find((row) => row.id === first.connection_id);
      const web = rows.find((row) => row.id !== first.connection_id);
      expect(browser).toMatchObject({ label: 'Browser', status: 'active' });
      expect([...(browser?.scopes ?? [])].sort()).toEqual([...BROWSER_SCOPES].sort());
      // The space's own web connection keeps its search and reading.
      expect(web?.configuration).toEqual({ builtin: 'web' });
      expect(web?.scopes).toContain('web.fetch');
      expect(web?.scopes).not.toContain('browser.observe');

      expect(await refusal(enableBrowser({ ...options, space: 'sp_missing' }))).toContain(
        'There is no space sp_missing',
      );

      // With the operator's entry and the worker's address, the row is the
      // browser in production, and the web connection is still the web.
      const connections = [{ kind: 'browser' as const, id: first.connection_id }];
      const env = loadEnv({
        NODE_ENV: 'production',
        MELETE_BROWSER_SPACE: space.id,
        MELETE_BROWSER_URL: 'http://browser:3132',
        MELETE_BROWSER_TOKEN: 'x'.repeat(64),
        MELETE_SPACES_DIR: root,
      });
      const configured = await configuredBrowserSessions({ sql: fixture.sql, env, connections });
      if (!configured) throw new Error('Expected configured browser sessions');
      try {
        expect(configured.pool.options.endpoints).toEqual([
          { spaceId: space.id, url: 'http://browser:3132', token: 'x'.repeat(64) },
        ]);
        const registry = await configuredConnectors({
          sql: fixture.sql,
          connections,
          spacesRoot: root,
          workRoot: root,
          browserSessions: configured.sessions,
        });
        expect(registry.get(first.connection_id)?.manifest.name).toBe('browser');
        expect(registry.get(web?.id ?? '')?.manifest.name).toBe('web');
      } finally {
        await configured.pool.close();
      }
    } finally {
      await running.close();
    }
  },
  60_000,
);
