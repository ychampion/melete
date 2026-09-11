/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * Modules register their API surfaces against injected durable dependencies.
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { mountAuth } from './api/auth.ts';
import { ServiceError } from './api/errors.ts';
import { mountJobs } from './api/jobs.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { type Env, loadEnv } from './env.ts';
import { startQueue } from './jobs/queue.ts';
import { JobService } from './jobs/service.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  jobs?: JobService;
  checkDatabase: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ServiceError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json(
        { error: { code: 'invalid_request', message: 'Request data is invalid.' } },
        400,
      );
    process.stderr.write(`request failed: ${error.message}\n`);
    return c.json(
      { error: { code: 'internal_error', message: 'The request could not be completed.' } },
      500,
    );
  });
  mountAuth(app, deps);
  if (deps.jobs) mountJobs(app, deps.jobs);

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
export async function bootstrap() {
  const env = loadEnv();
  const handle = env.DATABASE_URL ? openDatabase(env.DATABASE_URL) : null;
  if (handle) await migrateDatabase(handle);
  const queue = env.DATABASE_URL ? await startQueue(env.DATABASE_URL) : null;
  const jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;

  const app = createApp({
    env,
    db: handle?.db ?? null,
    jobs,
    checkDatabase: async () => {
      if (!handle) return 'not_configured';
      return (await pingDatabase(handle)) ? 'ok' : 'unreachable';
    },
  });

  return {
    app,
    env,
    handle,
    jobs,
    queue,
    close: async () => {
      await queue?.stop();
      await handle?.close();
    },
  };
}

if (import.meta.main) {
  const { app, env } = await bootstrap();
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  Bun.serve({ port: env.PORT, fetch: app.fetch });
}
