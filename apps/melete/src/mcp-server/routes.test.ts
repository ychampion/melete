import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { loadEnv } from '../env.ts';
import { consentKey, mountMcpServer } from './routes.ts';

test('with no public address, the list of connected assistants is empty rather than missing', async () => {
  const app = new Hono();
  mountMcpServer(app, {
    db: {} as never,
    sql: {} as never,
    env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: 'spaces' }),
  });
  const response = await app.request('/mcp/clients');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ clients: [] });
  // Nothing else of the authorization server is offered.
  expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(404);
});

test('every instance holding the master key signs consent forms with the same key', () => {
  const master = 'a'.repeat(64);
  // Two instances, or one before and after a restart, derive one key.
  expect(consentKey(master).equals(consentKey(master))).toBe(true);
  expect(consentKey(master)).toHaveLength(32);
  // It is not the master key, and another installation's key differs.
  expect(consentKey(master).toString('hex')).not.toBe(master);
  expect(consentKey(master).equals(consentKey('b'.repeat(64)))).toBe(false);
  // Without a master key it lasts as long as the process.
  expect(consentKey(undefined).equals(consentKey(undefined))).toBe(false);
});
