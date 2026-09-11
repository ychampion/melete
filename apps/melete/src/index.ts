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

import type { AttemptBundle, RuntimeAdapter } from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
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
import { verifyCapability } from './broker/capability.ts';
import { startEffectBoundary } from './broker/start.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { connection } from './db/schema.ts';
import { type Env, loadEnv } from './env.ts';
import { EventStream } from './events/stream.ts';
import type { GatewayOptions } from './gateway/index.ts';
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
import { withMemoryRuntime } from './memory/context.ts';
import { createDisputeSettler } from './memory/disputes.ts';
import { createMemoryRouter, type MemoryRouteOptions } from './memory/routes.ts';
import { startServiceMemory } from './memory/start.ts';
import { type AttemptTiming, SupervisedHermesRuntime } from './runtime/hermes.ts';
import { StubRuntimeAdapter } from './runtime/stub.ts';
import {
  DockerRuntimeSupervisor,
  ProcessRuntimeSupervisor,
  type RuntimeSupervisor,
} from './runtime/supervisor.ts';

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
  runtimeAdapter?: string;
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
  if (deps.memory) app.route('/', createMemoryRouter(deps.memory));

  app.get('/health', async (c) => {
    const database = await deps.checkDatabase();
    return c.json({
      status: database === 'unreachable' ? 'degraded' : 'ok',
      version: VERSION,
      database,
      runtime_adapter: deps.runtimeAdapter,
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
export async function bootstrap(
  options: {
    env?: Env;
    runtime?: RuntimeAdapter;
    workers?: boolean;
    /** Observers exercise the real entry point without replacing the runtime. */
    onBundle?: (bundle: AttemptBundle) => void;
    onTiming?: (timing: AttemptTiming) => void;
    fakeProvider?: GatewayOptions['fake'];
  } = {},
) {
  const env = options.env ?? loadEnv();
  if (!options.runtime && !['hermes', 'stub'].includes(env.MELETE_RUNTIME_ADAPTER)) {
    throw new Error('MELETE_RUNTIME_ADAPTER must be hermes or stub.');
  }
  if (!['process', 'docker'].includes(env.MELETE_RUNTIME_SUPERVISOR))
    throw new Error('MELETE_RUNTIME_SUPERVISOR must be process or docker.');
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
  let memory: Awaited<ReturnType<typeof startServiceMemory>> | undefined;
  let boundary: Awaited<ReturnType<typeof startEffectBoundary>> | undefined;
  let supervisor: RuntimeSupervisor | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      const settle = async (tasks: (Promise<unknown> | undefined)[]) => {
        for (const result of await Promise.allSettled(tasks))
          if (result.status === 'rejected') failures.push(result.reason);
      };
      // Every owned dependency gets its shutdown even when a sibling fails.
      // Runtimes must stop while their broker and database still exist.
      await settle([triggers?.stop(), runner?.stop(), operations?.stop()]);
      await settle([supervisor?.close()]);
      await settle([memory?.stop(), boundary?.close(), events?.close()]);
      await settle([queue?.stop()]);
      await settle([handle?.close()]);
      if (failures.length) throw new AggregateError(failures, 'Service shutdown failed');
    })());
  try {
    if (handle) await migrateDatabase(handle);
    if (handle) {
      events = new EventStream(handle);
      await events.start();
    }
    if (env.DATABASE_URL) queue = await startQueue(env.DATABASE_URL);
    jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;
    if (jobs && handle && queue) {
      const activeJobs = jobs;
      submissions = new SubmissionService(jobs);
      if (!env.MELETE_CAPABILITY_KEY)
        throw new Error('MELETE_CAPABILITY_KEY is required to issue attempt capabilities.');
      const capabilityKey = env.MELETE_CAPABILITY_KEY;
      memory = await startServiceMemory(
        handle.sql,
        queue.boss,
        env.MELETE_SPACES_DIR,
        options.workers === false
          ? undefined
          : async (jobId) => {
              await activeJobs.transaction(async (tx) => {
                const row = await activeJobs.lock(tx, jobId);
                if (row?.state === 'queued' && row.nextWakeAt)
                  await activeJobs.enqueue(tx, row, 'recovery');
              });
            },
      );
      if (env.MELETE_RUNTIME_ADAPTER === 'hermes' && !options.runtime) {
        boundary = await startEffectBoundary(handle, env, { fakeProvider: options.fakeProvider });
        const Supervisor =
          env.MELETE_RUNTIME_SUPERVISOR === 'docker'
            ? DockerRuntimeSupervisor
            : ProcessRuntimeSupervisor;
        supervisor = new Supervisor({
          workRoot: env.MELETE_WORK_DIR,
          brokerUrl: env.MELETE_BROKER_URL,
          engineRoot: env.MELETE_HERMES_ROOT,
          python: env.MELETE_HERMES_PYTHON,
          runtimePackage: env.MELETE_RUNTIME_PACKAGE,
          dockerImage: env.MELETE_RUNTIME_IMAGE,
          dockerNetwork: env.MELETE_RUNTIME_NETWORK,
          dockerWorkVolume: env.MELETE_RUNTIME_WORK_VOLUME,
        });
      }
      const runtime =
        options.runtime ??
        (supervisor
          ? new SupervisedHermesRuntime(supervisor, handle.sql, options.onTiming)
          : new StubRuntimeAdapter());
      const observed: RuntimeAdapter = {
        capabilities: () => runtime.capabilities(),
        start: (bundle, sink, signal) => {
          options.onBundle?.(structuredClone(bundle));
          return runtime.start(bundle, sink, signal);
        },
      };
      runner = new AttemptRunner(
        jobs,
        withMemoryRuntime(observed, handle.sql, memory.scopeForJob, {
          catalog: async (bundle) =>
            boundary
              ? boundary.broker.catalog(verifyCapability(bundle.attempt.token, capabilityKey))
              : [],
        }),
        {
          key: env.MELETE_CAPABILITY_KEY,
          provider: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'stub' : env.MELETE_DEFAULT_PROVIDER,
          model: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'script' : env.MELETE_DEFAULT_MODEL,
          scopesForJob: async (tx, row) => {
            const granted = await tx
              .select({ scopes: connection.scopes })
              .from(connection)
              .where(and(eq(connection.spaceId, row.spaceId), eq(connection.status, 'active')));
            return [...new Set(granted.flatMap((entry) => entry.scopes))].sort();
          },
        },
      );
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
    memory,
    runtimeAdapter: options.runtime ? 'injected' : env.MELETE_RUNTIME_ADAPTER,
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
    memory,
    boundary,
    supervisor,
    close,
  };
}

if (import.meta.main) {
  const service = await bootstrap();
  const { app, env, boundary } = service;
  process.stdout.write(`melete ${VERSION} listening on :${env.PORT}\n`);
  const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 });
  if (boundary) process.stdout.write(`effect boundary listening on ${env.MELETE_BROKER_BIND}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
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
