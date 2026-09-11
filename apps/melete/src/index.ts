/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * Health and the knowledge surface are implemented; the other modules are
 * directories with a README describing the contract they will implement.
 */
import { Hono } from 'hono';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { type Env, loadEnv } from './env.ts';
import { type KnowledgeDeps, knowledgeRoutes } from './knowledge/routes.ts';
import { filesystemSpaces } from './knowledge/spaces.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  checkDatabase: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
  /** Left out, the spaces on the volume are used, which is what a deployment wants. */
  knowledge?: KnowledgeDeps;
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

  app.route(
    '/',
    knowledgeRoutes(deps.knowledge ?? { spaces: filesystemSpaces(deps.env.MELETE_SPACES_DIR) }),
  );

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
  const { app, env } = bootstrap();
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  Bun.serve({ port: env.PORT, fetch: app.fetch });
}
