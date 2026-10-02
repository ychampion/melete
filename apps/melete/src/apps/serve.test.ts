/**
 * Every route the service serves under the app view path answers with the
 * isolation policy, whatever it answers: a file, a refusal, or an error the
 * route never meant to raise.
 */
import { expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { type AppDeps, createApp } from '../index.ts';
import { isIsolated, VIEW_PREFIX } from '../viewer/headers.ts';

test('every response under the app view path carries the isolation policy', async () => {
  // Every dependency is a stub whose calls answer nothing, so a route that
  // reaches the database fails there: that failure has to leave isolated too.
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const deps: AppDeps = {
    env: loadEnv({}),
    checkDatabase: async () => 'ok',
    db: stub,
    sql: stub,
    registry: stub,
    jobs: stub,
    blobs: stub,
  };
  const app = createApp(deps);
  const routes = app.routes.filter(
    (route) => route.method !== 'ALL' && route.path.startsWith(VIEW_PREFIX),
  );
  // The session is skipped for every read under this path, so the one route
  // there must be the one that checks its own token.
  expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
    `GET ${VIEW_PREFIX}:token/:path{.+}`,
  ]);
  const paths = ['x/index.html', 'x.y/app.js', 'a/b/c.css', 'x/%2e%2e/y', 'only'];
  for (const route of routes)
    for (const path of paths)
      for (const destination of ['iframe', 'document', null]) {
        const response = await app.request(`${VIEW_PREFIX}${path}`, {
          method: route.method,
          headers: destination ? { 'sec-fetch-dest': destination } : {},
        });
        expect(response.ok).toBe(false);
        expect(isIsolated(response.headers), `${route.method} ${path} ${destination}`).toBe(true);
        expect(response.headers.has('set-cookie')).toBe(false);
      }
});
