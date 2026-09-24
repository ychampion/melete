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
import { brokerCatalogState } from '@melete/runtime-hermes';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ZodError } from 'zod';
import { mountApprovals } from './api/approvals.ts';
import { mountArtifacts } from './api/artifacts.ts';
import { mountAttention } from './api/attention.ts';
import { mountAuth } from './api/auth.ts';
import { mountConnections, mountDefaultConnections } from './api/connections.ts';
import { ServiceError } from './api/errors.ts';
import { mountEvents } from './api/events.ts';
import { mountJobs } from './api/jobs.ts';
import { apiFetch, resolveApiNetwork, trustedProxy } from './api/listener.ts';
import type { LoginThrottle } from './api/login-throttle.ts';
import { mountOperations } from './api/operations.ts';
import { mountPolicy } from './api/policy.ts';
import { mountProviderSignIn } from './api/provider-signin.ts';
import { mountQuestions } from './api/questions.ts';
import { mountReactions, type SpaceResolver } from './api/reactions.ts';
import { mountRepairs, RepairReadService } from './api/repairs.ts';
import { mountReplies } from './api/replies.ts';
import { mountTriggers } from './api/triggers.ts';
import { verifyCapability } from './broker/capability.ts';
import { pendingRuntimeWait } from './broker/runtime-wait.ts';
import type { BrokerService } from './broker/service.ts';
import { startEffectBoundary } from './broker/start.ts';
import { CompanyReplyPoller, connectorReplyMailbox } from './companies/replies.ts';
import { closeInterruptedScans } from './companies/repository.ts';
import { type CompaniesDeps, mountCompanies } from './companies/routes.ts';
import { companiesDeps } from './companies/service.ts';
import { builtinEnvironment, ensureBuiltinConnections } from './connectors/builtin.ts';
import {
  type ConfiguredConnection,
  configuredBrowserSessions,
  connectorsFromEnv,
  readConnectionConfig,
} from './connectors/configured.ts';
import { DockerStdioLauncher } from './connectors/mcp-stdio-docker.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { connection } from './db/schema.ts';
import { type Env, loadEnv, parseBrokerBind } from './env.ts';
import { EventStream } from './events/stream.ts';
import { mountExperience } from './experience/routes.ts';
import { providerSignIn } from './gateway/configured.ts';
import type { ProviderSignIn } from './gateway/credentials.ts';
import type { GatewayOptions } from './gateway/index.ts';
import { ApprovalService } from './jobs/approvals.ts';
import { AttentionService } from './jobs/attention.ts';
import { OperationService } from './jobs/operations.ts';
import { PolicyService } from './jobs/policy.ts';
import { QuestionService } from './jobs/questions.ts';
import { startQueue } from './jobs/queue.ts';
import { ReactionService } from './jobs/reactions.ts';
import { ReplyService } from './jobs/replies.ts';
import { AttemptRunner } from './jobs/runner.ts';
import { JobService } from './jobs/service.ts';
import { SubmissionService } from './jobs/submissions.ts';
import { TriggerService } from './jobs/triggers.ts';
import { RuntimeCatalog } from './knowledge/catalog.ts';
import { type KnowledgeDeps, knowledgeRoutes } from './knowledge/routes.ts';
import { databaseSpaces, filesystemSpaces } from './knowledge/spaces.ts';
import { attachConversationCorrections } from './learning/conversation.ts';
import { EpisodeService } from './learning/episodes.ts';
import { ProcedureEvaluator } from './learning/evaluator.ts';
import { LearnedService } from './learning/learned.ts';
import { mountLearned } from './learning/learned-routes.ts';
import { mountProcedures } from './learning/procedure-routes.ts';
import { ProcedureService } from './learning/procedures.ts';
import { mountProposals } from './learning/proposal-routes.ts';
import type { ProcedureProposer } from './learning/proposer.ts';
import { expireEpisodes } from './learning/retention.ts';
import { mountLearning } from './learning/routes.ts';
import { startLearning } from './learning/start.ts';
import { startDeploymentMemory } from './memory/bootstrap.ts';
import { memoryScopeForSpace } from './memory/broker-trust.ts';
import { withMemoryRuntime } from './memory/context.ts';
import { createDisputeSettler } from './memory/disputes.ts';
import { createMemoryRouter, type MemoryRouteOptions } from './memory/routes.ts';
import { startServiceMemory } from './memory/start.ts';
import {
  refusedForRemoval,
  requestPrincipal,
  SPACE_BEING_CLEARED,
  spaceAuthority,
} from './principals/authority.ts';
import { mountPrincipals } from './principals/routes.ts';
import { withDeploymentContext } from './runtime/context.ts';
import { DockerHermesRuntimeAdapter, DockerSocketApi } from './runtime/docker.ts';
import { assertDockerEngine } from './runtime/docker-engine.ts';
import { type AttemptTiming, SupervisedHermesRuntime } from './runtime/hermes.ts';
import { StubRuntimeAdapter } from './runtime/stub.ts';
import {
  DockerRuntimeSupervisor,
  ProcessRuntimeSupervisor,
  type RuntimeSupervisor,
} from './runtime/supervisor.ts';
import { SpaceRemovalService } from './spaces/removal.ts';
import { mountSpaceRemoval } from './spaces/routes.ts';
import { mountBrowserLive } from './workers/browser/live-service.ts';
import { type BrowserSessionService, mountBrowserSessions } from './workers/browser/routes.ts';
import { mountBrowserSites } from './workers/browser/sites.ts';

