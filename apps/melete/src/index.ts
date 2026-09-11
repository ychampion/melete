/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * Modules register their API surfaces against injected durable dependencies.
 */

import type { RuntimeAdapter } from '@melete/contracts';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { mountApprovals } from './api/approvals.ts';
import { mountAuth } from './api/auth.ts';
import { ServiceError } from './api/errors.ts';
import { mountJobs } from './api/jobs.ts';
import { mountTriggers } from './api/triggers.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { type Env, loadEnv } from './env.ts';
import { ApprovalService } from './jobs/approvals.ts';
import { startQueue } from './jobs/queue.ts';
import { AttemptRunner } from './jobs/runner.ts';
import { JobService } from './jobs/service.ts';
import { TriggerService } from './jobs/triggers.ts';
import { StubRuntimeAdapter } from './runtime/stub.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  jobs?: JobService;
  triggers?: TriggerService;
  approvals?: ApprovalService;
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
  if (deps.triggers) mountTriggers(app, deps.triggers);
  if (deps.approvals) mountApprovals(app, deps.approvals);

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
export async function bootstrap(
  options: { env?: Env; runtime?: RuntimeAdapter; workers?: boolean } = {},
) {
  const env = options.env ?? loadEnv();
  const handle = env.DATABASE_URL ? openDatabase(env.DATABASE_URL) : null;
  let queue: Awaited<ReturnType<typeof startQueue>> | null = null;
  let jobs: JobService | undefined;
  let runner: AttemptRunner | undefined;
  let triggers: TriggerService | undefined;
  let approvals: ApprovalService | undefined;
  const close = async () => {
    try {
      await triggers?.stop();
      await runner?.stop();
    } finally {
      try {
        await queue?.stop();
      } finally {
        await handle?.close();
      }
    }
  };
  try {
    if (handle) await migrateDatabase(handle);
    if (env.DATABASE_URL) queue = await startQueue(env.DATABASE_URL);
    jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;
    if (jobs) {
      const runtime =
        options.runtime ??
        (env.MELETE_RUNTIME_ADAPTER === 'stub' ? new StubRuntimeAdapter() : undefined);
      if (!runtime || !env.MELETE_CAPABILITY_KEY)
        throw new Error(
          'Configure MELETE_CAPABILITY_KEY and provide a RuntimeAdapter (or MELETE_RUNTIME_ADAPTER=stub for scripted local runs).',
        );
      runner = new AttemptRunner(jobs, runtime, {
        key: env.MELETE_CAPABILITY_KEY,
        provider: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'stub' : env.MELETE_DEFAULT_PROVIDER,
        model: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'script' : env.MELETE_DEFAULT_MODEL,
      });
      triggers = new TriggerService(jobs, runner);
      approvals = new ApprovalService(jobs, runner);
      if (options.workers !== false) {
        await triggers.start();
        await runner.start();
      }
    }
  } catch (error) {
    await close();
    throw error;
  }

  const app = createApp({
    env,
    db: handle?.db ?? null,
    jobs,
    triggers,
    approvals,
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
    runner,
    triggers,
    approvals,
    close,
  };
}

if (import.meta.main) {
  const service = await bootstrap();
  const { app, env } = service;
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await service.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
