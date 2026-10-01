import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { loadEnv } from '../env.ts';
import { mountMcpServer } from './routes.ts';

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