export const VERSION = '0.1.0-pre';

export type AppDeps = {
  env: Env;
  db: Database | null;
  loginThrottle?: LoginThrottle;
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
  repairs?: RepairReadService;
  reactions?: ReactionService;
  /**
   * Which space a request speaks for. Left out, it is the space the session
   * resolved for its authenticated principal. Supplied, it is whatever the
   * trusted session resolver says; request headers never supply this authority.
   */
  resolveSpace?: SpaceResolver;
  episodes?: EpisodeService;
  proposer?: ProcedureProposer;
  evaluator?: ProcedureEvaluator;
  checkDatabase: () => Promise<'ok' | 'unreachable' | 'not_configured'>;
  /** Left out, the authenticated owner's database catalog resolves volume spaces. */
  knowledge?: KnowledgeDeps;
  memory?: MemoryRouteOptions;
  browserSessions?: BrowserSessionService;
  removals?: SpaceRemovalService;
  runtimeAdapter?: string;
  runner?: AttemptRunner;
  broker?: BrokerService;
  registry?: ConnectorRegistry;
  sql?: Sql;
  /** Overrides for the company map: a test's store, extractor or handler. */
  companies?: Partial<CompaniesDeps>;
  /** The owner's model-provider sign-ins. Left out, built from `sql` and the master key. */
  providerSignIn?: ProviderSignIn;
};

