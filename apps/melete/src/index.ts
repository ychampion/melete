/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * Modules register their API surfaces against injected durable dependencies.
 * The public API serves /health, the job and account surfaces, and the
 * knowledge surface; the effect listener serves broker, API action reads, and
 * model traffic on its own internal port. The remaining modules are
 * directories with a README describing the contract they will implement.
 */

import { basename, dirname } from 'node:path';
import type { RuntimeAdapter } from '@melete/contracts';
import { spacePaths } from '@melete/knowledge';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { mountApprovals } from './api/approvals.ts';
import { mountAttention } from './api/attention.ts';
import { mountAuth } from './api/auth.ts';
import { ServiceError } from './api/errors.ts';
import { mountEvents } from './api/events.ts';
import { mountJobs } from './api/jobs.ts';
import { mountOperations } from './api/operations.ts';
import { mountPolicy } from './api/policy.ts';
import { mountQuestions } from './api/questions.ts';
import { mountReplies } from './api/replies.ts';
import { mountTriggers } from './api/triggers.ts';
import { startEffectBoundary } from './broker/start.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { space } from './db/schema.ts';
import { type Env, loadEnv } from './env.ts';
import { EventStream } from './events/stream.ts';
import { ApprovalService } from './jobs/approvals.ts';
import { AttentionService } from './jobs/attention.ts';
import { OperationService } from './jobs/operations.ts';
import { PolicyService } from './jobs/policy.ts';
import { QuestionService } from './jobs/questions.ts';
import { startQueue } from './jobs/queue.ts';
import { ReplyService } from './jobs/replies.ts';
import { AttemptRunner } from './jobs/runner.ts';
import { JobService } from './jobs/service.ts';
import { SubmissionService } from './jobs/submissions.ts';
import { TriggerService } from './jobs/triggers.ts';
import { type KnowledgeDeps, knowledgeRoutes } from './knowledge/routes.ts';
import { filesystemSpaces } from './knowledge/spaces.ts';
import { memoryScopeForSpace } from './memory/broker-trust.ts';
import { createDisputeSettler } from './memory/disputes.ts';
import { createMemoryRouter, type MemoryRouteOptions } from './memory/routes.ts';
import { requestPrincipal, spaceAuthority } from './principals/authority.ts';
import { mountPrincipals } from './principals/routes.ts';
import { StubRuntimeAdapter } from './runtime/stub.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  jobs?: JobService;
  triggers?: TriggerService;
  approvals?: ApprovalService;
  events?: EventStream;
  submissions?: SubmissionService;
  replies?: ReplyService;
  operations?: OperationService;
  policy?: PolicyService;
  attention?: AttentionService;
  questions?: QuestionService;
  checkDatabase: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
  /** Left out, the spaces on the volume are used, which is what a deployment wants. */
  knowledge?: KnowledgeDeps;
  memory?: MemoryRouteOptions;
};

export function createApp(deps: AppDeps) {
  const db = deps.db;
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
  mountPrincipals(app, deps.db, deps.env.MELETE_SPACES_DIR, deps.jobs);
  const submissions =
    deps.submissions ?? (deps.jobs ? new SubmissionService(deps.jobs) : undefined);
  const replies =
    deps.replies ??
    (deps.jobs && submissions ? new ReplyService(deps.jobs, submissions) : undefined);
  if (deps.jobs) mountJobs(app, deps.jobs, submissions);
  if (replies) mountReplies(app, replies);
  if (deps.jobs) mountOperations(app, deps.operations ?? new OperationService(deps.jobs));
  if (deps.jobs) mountPolicy(app, deps.policy ?? new PolicyService(deps.jobs));
  if (deps.jobs) mountAttention(app, deps.attention ?? new AttentionService(deps.jobs));
  if (deps.jobs) mountQuestions(app, deps.questions ?? new QuestionService(deps.jobs, submissions));
  if (deps.triggers) mountTriggers(app, deps.triggers);
  if (deps.approvals) mountApprovals(app, deps.approvals);
  if (deps.events && deps.jobs) mountEvents(app, deps.events, deps.jobs);
  if (deps.memory)
    app.route(
      '/',
      createMemoryRouter({
        ...deps.memory,
        resolveScope: async (request) => {
          const scope = await deps.memory?.resolveScope?.(request);
          const actor = requestPrincipal();
          if (!scope || !actor || !deps.db) return null;
          const access = await spaceAuthority(deps.db, scope.spaceId, actor);
          return {
            ...scope,
            principalId: actor,
            membershipGeneration: access.generation,
            role: access.role === 'owner' ? 'owner' : 'reader',
            audience: access.role === 'owner' ? scope.audience : 'space',
          };
        },
      }),
    );

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
    knowledgeRoutes({
      ...(deps.knowledge ?? { spaces: filesystemSpaces(deps.env.MELETE_SPACES_DIR) }),
      ...(db
        ? {
            spaces: {
              ...(deps.knowledge?.spaces ?? filesystemSpaces(deps.env.MELETE_SPACES_DIR)),
              byId: async (id: string) => {
                const [row] = await db.select().from(space).where(eq(space.id, id));
                if (!row) return null;
                return {
                  id: row.id,
                  name: basename(row.gitPath),
                  paths: spacePaths(dirname(row.gitPath), basename(row.gitPath)),
                };
              },
            },
            authorizeSpace: async (id: string) => ({
              owner: (await spaceAuthority(db, id, requestPrincipal())).role === 'owner',
            }),
          }
        : {}),
    }),
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
  let events: EventStream | undefined;
  let submissions: SubmissionService | undefined;
  let replies: ReplyService | undefined;
  let operations: OperationService | undefined;
  let policy: PolicyService | undefined;
  let attention: AttentionService | undefined;
  let questions: QuestionService | undefined;
  const close = async () => {
    try {
      await Promise.all([events?.close(), triggers?.stop(), runner?.stop(), operations?.stop()]);
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
    if (handle) {
      events = new EventStream(handle);
      await events.start();
    }
    if (env.DATABASE_URL) queue = await startQueue(env.DATABASE_URL);
    jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;
    if (jobs) {
      submissions = new SubmissionService(jobs);
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
      if (submissions) replies = new ReplyService(jobs, submissions, runner);
      operations = new OperationService(jobs, runner);
      policy = new PolicyService(jobs, runner);
      attention = new AttentionService(jobs, runner);
      // A memory question is answered by settling the key it disputes, which
      // only memory can do, so the queue is handed that one capability.
      questions = new QuestionService(
        jobs,
        submissions,
        handle
          ? createDisputeSettler(async (spaceId) => {
              const scope = await memoryScopeForSpace(handle.sql, spaceId);
              if (!scope) throw new Error('scope_denied');
              return scope;
            }, handle.sql)
          : undefined,
      );
      if (options.workers !== false) {
        await operations.start();
        await triggers.start();
        await runner.start();
      }
      if (options.workers === false) await replies?.recover();
      if (options.workers === false) await operations.recover();
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
    events,
    submissions,
    replies,
    operations,
    policy,
    attention,
    questions,
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
    events,
    submissions,
    replies,
    operations,
    policy,
    attention,
    questions,
    close,
  };
}

if (import.meta.main) {
  const service = await bootstrap();
  const { app, env, handle } = service;
  const boundary = handle ? await startEffectBoundary(handle, env) : null;
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 });
  if (boundary) process.stdout.write(`effect boundary listening on ${env.MELETE_BROKER_BIND}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await boundary?.close();
    // service.close() closes the database handle, so it is not closed again here.
    await service.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
}
