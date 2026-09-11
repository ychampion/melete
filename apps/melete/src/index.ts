/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * The public API currently serves /health; the effect listener serves broker,
 * API action reads, and model traffic on its own internal port.
 */
import { Hono } from 'hono';
import { startEffectBoundary } from './broker/start.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { type Env, loadEnv } from './env.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  checkDatabase: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', async (c) => {
    const database = await deps.checkDatabase();
    return c.json({
      status: database === 'unreachable' ? 'degraded' : 'ok',
      version: VERSION,
      database,
      time: new Date().toISOString(),
    });
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'This endpoint is not implemented yet. See packages/contracts/openapi.json.',
        },
      },
      404,
    ),
  );

  return app;
}

/** Wire the real dependencies. Called only when this file is the entry point. */
export function bootstrap() {
  const env = loadEnv();
  const handle = env.DATABASE_URL ? openDatabase(env.DATABASE_URL) : null;

  const app = createApp({
    env,
    db: handle?.db ?? null,
    checkDatabase: async () => {
      if (!handle) return 'not_configured';
      return (await pingDatabase(handle)) ? 'ok' : 'unreachable';
    },
  });

  return { app, env, handle };
}

if (import.meta.main) {
  const { app, env, handle } = bootstrap();
  const boundary = handle ? await startEffectBoundary(handle, env) : null;
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  const api = Bun.serve({ port: env.PORT, fetch: app.fetch });
  if (boundary) process.stdout.write(`effect boundary listening on ${env.MELETE_BROKER_BIND}\n`);
  const stop = async () => {
    api.stop(true);
    await boundary?.close();
    await handle?.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