export function createApp(deps: AppDeps) {
  const db = deps.db;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ServiceError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (refusedForRemoval(error))
      return c.json({ error: { code: 'scope_denied', message: SPACE_BEING_CLEARED } }, 403);
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
  const connections =
    deps.db && deps.sql && deps.registry
      ? { db: deps.db, sql: deps.sql, registry: deps.registry, env: deps.env }
      : undefined;
  // Mounted before the routes it follows, so it runs once they have answered;
  // see mountDefaultConnections.
  if (connections) mountDefaultConnections(app, connections);
  mountAuth(app, deps);
  // The authenticated session names the space and the principal; a request header never does.
  const personalSpace: SpaceResolver =
    deps.resolveSpace ??
    (async (c) => {
      const spaceId = c.get('experienceSpaceId');
      return spaceId ? { spaceId, principalId: c.get('owner')?.id } : null;
    });
  if (deps.db) mountArtifacts(app, deps.db, deps.env.MELETE_SPACES_DIR, personalSpace);
  mountPrincipals(app, deps.db, deps.env.MELETE_SPACES_DIR, deps.jobs);
  // After mountPrincipals, so the owner-only guard it installs on every
  // non-GET under /spaces/:id runs before the handler that removes one.
  if (deps.removals && deps.db && deps.sql)
    mountSpaceRemoval(app, { db: deps.db, sql: deps.sql, removals: deps.removals });
  if (connections) mountConnections(app, connections);
  if (deps.db)
    mountProviderSignIn(app, {
      db: deps.db,
      signIn: deps.providerSignIn ?? (deps.sql ? providerSignIn(deps.sql, deps.env) : undefined),
    });
  const submissions =
    deps.submissions ?? (deps.jobs ? new SubmissionService(deps.jobs) : undefined);
  const replies =
    deps.replies ??
    (deps.jobs && submissions ? new ReplyService(deps.jobs, submissions) : undefined);
  if (deps.jobs) mountJobs(app, deps.jobs, submissions);
  if (deps.jobs) {
    const episodes = deps.episodes ?? new EpisodeService(deps.jobs);
    const procedures = new ProcedureService(deps.jobs);
    mountLearning(app, episodes);
    if (deps.proposer) mountProposals(app, deps.proposer);
    mountProcedures(app, procedures, deps.evaluator);
    mountLearned(app, new LearnedService(deps.jobs, procedures, episodes));
  } else if (deps.proposer) mountProposals(app, deps.proposer);
  if (replies) mountReplies(app, replies);
  if (deps.jobs) mountOperations(app, deps.operations ?? new OperationService(deps.jobs));
  if (deps.jobs) mountPolicy(app, deps.policy ?? new PolicyService(deps.jobs), deps.registry);
  const attention = deps.attention ?? (deps.jobs ? new AttentionService(deps.jobs) : undefined);
  if (deps.jobs && attention) mountAttention(app, attention);
  if (deps.jobs) {
    mountReactions(app, deps.reactions ?? new ReactionService(deps.jobs, attention), personalSpace);
  }
  const questions =
    deps.questions ?? (deps.jobs ? new QuestionService(deps.jobs, submissions) : undefined);
  if (questions) mountQuestions(app, questions);
  if (deps.db) mountRepairs(app, deps.repairs ?? new RepairReadService(deps.db));
  if (deps.triggers) mountTriggers(app, deps.triggers);
  if (deps.approvals) mountApprovals(app, deps.approvals);
  if (deps.db)
    mountExperience(app, {
      db: deps.db,
      jobs: deps.jobs,
      submissions,
      runner: deps.runner,
      sql: deps.sql,
      broker: deps.broker,
      registry: deps.registry,
      questions,
      memoryJournal: deps.memory?.journal,
      triggers: deps.triggers,
    });
  if (deps.db)
    mountCompanies(app, {
      ...companiesDeps({
        db: deps.db,
        sql: deps.sql,
        registry: deps.registry,
        env: deps.env,
        jobs: deps.jobs,
        triggers: deps.triggers,
      }),
      ...deps.companies,
    });
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
  if (deps.browserSessions) mountBrowserSessions(app, deps.browserSessions);
  if (deps.browserSessions) mountBrowserLive(app, deps.browserSessions);
  if (deps.browserSessions) mountBrowserSites(app, deps.browserSessions.sites);

  app.get('/health', async (c) => {
    const database = await deps.checkDatabase();
    return c.json({
      status: database === 'unreachable' ? 'degraded' : 'ok',
      version: VERSION,
      database,
      runtime_adapter: deps.runtimeAdapter,
      runtime_supervisor:
        deps.runtimeAdapter === 'hermes' ? deps.env.MELETE_RUNTIME_SUPERVISOR : null,
      time: new Date().toISOString(),
    });
  });

  app.route(
    '/',
    knowledgeRoutes({
      ...(deps.knowledge ?? {
        spaces: deps.db
          ? databaseSpaces(deps.db, deps.env.MELETE_SPACES_DIR)
          : filesystemSpaces(deps.env.MELETE_SPACES_DIR),
      }),
      ...(db
        ? {
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
  options: {
    env?: Env;
    runtime?: RuntimeAdapter;
    workers?: boolean;
    effects?: boolean;
    /** Observers exercise the real entry point without replacing the runtime. */
    onBundle?: (bundle: AttemptBundle) => void;
    onTiming?: (timing: AttemptTiming) => void;
    fakeProvider?: GatewayOptions['fake'];
  } = {},
) {
  const env = options.env ?? loadEnv();
  // Compose selects the supervised Docker adapter before any dependencies start.
  if (!options.runtime && !['hermes', 'docker', 'stub'].includes(env.MELETE_RUNTIME_ADAPTER)) {
    throw new Error('MELETE_RUNTIME_ADAPTER must be hermes, docker or stub.');
  }
  if (!['process', 'docker'].includes(env.MELETE_RUNTIME_SUPERVISOR))
    throw new Error('MELETE_RUNTIME_SUPERVISOR must be process or docker.');
  if (
    !options.runtime &&
    env.MELETE_RUNTIME_ADAPTER === 'hermes' &&
    env.MELETE_RUNTIME_SUPERVISOR === 'process'
  )
    process.stderr.write(
      "WARNING: Hermes process attempts are not sandboxed and run with the service user's OS access. Use the Docker supervisor for container isolation.\n",
    );
  // An engine the supervisor cannot drive is named here, before the database is
  // opened or migrated, instead of as a Docker 400 on the first attempt.
  if (!options.runtime && env.MELETE_RUNTIME_ADAPTER === 'docker')
    await assertDockerEngine(
      new DockerSocketApi(env.MELETE_DOCKER_SOCKET),
      env.MELETE_DOCKER_SOCKET,
    );
  const handle = env.DATABASE_URL ? openDatabase(env.DATABASE_URL) : null;
  let queue: Awaited<ReturnType<typeof startQueue>> | null = null;
  let jobs: JobService | undefined;
  let runner: AttemptRunner | undefined;
  let triggers: TriggerService | undefined;
  let approvals: ApprovalService | undefined;
  let events: EventStream | undefined;
  let submissions: SubmissionService | undefined;
  let episodes: EpisodeService | undefined;
  let replies: ReplyService | undefined;
  let operations: OperationService | undefined;
  let policy: PolicyService | undefined;
  let attention: AttentionService | undefined;
  let questions: QuestionService | undefined;
  let catalog: RuntimeCatalog | undefined;
  let supervisedRuntime: DockerHermesRuntimeAdapter | undefined;
  let deploymentMemory: Awaited<ReturnType<typeof startDeploymentMemory>> | undefined;
  let effectBoundary: Awaited<ReturnType<typeof startEffectBoundary>> | undefined;
  let browser: Awaited<ReturnType<typeof configuredBrowserSessions>>;
  let connections: ConfiguredConnection[] = [];
  let episodeRetention: ReturnType<typeof setInterval> | undefined;
  let learning: Awaited<ReturnType<typeof startLearning>> | undefined;
  let evaluator: ProcedureEvaluator | undefined;
  let memory: Awaited<ReturnType<typeof startServiceMemory>> | undefined;
  let removals: SpaceRemovalService | undefined;
  let supervisor: RuntimeSupervisor | undefined;
  let registry: ConnectorRegistry | undefined;
  let stdioLauncher: DockerStdioLauncher | undefined;
  let companyReplies: CompanyReplyPoller | undefined;
  let signIn: ProviderSignIn | undefined;
  const close = async () => {
    // A wake can still be waiting for capabilities before the runner records
    // it as active. Interrupt that wait before runner.stop drains its wakes.
    supervisedRuntime?.beginShutdown();
    clearInterval(episodeRetention);
    let failure: unknown;
    for (const stop of [
      () =>
        Promise.all([
          learning?.close(),
          events?.close(),
          companyReplies?.stop(),
          triggers?.stop(),
          runner?.stop(),
          operations?.stop(),
        ]),
      () => supervisedRuntime?.close(),
      () => supervisor?.close(),
      // A sweep in flight finishes, or resumes at its phase on the next boot.
      () => {
        removals?.stop();
        return removals?.drain();
      },
      () => memory?.stop(),
      () => deploymentMemory?.close(),
      () => effectBoundary?.close(),
      // After the registry: each server's container is removed by its connector first.
      () => stdioLauncher?.close(),
      () => browser?.pool.close(),
      () => queue?.stop(),
      () => handle?.close(),
    ]) {
      try {
        await stop();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  try {
    if (handle) {
      await migrateDatabase(handle);
      await closeInterruptedScans(handle.db);
      await expireEpisodes(handle.sql);
      // One sign-in service, so the API and the gateway share one refresh per provider.
      signIn = providerSignIn(handle.sql, env);
      episodeRetention = setInterval(() => {
        void expireEpisodes(handle.sql).catch(() =>
          process.stderr.write('episode retention failed\n'),
        );
      }, 60_000);
      episodeRetention.unref();
    }
    if (handle) {
      // Before the registry is built, so an upgraded database gains its default connectors now.
      await ensureBuiltinConnections(handle.sql, builtinEnvironment(env));
      connections = await readConnectionConfig(env.MELETE_CONNECTIONS_FILE);
      browser = await configuredBrowserSessions({ sql: handle.sql, env, connections });
      // Stdio MCP servers run in containers through the same socket as the attempts.
      if (env.MELETE_RUNTIME_ADAPTER === 'docker' && !options.runtime) {
        const hostname = process.env.HOSTNAME ?? '';
        stdioLauncher = new DockerStdioLauncher({
          project: env.MELETE_COMPOSE_PROJECT,
          socket: env.MELETE_DOCKER_SOCKET,
          selfId: /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(hostname) ? hostname : undefined,
          egressPort: env.MELETE_MCP_EGRESS_PORT,
          nodeImage: env.MELETE_MCP_NODE_IMAGE,
          pythonImage: env.MELETE_MCP_PYTHON_IMAGE,
        });
        // No server survives the process that started it; a removed installation's data goes too.
        const kept = await handle.sql`select id from connection
          where provider = 'mcp' and status <> 'revoked'`;
        await stdioLauncher.reconcile(new Set(kept.map((row) => String(row.id))));
      }
      // One connector registry serves the API catalog, the effect boundary and
      // the experience routes; the boundary builds the one configured broker.
      registry = await connectorsFromEnv(handle.sql, env, {
        connections,
        browserSessions: browser?.sessions,
        stdioLauncher,
      });
      catalog = new RuntimeCatalog(handle.db, registry);
    }
    if (handle) {
      events = new EventStream(handle);
      await events.start();
    }
    if (env.DATABASE_URL) queue = await startQueue(env.DATABASE_URL);
    jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;
    // A job memory invalidated is queued with no wake of its own; this enqueues
    // one. Both memory startups deliver through it.
    const activeJobs = jobs;
    const wakeRecomputedJob =
      activeJobs && options.workers !== false
        ? async (jobId: string) => {
            await activeJobs.transaction(async (tx) => {
              const row = await activeJobs.lock(tx, jobId);
              if (row?.state === 'queued' && row.nextWakeAt)
                await activeJobs.enqueue(tx, row, 'recovery');
            });
          }
        : undefined;
    if (handle && queue && env.MELETE_RUNTIME_ADAPTER === 'docker') {
      deploymentMemory = await startDeploymentMemory({
        sql: handle.sql,
        boss: queue.boss,
        restrictionsDir: env.MELETE_RESTRICTIONS_DIR,
        workers: options.workers,
        onJobRecompute: wakeRecomputedJob,
      });
    }
    if (jobs) {
      submissions = new SubmissionService(jobs);
      episodes = new EpisodeService(jobs, (id) => runner?.interrupt(id));
      // A correction made in the conversation reaches learning the same way one
      // made through the route does.
      attachConversationCorrections(submissions, episodes, (error) =>
        console.error('conversation correction', String(error)),
      );
      if (env.MELETE_RUNTIME_ADAPTER === 'docker' && !options.runtime) {
        if (!env.MELETE_RUNTIME_KEY || !handle)
          throw new Error('Docker runtime supervision requires MELETE_RUNTIME_KEY and Postgres');
        supervisedRuntime = new DockerHermesRuntimeAdapter({
          project: env.MELETE_COMPOSE_PROJECT,
          image: env.MELETE_RUNTIME_IMAGE,
          socket: env.MELETE_DOCKER_SOCKET,
          workRoot: env.MELETE_WORK_DIR,
          workVolume: env.MELETE_WORK_VOLUME,
          probeUrl: env.MELETE_RUNTIME_URL,
          probeKey: env.MELETE_RUNTIME_KEY,
          startTimeoutMs: env.MELETE_RUNTIME_START_TIMEOUT_MS,
          pendingWait: (bundle) => pendingRuntimeWait(handle.sql, bundle),
          catalogState: brokerCatalogState({ brokerUrl: env.MELETE_BROKER_URL }),
          brokerPort: parseBrokerBind(env.MELETE_BROKER_BIND)?.port,
          parkedActions: async (bundle) => {
            const rows = await handle.sql`select id from action
              where job_id = ${bundle.attempt.job_id}
                and attempt_id = ${bundle.attempt.id} and status = 'needs_approval'
              order by created_at`;
            return rows.map((row) => String(row.id));
          },
        });
        await supervisedRuntime.initialize();
      }
      let hermesRuntime: RuntimeAdapter | undefined;
      if (handle && queue && env.MELETE_RUNTIME_ADAPTER !== 'docker') {
        // Memory is part of every Postgres-backed service, whichever runtime
        // carries the attempt; the deploy lane's docker path starts its own.
        memory = await startServiceMemory(
          handle.sql,
          queue.boss,
          env.MELETE_SPACES_DIR,
          wakeRecomputedJob,
        );
      }
      if (env.MELETE_RUNTIME_ADAPTER === 'hermes' && !options.runtime && handle && queue) {
        // The wired product path: the broker and one pinned engine per attempt,
        // started here so the listener precedes any worker that can claim a job
        // and launch a child.
        if (!env.MELETE_CAPABILITY_KEY)
          throw new Error('MELETE_CAPABILITY_KEY is required to issue attempt capabilities.');
        effectBoundary = await startEffectBoundary(handle, env, {
          fakeProvider: options.fakeProvider,
          browserSessions: browser?.sessions,
          connections,
          registry,
          signIn,
        });
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
        // Before any worker can claim a job and launch a replacement engine.
        await supervisor.initialize?.();
        hermesRuntime = new SupervisedHermesRuntime(
          supervisor,
          handle.sql,
          options.onTiming,
          brokerCatalogState({ brokerUrl: env.MELETE_BROKER_URL }),
        );
      }
      const runtime =
        options.runtime ??
        supervisedRuntime ??
        hermesRuntime ??
        (env.MELETE_RUNTIME_ADAPTER === 'stub' ? new StubRuntimeAdapter() : undefined);
      if (!runtime || !env.MELETE_CAPABILITY_KEY)
        throw new Error(
          'Configure MELETE_CAPABILITY_KEY and provide a RuntimeAdapter (or MELETE_RUNTIME_ADAPTER=stub for scripted local runs).',
        );
      const capabilityKey = env.MELETE_CAPABILITY_KEY;
      const observed: RuntimeAdapter = {
        capabilities: () => runtime.capabilities(),
        start: (bundle, sink, signal) => {
          options.onBundle?.(structuredClone(bundle));
          return runtime.start(bundle, sink, signal);
        },
      };
      const boundaryForCatalog = effectBoundary;
      const contextualRuntime =
        deploymentMemory && handle
          ? withDeploymentContext(observed, {
              sql: handle.sql,
              spaces: databaseSpaces(handle.db, env.MELETE_SPACES_DIR),
              scopeForJob: deploymentMemory.scopeForJob,
            })
          : memory && handle
            ? withMemoryRuntime(observed, handle.sql, memory.scopeForJob, {
                catalog: async (bundle) =>
                  boundaryForCatalog
                    ? boundaryForCatalog.broker.catalog(
                        verifyCapability(bundle.attempt.token, capabilityKey),
                      )
                    : [],
              })
            : observed;
      runner = new AttemptRunner(jobs, contextualRuntime, {
        key: env.MELETE_CAPABILITY_KEY,
        artifactRoots: { workRoot: env.MELETE_WORK_DIR, spacesRoot: env.MELETE_SPACES_DIR },
        provider: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'stub' : env.MELETE_DEFAULT_PROVIDER,
        model: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'script' : env.MELETE_DEFAULT_MODEL,
        loadCatalog: catalog?.forAttempt,
        // The test connector's fixed scopes when it is enabled; otherwise the
        // scopes the space's active connections actually grant.
        scopes: env.MELETE_ENABLE_TEST_CONNECTOR ? ['test.send', 'test.read'] : undefined,
        liveConnectionScopes: !env.MELETE_ENABLE_TEST_CONNECTOR,
        scopesForJob: async (tx, row) => {
          const granted = await tx
            .select({ scopes: connection.scopes })
            .from(connection)
            .where(and(eq(connection.spaceId, row.spaceId), eq(connection.status, 'active')));
          return [...new Set([...granted.flatMap((entry) => entry.scopes), 'job.wait'])].sort();
        },
      });
      if (browser)
        browser.sessions.onPark = (jobId, attemptIds) => {
          for (const attemptId of attemptIds) runner?.interrupt(jobId, attemptId);
        };
      learning = await startLearning(
        jobs,
        env,
        options.workers !== false,
        options.fakeProvider,
        signIn,
      );
      evaluator = new ProcedureEvaluator(jobs, contextualRuntime, runner.options);
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
      // A child loads its broker catalog once at boot, so the listener must
      // precede workers that can claim a job and launch that child.
      if (!effectBoundary && handle && (options.effects ?? env.MELETE_RUNTIME_ADAPTER === 'docker'))
        effectBoundary = await startEffectBoundary(handle, env, {
          browserSessions: browser?.sessions,
          connections,
          registry,
          signIn,
        });
      // A removal outlives the request that asked for it and the process that
      // was running it, so it is resumed at startup and every minute after.
      const journal = (deploymentMemory?.routes ?? memory)?.journal;
      if (handle && journal) {
        removals = new SpaceRemovalService({
          db: handle.db,
          sql: handle.sql,
          jobs,
          journal,
          roots: { spacesRoot: env.MELETE_SPACES_DIR, workRoot: env.MELETE_WORK_DIR },
          // The registry stops answering for a space's connections before
          // their rows go, and the verification counts what it still holds.
          ...(registry ? { connectors: registry } : {}),
          // The worker stops, the profile goes, and the site rows with it.
          ...(browser ? { browser: browser.sessions } : {}),
          ...(env.MELETE_BROWSER_SPACE ? { browserSpace: env.MELETE_BROWSER_SPACE } : {}),
          // A cancelled job's runtime can still hold its workspace open; the
          // files phase stops it and waits for it before removing the workspace.
          ...(runner
            ? {
                stopJobs: (jobIds: readonly string[]) =>
                  runner?.stopJobs(jobIds) ?? Promise.resolve(),
              }
            : {}),
        });
        // Resumed in the background: a removal waiting on a provider or a held
        // file does not hold up the listener, and a shutdown waits for it.
        if (options.workers !== false) removals.start();
      }
      if (options.workers !== false) {
        await operations.start();
        await triggers.start();
        await runner.start();
        // A chase spends most of its life waiting on a reply, and the wait it
        // holds is an event wait on a `mail.new` trigger. Without something
        // putting that event there, only the deadline ever wakes the job, and a
        // company that answered the same day would be followed up on anyway.
        const connectors = registry;
        if (handle && connectors) {
          companyReplies = new CompanyReplyPoller({
            sql: handle.sql,
            triggers,
            mailboxFor: (candidate) =>
              connectorReplyMailbox({
                registry: connectors,
                connectionId: candidate.connectionId,
                spaceId: candidate.spaceId,
              }),
          });
          await companyReplies.start();
        }
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
    knowledge:
      handle && catalog
        ? {
            spaces: databaseSpaces(handle.db, env.MELETE_SPACES_DIR),
            toolsForSpace: (space) => catalog?.toolsForSpace(space.id) ?? Promise.resolve([]),
          }
        : undefined,
    memory: deploymentMemory?.routes ?? memory,
    browserSessions: browser?.sessions,
    removals,
    episodes,
    proposer: learning?.proposer,
    evaluator,
    runtimeAdapter: options.runtime ? 'injected' : env.MELETE_RUNTIME_ADAPTER,
    runner,
    broker: effectBoundary?.broker,
    registry,
    sql: handle?.sql,
    providerSignIn: signIn,
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
    effectBoundary,
    browserSessions: browser?.sessions,
    removals,
    connections,
    learning,
    memory,
    boundary: effectBoundary,
    supervisor,
    broker: effectBoundary?.broker,
    registry,
    close,
  };
}

if (import.meta.main) {
  const apiNetwork = await resolveApiNetwork(loadEnv());
  const service = await bootstrap({ effects: true });
  const { app, env, effectBoundary } = service;
  const server = Bun.serve({
    hostname: apiNetwork.hostname,
    port: env.PORT,
    fetch: apiFetch(app, apiNetwork, trustedProxy(env.MELETE_TRUSTED_PROXY)),
    idleTimeout: 0,
  });
  process.stdout.write(`melete ${VERSION} listening on ${apiNetwork.hostname}:${env.PORT}\n`);
  if (effectBoundary)
    process.stdout.write(`effect boundary listening on ${env.MELETE_BROKER_BIND}\n`);
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
