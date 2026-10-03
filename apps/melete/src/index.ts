/**
 * The Melete service. One process in v0.1 with separate modules and separate
 * database roles: api, jobs, broker, gateway, connectors, knowledge, events.
 *
 * Modules register their API surfaces against injected durable dependencies.
 * The public API serves /health, the job and account surfaces, and the
 * knowledge surface; the effect listener serves broker, API action reads, and
 * model traffic on its own internal port.
 */

import type { AttemptBundle, RuntimeAdapter } from '@melete/contracts';
import { brokerCatalogState } from '@melete/runtime-hermes';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ZodError } from 'zod';
import { mountActions } from './api/actions.ts';
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
import { mountModelSettings } from './api/model-settings.ts';
import { mountOperations } from './api/operations.ts';
import { mountPolicy } from './api/policy.ts';
import { mountProviderSignIn } from './api/provider-signin.ts';
import { mountQuestions } from './api/questions.ts';
import { mountReactions, type SpaceResolver } from './api/reactions.ts';
import { mountRepairs, RepairReadService } from './api/repairs.ts';
import { mountReplies } from './api/replies.ts';
import { mountScreenshots } from './api/screenshots.ts';
import { mountTriggers } from './api/triggers.ts';
import { mountHealthDetail, mountUsage } from './api/usage.ts';
import {
  mountVoice,
  PostgresVoiceAllowance,
  type VoiceProviders,
  voiceLimitsFromEnv,
  voicePrivacyFrom,
  voiceProvidersFromEnv,
} from './api/voice.ts';
import { configuredVoiceCompanion, type VoiceCompanion } from './api/voice-companion.ts';
import { mountApps } from './apps/routes.ts';
import { mountAppViews } from './apps/serve.ts';
import { attachmentSettingsFromEnv } from './attachments/limits.ts';
import { mountAttachments } from './attachments/routes.ts';
import { AttachmentService } from './attachments/store.ts';
import { verifyCapability } from './broker/capability.ts';
import { pendingRuntimeWait } from './broker/runtime-wait.ts';
import { configuredSearchGateway } from './broker/search-gateway.ts';
import type { BrokerService } from './broker/service.ts';
import { startEffectBoundary } from './broker/start.ts';
import { CompanyReplyPoller, connectorReplyMailbox } from './companies/replies.ts';
import { closeInterruptedScans } from './companies/repository.ts';
import { type CompaniesDeps, mountCompanies } from './companies/routes.ts';
import { companiesDeps } from './companies/service.ts';
import { builtinEnvironment, ensureBuiltinConnections } from './connectors/builtin.ts';
import {
  type ConfiguredConnection,
  type ConnectorFactory,
  configuredBrowserSessions,
  connectorFactoryFor,
  connectorOptionsFromEnv,
  connectorsFromEnv,
  readConnectionConfig,
} from './connectors/configured.ts';
import { DockerStdioLauncher } from './connectors/mcp-stdio-docker.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import { keylessSearchNotice, webSearchFromEnv } from './connectors/web-search.ts';
import { type Database, openDatabase, pingDatabase } from './db/client.ts';
import { migrateDatabase } from './db/migrate.ts';
import { owner } from './db/schema.ts';
import { mountDevices } from './devices/routes.ts';
import { moveWorkspaceScreensUntilDone } from './devices/screens.ts';
import { DeviceService } from './devices/service.ts';
import { startEgressRetention } from './egress/records.ts';
import { demonstrationWarnings, type Env, loadEnv, parseBrokerBind } from './env.ts';
import { EventStream } from './events/stream.ts';
import { removeDeletedRoutineThreads } from './experience/removal.ts';
import { mountExperience } from './experience/routes.ts';
import type { FeedbackLimiter } from './feedback/rate-limit.ts';
import { mountFeedback } from './feedback/routes.ts';
import { providerSignIn } from './gateway/configured.ts';
import type { ProviderSignIn } from './gateway/credentials.ts';
import type { GatewayOptions } from './gateway/index.ts';
import { ModelSettingsService } from './gateway/model-settings.ts';
import { routingFromEnv, routingWarnings } from './gateway/routing.ts';
import { type SpendingGuard, spendingFromEnv } from './gateway/spending.ts';
import {
  alertSendersFromEnv,
  type HealthDetail,
  HealthMonitor,
  healthDetail,
} from './health/monitor.ts';
import { ApprovalService } from './jobs/approvals.ts';
import { AttentionService } from './jobs/attention.ts';
import { OperationService } from './jobs/operations.ts';
import { PolicyService } from './jobs/policy.ts';
import { QuestionService } from './jobs/questions.ts';
import { startQueue } from './jobs/queue.ts';
import { ReactionService } from './jobs/reactions.ts';
import { ReplyService } from './jobs/replies.ts';
import { AttemptRunner } from './jobs/runner.ts';
import { connectionScopesForJob } from './jobs/scopes.ts';
import { JobService } from './jobs/service.ts';
import { SubmissionService } from './jobs/submissions.ts';
import { TriggerService } from './jobs/triggers.ts';
import { RuntimeCatalog } from './knowledge/catalog.ts';
import { type KnowledgeDeps, knowledgeRoutes } from './knowledge/routes.ts';
import { databaseSpaces, filesystemSpaces } from './knowledge/spaces.ts';
import { attachConversationCorrections } from './learning/conversation.ts';
import { EngineSkillService } from './learning/engine-skills.ts';
import { EpisodeService } from './learning/episodes.ts';
import { ProcedureEvaluator } from './learning/evaluator.ts';
import { LearnedService } from './learning/learned.ts';
import { EngineSource } from './learning/learned-engine.ts';
import { mountLearned } from './learning/learned-routes.ts';
import { mountProcedures } from './learning/procedure-routes.ts';
import { ProcedureService } from './learning/procedures.ts';
import { mountProposals } from './learning/proposal-routes.ts';
import type { ProcedureProposer } from './learning/proposer.ts';
import { expireEpisodes, startEpisodeRetention } from './learning/retention.ts';
import { mountLearning } from './learning/routes.ts';
import { startLearning } from './learning/start.ts';
import { mountMcpServer } from './mcp-server/routes.ts';
import { startDeploymentMemory } from './memory/bootstrap.ts';
import { memoryScopeForSpace } from './memory/broker-trust.ts';
import { withMemoryRuntime } from './memory/context.ts';
import { createDisputeSettler } from './memory/disputes.ts';
import { configuredMemoryGateway } from './memory/gateway.ts';
import { type MemoryHealth, memoryHealth } from './memory/health.ts';
import { createMemoryRouter, type MemoryRouteOptions } from './memory/routes.ts';
import { startServiceMemory } from './memory/start.ts';
import { InstanceRegistry, instanceId } from './ops/instance.ts';
import { Leases, leaseConnection } from './ops/leader.ts';
import { type LimitStore, PostgresLimitStore } from './ops/limiter.ts';
import {
  refusedForRemoval,
  requestPrincipal,
  SPACE_BEING_CLEARED,
  spaceAuthority,
} from './principals/authority.ts';
import { mountPrincipals } from './principals/routes.ts';
import { withPrivacyGate } from './privacy/gate.ts';
import { defaultPrivacyRouter, PostgresPrivacyStore, PrivacyRouter } from './privacy/index.ts';
import { mountPrivacy } from './privacy/routes.ts';
import { engineProtocol, providerAddress, servicePrivacyRouter } from './privacy/service.ts';
import { mountPush } from './push/routes.ts';
import { PushDispatcher, PushService, pushConfig } from './push/service.ts';
import { attachRuns, RunService } from './runs/service.ts';
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
import { mountSandboxComputers, SandboxComputerService } from './sandbox/computer.ts';
import { sandboxKeyCheck } from './sandbox/connection.ts';
import { mountSandboxPreviews, previewsFor, type SandboxPreviews } from './sandbox/preview.ts';
import { PREVIEW_PREFIX } from './sandbox/preview-path.ts';
import { startProcessMonitor } from './sandbox/process-monitor.ts';
import { startProcesses } from './sandbox/processes.ts';
import {
  type SandboxWiring,
  sandboxKeyChange,
  sandboxRemovalTeardown,
  startSandboxesFromEnv,
} from './sandbox/wiring.ts';
import { SpaceRemovalService } from './spaces/removal.ts';
import { mountSpaceRemoval } from './spaces/routes.ts';
import { type BlobStore, configuredBlobStore } from './storage/blob.ts';
import { BlobCollector } from './storage/gc.ts';
import { isolated, VIEW_PREFIX } from './viewer/headers.ts';
import { ViewTokens } from './viewer/tokens.ts';
import { mountBrowserLive } from './workers/browser/live-service.ts';
import { type BrowserSessionService, mountBrowserSessions } from './workers/browser/routes.ts';
import { mountBrowserSites } from './workers/browser/sites.ts';

export const VERSION = '0.1.0-pre';

/** What the test connector grants every attempt when it is enabled. */
const TEST_CONNECTOR_SCOPES = ['test.send', 'test.read'];

export type AppDeps = {
  env: Env;
  db: Database | null;
  /** Long work in the background; built from `jobs` when left out. */
  runs?: RunService;
  loginThrottle?: LoginThrottle;
  /** Where request limits are counted. Left out, in Postgres when `sql` is given. */
  limits?: LimitStore;
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
  /** Whether automatic memory is reading what people say, for the operator. */
  checkMemory?: () => Promise<MemoryHealth | null>;
  /** Left out, the authenticated owner's database catalog resolves volume spaces. */
  knowledge?: KnowledgeDeps;
  memory?: MemoryRouteOptions;
  browserSessions?: BrowserSessionService;
  /** The desktops in docker sandboxes, to watch and take over. */
  sandboxComputers?: SandboxComputerService;
  /** Previews of servers in agents' computers, and a person's stop and output of their processes. */
  sandboxPreviews?: SandboxPreviews;
  removals?: SpaceRemovalService;
  runtimeAdapter?: string;
  runner?: AttemptRunner;
  broker?: BrokerService;
  registry?: ConnectorRegistry;
  sql?: Sql;
  /** Phone presence. Left out, built from the database and the VAPID keys in the environment. */
  push?: PushService;
  /** Overrides for the company map: a test's store, extractor or handler. */
  companies?: Partial<CompaniesDeps>;
  /** The owner's model-provider sign-ins. Left out, built from `sql` and the master key. */
  providerSignIn?: ProviderSignIn;
  /** The voice providers. Left out, whatever the environment configures. */
  voice?: VoiceProviders;
  /** The light conversation voice mode keeps up while a turn runs. Left out, none. */
  voiceCompanion?: VoiceCompanion | null;
  /** The router every model gateway of this service uses; Settings → Privacy edits it. */
  privacy?: PrivacyRouter;
  /** The model connected in the app. Left out, built from `db` and the sign-ins. */
  modelSettings?: ModelSettingsService;
  /** How many problem reports one person may send in a short time; a test supplies its clock. */
  feedbackLimiter?: FeedbackLimiter;
  /** The installation's spending caps; Settings shows usage from them. */
  spending?: SpendingGuard;
  /** The operator's health detail. Left out, the database and queue checks alone. */
  healthDetail?: () => Promise<HealthDetail>;
  /** Where published apps' files are kept. Left out, an app's files are not served. */
  blobs?: BlobStore;
  /** Signs app views. Left out, keyed from the master key. */
  viewTokens?: ViewTokens;
  /** The files people send in chat. Left out, nothing can be attached. */
  attachments?: AttachmentService;
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
  // First, so it runs last: nothing under the app view path leaves without the
  // isolation headers, whatever answered it.
  app.use(`${VIEW_PREFIX}*`, isolated);
  // The same for a preview of a server in an agent's computer.
  app.use(`${PREVIEW_PREFIX}*`, isolated);
  const connections =
    deps.db && deps.sql && deps.registry
      ? { db: deps.db, sql: deps.sql, registry: deps.registry, env: deps.env }
      : undefined;
  // Mounted before the routes it follows, so it runs once they have answered;
  // see mountDefaultConnections.
  if (connections) mountDefaultConnections(app, connections);
  // Limits every instance on the database shares; one instance alone counts the same.
  const limits = deps.limits ?? (deps.sql ? new PostgresLimitStore(deps.sql) : undefined);
  mountAuth(app, { ...deps, limits });
  // The authenticated session names the space and the principal; a request header never does.
  const personalSpace: SpaceResolver =
    deps.resolveSpace ??
    (async (c) => {
      const spaceId = c.get('experienceSpaceId');
      return spaceId ? { spaceId, principalId: c.get('owner')?.id } : null;
    });
  if (deps.db)
    mountArtifacts(
      app,
      deps.db,
      { workRoot: deps.env.MELETE_WORK_DIR, spacesRoot: deps.env.MELETE_SPACES_DIR },
      personalSpace,
    );
  // Apps a person can open, and the changes they make to their own.
  if (deps.sql)
    mountApps(app, {
      sql: deps.sql,
      ...(deps.blobs ? { blobs: deps.blobs } : {}),
      roots: { workRoot: deps.env.MELETE_WORK_DIR, spacesRoot: deps.env.MELETE_SPACES_DIR },
    });
  // Opening one: a view for the person, and the files it loads with its token.
  if (deps.sql)
    mountAppViews(app, {
      sql: deps.sql,
      ...(deps.blobs ? { blobs: deps.blobs } : {}),
      tokens: deps.viewTokens ?? new ViewTokens(deps.env.MELETE_MASTER_KEY),
    });
  if (deps.db) mountScreenshots(app, deps.db, deps.env.MELETE_WORK_DIR, personalSpace);
  if (deps.attachments) mountAttachments(app, deps.attachments, personalSpace, limits);
  mountPrincipals(app, deps.db, deps.env.MELETE_SPACES_DIR, deps.jobs);
  // After mountPrincipals, so the owner-only guard it installs on every
  // non-GET under /spaces/:id runs before the handler that removes one.
  if (deps.removals && deps.db && deps.sql)
    mountSpaceRemoval(app, { db: deps.db, sql: deps.sql, removals: deps.removals });
  if (connections) mountConnections(app, connections);
  if (connections)
    mountDevices(
      app,
      new DeviceService({
        ...connections,
        policy: deps.policy ?? (deps.jobs ? new PolicyService(deps.jobs) : undefined),
        ...(deps.jobs ? { jobs: deps.jobs } : {}),
      }),
      limits,
    );
  const signIn = deps.providerSignIn ?? (deps.sql ? providerSignIn(deps.sql, deps.env) : undefined);
  // One reader of the model connected in the app, for its routes and the companies scan.
  const modelSettings =
    deps.modelSettings ??
    (deps.db ? new ModelSettingsService({ db: deps.db, env: deps.env, signIn }) : undefined);
  if (deps.db && modelSettings) {
    mountProviderSignIn(app, { db: deps.db, signIn });
    mountModelSettings(app, { db: deps.db, settings: modelSettings });
  }
  if (deps.spending)
    mountUsage(app, {
      spending: deps.spending,
      isOwner: async (actor) => {
        if (!actor || !deps.db) return false;
        const [installation] = await deps.db.select({ id: owner.id }).from(owner).limit(1);
        return installation?.id === actor;
      },
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
    const engine = new EngineSkillService(deps.jobs);
    mountProcedures(app, procedures, deps.evaluator, engine);
    mountLearned(
      app,
      new LearnedService(deps.jobs, procedures, episodes, [new EngineSource(engine)]),
    );
  } else if (deps.proposer) mountProposals(app, deps.proposer);
  if (replies) mountReplies(app, replies);
  if (db) mountActions(app, db, deps.broker);
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
  // The router every model call made from these routes goes through, and the
  // one Settings → Privacy edits.
  const privacy =
    deps.privacy ??
    (deps.sql
      ? new PrivacyRouter({
          store: new PostgresPrivacyStore(deps.sql, () => deps.env.MELETE_MASTER_KEY),
        })
      : defaultPrivacyRouter());
  // Before the experience routes, which answer every operation they do not implement.
  if (deps.db) mountPrivacy(app, { router: () => privacy, providerUrl: providerAddress(deps.env) });
  if (deps.db)
    mountVoice(app, {
      db: deps.db,
      allowance: deps.sql ? new PostgresVoiceAllowance(deps.sql) : undefined,
      providers: deps.voice ?? voiceProvidersFromEnv(deps.env),
      limits: voiceLimitsFromEnv(deps.env),
      // Voice goes to its provider directly, so it follows the router's private marks.
      privacy: voicePrivacyFrom(privacy),
      companion: deps.voiceCompanion ?? null,
    });
  if (deps.db) mountPush(app, deps.push ?? new PushService(deps.db, pushConfig(deps.env)));
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
      memoryProvision: deps.memory?.provision,
      triggers: deps.triggers,
      changes: deps.events,
      browser: Boolean(deps.browserSessions),
      privacy,
      runs: deps.runs ?? deps.runner?.runs ?? (deps.jobs ? new RunService(deps.jobs) : undefined),
      attachments: deps.attachments,
    });
  if (deps.db)
    mountCompanies(app, {
      ...companiesDeps({
        db: deps.db,
        sql: deps.sql,
        registry: deps.registry,
        env: deps.env,
        privacy,
        jobs: deps.jobs,
        triggers: deps.triggers,
        modelSettings,
        spending: deps.spending,
      }),
      ...deps.companies,
    });
  if (deps.db && deps.sql)
    mountMcpServer(app, {
      db: deps.db,
      sql: deps.sql,
      env: deps.env,
      broker: deps.broker,
      registry: deps.registry,
      limits,
    });
  if (deps.db) mountFeedback(app, { db: deps.db, version: VERSION, limiter: deps.feedbackLimiter });
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
  if (deps.sandboxComputers) mountSandboxComputers(app, deps.sandboxComputers);
  if (deps.sandboxPreviews) mountSandboxPreviews(app, deps.sandboxPreviews);

  mountHealthDetail(app, {
    token: deps.env.MELETE_OPERATOR_TOKEN,
    detail:
      deps.healthDetail ??
      (() => healthDetail({ version: VERSION, database: deps.checkDatabase, sql: deps.sql })),
  });

  app.get('/health', async (c) => {
    const database = await deps.checkDatabase();
    return c.json({
      status: database === 'unreachable' ? 'degraded' : 'ok',
      version: VERSION,
      database,
      runtime_adapter: deps.runtimeAdapter,
      runtime_supervisor:
        deps.runtimeAdapter === 'hermes' ? deps.env.MELETE_RUNTIME_SUPERVISOR : null,
      ...(database === 'ok' && deps.checkMemory
        ? { memory: (await deps.checkMemory().catch(() => null)) ?? undefined }
        : {}),
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
          message: 'There is no endpoint at this path. See packages/contracts/openapi.json.',
        },
      },
      404,
    ),
  );

  return app;
}

/** This instance's name and the instances running beside it, for the Docker backends. */
const instanceOf = (instances: InstanceRegistry | undefined) =>
  instances
    ? { id: instances.id, running: (staleAfterMs?: number) => instances.others(staleAfterMs) }
    : undefined;

/** Whether this instance runs the named singleton work now. Without a database, it is alone. */
const leading = (leases: Leases | undefined, name: string) =>
  leases ? leases.leads(name) : Promise.resolve(true);

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
  for (const warning of demonstrationWarnings(env)) process.stderr.write(`WARNING: ${warning}\n`);
  for (const warning of routingWarnings(
    env as unknown as Record<string, string | undefined>,
    routingFromEnv(env),
  ))
    process.stderr.write(`WARNING: ${warning}\n`);
  // An engine the supervisor cannot drive is named here, before the database is
  // opened or migrated, instead of as a Docker 400 on the first attempt.
  if (!options.runtime && env.MELETE_RUNTIME_ADAPTER === 'docker')
    await assertDockerEngine(
      new DockerSocketApi(env.MELETE_DOCKER_SOCKET),
      env.MELETE_DOCKER_SOCKET,
    );
  const handle = env.DATABASE_URL ? openDatabase(env.DATABASE_URL) : null;
  // One privacy router for this service, over its database, handed to every model
  // gateway it opens, the attempt gate and the settings routes.
  const privacy = handle ? servicePrivacyRouter(handle.sql, env) : defaultPrivacyRouter();
  let queue: Awaited<ReturnType<typeof startQueue>> | null = null;
  let jobs: JobService | undefined;
  let runs: RunService | undefined;
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
  let stopEpisodeRetention: (() => void) | undefined;
  let stopEgressRetention: (() => void) | undefined;
  let learning: Awaited<ReturnType<typeof startLearning>> | undefined;
  let evaluator: ProcedureEvaluator | undefined;
  let memory: Awaited<ReturnType<typeof startServiceMemory>> | undefined;
  let removals: SpaceRemovalService | undefined;
  let blobs: ReturnType<typeof startBlobs> | undefined;
  let attachments: AttachmentService | undefined;
  let memoryGateway: Awaited<ReturnType<typeof configuredMemoryGateway>> | undefined;
  let voiceCompanion: Awaited<ReturnType<typeof configuredVoiceCompanion>> | undefined;
  let supervisor: RuntimeSupervisor | undefined;
  let registry: ConnectorRegistry | undefined;
  let searchGateway: Awaited<ReturnType<typeof configuredSearchGateway>> | undefined;
  let stdioLauncher: DockerStdioLauncher | undefined;
  let companyReplies: CompanyReplyPoller | undefined;
  let pushDispatcher: PushDispatcher | undefined;
  let signIn: ProviderSignIn | undefined;
  let modelSettings: ModelSettingsService | undefined;
  let sandboxes: SandboxWiring | undefined;
  let sandboxTeardown: ReturnType<ConnectorFactory['sandboxTeardownProviders']>;
  let releaseSandboxes: ReturnType<typeof sandboxKeyChange> | undefined;
  let removeSandboxes: ReturnType<typeof sandboxRemovalTeardown> | undefined;
  let sandboxComputers: SandboxComputerService | undefined;
  let sandboxPreviews: SandboxPreviews | undefined;
  let processSweep: { stop(): void } | undefined;
  let processMonitor: { stop(): void } | undefined;
  let processFactory: Parameters<typeof startProcessMonitor>[0] | undefined;
  let spending: SpendingGuard | undefined;
  let runtimeProbe: (() => Promise<unknown>) | undefined;
  let healthMonitor: HealthMonitor | undefined;
  const routing = routingFromEnv(env);
  /** This instance among any others on the database, and the singleton work it leads. */
  let instances: InstanceRegistry | undefined;
  let leases: Leases | undefined;
  let leftovers: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    // A wake can still be waiting for capabilities before the runner records
    // it as active. Interrupt that wait before runner.stop drains its wakes.
    supervisedRuntime?.beginShutdown();
    stopEpisodeRetention?.();
    stopEgressRetention?.();
    clearInterval(leftovers);
    sandboxes?.stop();
    processSweep?.stop();
    processMonitor?.stop();
    await healthMonitor?.stop();
    let failure: unknown;
    for (const stop of [
      () =>
        Promise.all([
          learning?.close(),
          events?.close(),
          companyReplies?.stop(),
          pushDispatcher?.stop(),
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
      () => blobs?.collector.stop(),
      () => memory?.stop(),
      () => memoryGateway?.close(),
      () => searchGateway?.close(),
      () => voiceCompanion?.close(),
      () => deploymentMemory?.close(),
      () => effectBoundary?.close(),
      // After the registry: each server's container is removed by its connector first.
      () => stdioLauncher?.close(),
      () => browser?.pool.close(),
      () => sandboxTeardown?.close(),
      // Its cells are gone; another instance may now take its leases and clean up after it.
      () => leases?.close(),
      () => instances?.stop(),
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
      // Recorded before this instance starts anything another could remove.
      instances = new InstanceRegistry(handle.sql, instanceId(env.MELETE_INSTANCE_ID));
      await instances.start();
      // Its own connection: a lease is a lock held by that one session.
      if (env.DATABASE_URL) {
        const url = env.DATABASE_URL;
        const id = instances.id;
        leases = new Leases(() => leaseConnection(url, id));
      }
      // The blob store first: the connectors, the gateway and the routes keep files in it.
      blobs = startBlobs(handle.sql, env, options.workers !== false, () =>
        leading(leases, 'blob-collector'),
      );
      attachments = new AttachmentService(handle.sql, blobs.store, attachmentSettingsFromEnv(env));
      await closeInterruptedScans(handle.db);
      await expireEpisodes(handle.sql);
      // One sign-in service, so the API and the gateway share one refresh per provider.
      signIn = providerSignIn(handle.sql, env);
      // One reader of the model chosen in the app, for the API, the runner and the gateway.
      modelSettings = new ModelSettingsService({ db: handle.db, env, signIn });
      // One record of what every model call cost, shared by every gateway.
      spending = spendingFromEnv(handle.sql, env);
      stopEpisodeRetention = startEpisodeRetention(handle.sql, () =>
        leading(leases, 'episode-retention'),
      );
      stopEgressRetention = startEgressRetention(
        handle.sql,
        env.MELETE_EGRESS_RECORD_DAYS,
        undefined,
        () => leading(leases, 'egress-retention'),
      );
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
          instance: instanceOf(instances),
        });
        // No server survives the process that started it; a removed installation's
        // data goes too, removed by one instance at a time.
        const kept = await handle.sql`select id from connection
          where provider = 'mcp' and status <> 'revoked'`;
        await stdioLauncher.reconcile(new Set(kept.map((row) => String(row.id))), {
          volumes: await leading(leases, 'mcp-stdio-data'),
        });
      }
      // One connector registry serves the API catalog, the effect boundary and
      // the experience routes; the boundary builds the one configured broker.
      // Searches may fall to DuckDuckGo's page from this address; the operator is told once.
      const keyless = keylessSearchNotice(env);
      if (keyless) process.stderr.write(`${keyless}\n`);
      // The model's own web search goes through a gateway of its own, metered on the job.
      searchGateway = await configuredSearchGateway(handle.sql, env, privacy, {
        signIn,
        settings: modelSettings,
        spending,
      });
      registry = await connectorsFromEnv(handle.sql, env, {
        connections,
        browserSessions: browser?.sessions,
        stdioLauncher,
        // A file the person sent can be saved into the agent's workspace.
        attachments,
        // A space or agent the person marked private reads no public web pages.
        privateContext: ({ spaceId, agentId }, query) =>
          privacy.marksPrivate(spaceId, agentId, query),
        webSearch: webSearchFromEnv(env, { native: searchGateway.backend }),
        // A private or sensitive conversation's words never go to an outside search.
        searchPrivacy: ({ jobId, query }) => privacy.outsideSearchRefusal(jobId, query),
      });
      catalog = new RuntimeCatalog(handle.db, registry);
      // Sandboxes are the service's own: their providers come from the same
      // factory the connectors did, so the key stays with the connection.
      const connectors = connectorFactoryFor(registry, () =>
        connectorOptionsFromEnv(handle.sql, env),
      );
      sandboxes = startSandboxesFromEnv(handle.sql, env, connectors);
      // A sandbox connection's key is the only way into its account, so a
      // revocation destroys what the connection holds before the key goes.
      sandboxTeardown = connectors.sandboxTeardownProviders();
      const sandboxSessions = connectors.options.sandbox?.sessions;
      if (sandboxTeardown && sandboxSessions) {
        releaseSandboxes = sandboxKeyChange({
          sessions: sandboxSessions,
          providerFor: sandboxTeardown.providerFor,
          withKey: sandboxTeardown.withKey,
        });
        removeSandboxes = sandboxRemovalTeardown(sandboxSessions, sandboxTeardown.providerFor);
        // Only docker sandboxes have a desktop; the service lists none for the others.
        sandboxComputers = new SandboxComputerService(
          handle.sql,
          () => connectors.sandboxProviders,
        );
      }
      processSweep = startProcesses(connectors);
      sandboxPreviews = previewsFor(handle.sql, connectors, env.MELETE_MASTER_KEY);
      processFactory = connectors;
      // Boot reconciliation, before any attempt can open a session of its own.
      // One instance at a time reconciles and sweeps; any instance may take over.
      if (sandboxes) {
        const lease = {
          leads: () => leading(leases, 'sandbox'),
          signal: () => leases?.signal('sandbox') ?? new AbortController().signal,
        };
        const bounded = () => AbortSignal.any([AbortSignal.timeout(120_000), lease.signal()]);
        const first = await lease.leads();
        if (first) await sandboxes.reconcile(bounded());
        sandboxes.start(lease);
        // Sessions left by attempts that ended with the last process are
        // settled now, not when the first timed sweep comes round.
        if (first)
          void sandboxes.sweep(bounded()).catch(() => {
            process.stderr.write('sandbox sweep at start failed\n');
          });
      }
    }
    if (handle) {
      events = new EventStream(handle);
      await events.start();
    }
    if (env.DATABASE_URL) queue = await startQueue(env.DATABASE_URL);
    jobs = handle && queue ? new JobService(handle.db, queue.boss) : undefined;
    if (jobs) jobs.attachmentsPerMessage = attachmentSettingsFromEnv(env).perMessage;
    runs = jobs ? new RunService(jobs) : undefined;
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
    // Automatic memory: what a person says in chat is read by the memory model
    // through the gateway, within a per-person daily budget.
    if (handle && queue && options.workers !== false)
      memoryGateway = await configuredMemoryGateway(
        handle.sql,
        env,
        options.fakeProvider,
        privacy,
        { settings: modelSettings, signIn, spending },
      );
    // Voice mode's companion: a short model call through the gateway, so the
    // privacy router reads it like any other. Only where voice mode exists.
    if (handle && voiceProvidersFromEnv(env).live)
      voiceCompanion = await configuredVoiceCompanion(env, options.fakeProvider, privacy, {
        settings: modelSettings,
        signIn,
        spending,
      });
    if (handle && queue && env.MELETE_RUNTIME_ADAPTER === 'docker') {
      deploymentMemory = await startDeploymentMemory({
        sql: handle.sql,
        boss: queue.boss,
        restrictionsDir: env.MELETE_RESTRICTIONS_DIR,
        spacesDir: env.MELETE_SPACES_DIR,
        workers: options.workers,
        onJobRecompute: wakeRecomputedJob,
        gateway: memoryGateway?.gateway,
        privacyOrigin: (jobId, text) => privacy.captureOrigin(jobId, text),
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
          instance: instanceOf(instances),
          startTimeoutMs: env.MELETE_RUNTIME_START_TIMEOUT_MS,
          spares: env.MELETE_ENGINE_PREWARM,
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
        // Cells and stdio servers of instances that stopped without cleaning up,
        // removed by one running instance at a time.
        const runtime = supervisedRuntime;
        leftovers = setInterval(() => {
          void leading(leases, 'stopped-instances')
            .then(async (leads) => {
              if (!leads) return;
              await runtime.removeStopped();
              if (leases?.signal('stopped-instances').aborted) return;
              await stdioLauncher?.reconcile(new Set(), { starting: false, volumes: false });
            })
            .catch(() => process.stderr.write("removing stopped instances' cells failed\n"));
        }, 60_000);
        leftovers.unref();
        // The first reply need not wait for an engine to load either: one is
        // loaded for the model the next attempt would be given.
        const next = await modelSettings?.activeChoice().catch(() => undefined);
        const provider = next?.provider ?? env.MELETE_DEFAULT_PROVIDER;
        const model = next?.model ?? env.MELETE_DEFAULT_MODEL;
        if (provider && model) supervisedRuntime.warm({ provider, model, fallback: null });
      }
      let hermesRuntime: SupervisedHermesRuntime | undefined;
      if (handle && queue && env.MELETE_RUNTIME_ADAPTER !== 'docker') {
        // Memory is part of every Postgres-backed service, whichever runtime
        // carries the attempt; the docker runtime path starts its own.
        memory = await startServiceMemory(
          handle.sql,
          queue.boss,
          env.MELETE_SPACES_DIR,
          wakeRecomputedJob,
          options.workers !== false
            ? {
                gateway: memoryGateway?.gateway,
                captureChat: true,
                privacyOrigin: (jobId, text) => privacy.captureOrigin(jobId, text),
              }
            : { gateway: memoryGateway?.gateway },
        );
      }
      if (env.MELETE_RUNTIME_ADAPTER === 'hermes' && !options.runtime && handle && queue) {
        // The wired product path: the broker and one pinned engine per attempt,
        // started here so the listener precedes any worker that can claim a job
        // and launch a child.
        if (!env.MELETE_CAPABILITY_KEY)
          throw new Error('MELETE_CAPABILITY_KEY is required to issue attempt capabilities.');
        effectBoundary = await startEffectBoundary(handle, env, {
          privacy,
          runs,
          fakeProvider: options.fakeProvider,
          browserSessions: browser?.sessions,
          connections,
          registry,
          signIn,
          modelSettings,
          spending,
          blobs: blobs?.store,
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
          prewarm: env.MELETE_ENGINE_PREWARM > 0,
        });
        // Before any worker can claim a job and launch a replacement engine.
        await supervisor.initialize?.();
        // The first reply need not wait for an engine to load either.
        if (env.MELETE_DEFAULT_PROVIDER && env.MELETE_DEFAULT_MODEL)
          supervisor.warm?.({
            provider: env.MELETE_DEFAULT_PROVIDER,
            model: env.MELETE_DEFAULT_MODEL,
            fallback: null,
          });
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
      const probed = runtime;
      if (probed && env.MELETE_RUNTIME_ADAPTER !== 'stub')
        runtimeProbe = () => probed.capabilities();
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
                // Private memory is recalled only into attempts that stay on the person's own model.
                recallsPrivateMemory: (jobId, attemptId) =>
                  privacy.recallsPrivateMemory(jobId, attemptId, {
                    protocol: engineProtocol(env),
                    providerUrl: providerAddress(env),
                  }),
                catalog: async (bundle) =>
                  boundaryForCatalog
                    ? boundaryForCatalog.broker.catalog(
                        verifyCapability(bundle.attempt.token, capabilityKey),
                      )
                    : [],
              })
            : observed;
      // A conversation that must stay private, with no local model to stay on,
      // asks the person before the engine starts.
      const gatedRuntime = withPrivacyGate(contextualRuntime, {
        router: () => privacy,
        engineProtocol: engineProtocol(env),
        providerUrl: providerAddress(env),
        onError: (error) => process.stderr.write(`privacy gate: ${error.message}\n`),
      });
      runner = new AttemptRunner(jobs, gatedRuntime, {
        key: env.MELETE_CAPABILITY_KEY,
        concurrency: env.MELETE_ATTEMPT_CONCURRENCY,
        artifactRoots: { workRoot: env.MELETE_WORK_DIR, spacesRoot: env.MELETE_SPACES_DIR },
        provider: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'stub' : env.MELETE_DEFAULT_PROVIDER,
        model: env.MELETE_RUNTIME_ADAPTER === 'stub' ? 'script' : env.MELETE_DEFAULT_MODEL,
        // A model chosen in the app applies from the next attempt. On the
        // server's default, a configured vision model reads its pictures.
        ...(env.MELETE_RUNTIME_ADAPTER !== 'stub' && modelSettings
          ? {
              resolveModel: (tx: Parameters<ModelSettingsService['routedChoice']>[1]) =>
                (modelSettings as ModelSettingsService).routedChoice(routing, tx),
            }
          : {}),
        // Past a spending limit no attempt starts, and one cut short ends on it.
        ...(spending
          ? { spendingLimit: (jobId: string) => (spending as SpendingGuard).reachedForJob(jobId) }
          : {}),
        loadCatalog: catalog?.forAttempt,
        liveConnectionScopes: !env.MELETE_ENABLE_TEST_CONNECTOR,
        // The scopes the active connections the job may use grant, and the
        // lifecycle wait. The test connector's scopes are added beside them when
        // it is enabled, so a `--fake` installation keeps its default tools.
        scopesForJob: async (tx, row) =>
          [
            ...new Set([
              ...(await connectionScopesForJob(tx, row)),
              'job.wait',
              ...(env.MELETE_ENABLE_TEST_CONNECTOR ? TEST_CONNECTOR_SCOPES : []),
            ]),
          ].sort(),
      });
      // An attempt that ends leaves no sandbox running: its workspace is
      // suspended, and an ephemeral session is closed. Settled after the
      // attempt has ended however it ended, finished, stopped, fenced, lost or
      // cut short by shutdown, and never inside the outcome transaction: both
      // are provider calls, and that transaction holds the event order lock.
      if (runs) attachRuns(runner, runs);
      // A call refused at a spending limit ends its attempt at once.
      if (spending) {
        const stopping = runner;
        spending.onRefused = (_scope, principal, message) => {
          if (principal.privacy.kind === 'job')
            stopping.stopForSpending(principal.jobId, principal.attemptId, message);
        };
      }
      if (sandboxes) runner.onSettled.push((attemptId) => sandboxes?.afterAttempt(attemptId));
      // Where the broker runs here, what a finished attempt left dispatched with
      // nobody waiting on it is settled before the attempt commits.
      runner.settleAbandoned = async (attemptId) =>
        effectBoundary?.broker.settleAbandoned(attemptId);
      if (browser)
        browser.sessions.onPark = (jobId, attemptIds) => {
          for (const attemptId of attemptIds) runner?.interrupt(jobId, attemptId);
        };
      if (sandboxComputers)
        sandboxComputers.onPark = (jobId, attemptIds) => {
          for (const attemptId of attemptIds) runner?.interrupt(jobId, attemptId);
        };
      learning = await startLearning(
        jobs,
        env,
        options.workers !== false,
        options.fakeProvider,
        signIn,
        privacy,
        modelSettings,
        () => leading(leases, 'learning-drain'),
        spending,
      );
      evaluator = new ProcedureEvaluator(jobs, contextualRuntime, runner.options);
      triggers = new TriggerService(jobs, runner);
      if (runs) runs.triggers = triggers;
      approvals = new ApprovalService(jobs, runner);
      if (submissions) replies = new ReplyService(jobs, submissions, runner);
      operations = new OperationService(jobs, runner);
      policy = new PolicyService(jobs, runner, {
        beforeKeyChange: releaseSandboxes,
        ...(sandboxTeardown ? { checkKeyChange: sandboxKeyCheck(sandboxTeardown) } : {}),
      });
      // Revocations a stopped process left part way finish now, in the
      // background: each can reach a provider, and its connection stays
      // inactive until it does.
      void policy
        .finishInterruptedRevocations()
        .catch((error: unknown) =>
          console.error(
            `connections: interrupted revocations were not checked (${error instanceof Error ? error.message : 'error'})`,
          ),
        );
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
          privacy,
          modelSettings,
          runs,
          spending,
          blobs: blobs?.store,
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
          // A space's sandboxes and snapshots go through providers built from
          // its connection rows, and the removal finishes only on what those
          // providers say they still hold.
          ...(removeSandboxes ? { sandboxes: removeSandboxes } : {}),
          // Blobs only this space referred to go with it.
          ...(blobs ? { blobs: blobs.store } : {}),
          // The worker stops, the profile goes, and the site rows with it.
          ...(browser ? { browser: browser.sessions } : {}),
          ...(env.MELETE_BROWSER_SPACE ? { browserSpace: env.MELETE_BROWSER_SPACE } : {}),
          // A cancelled job's runtime can still hold its workspace open; the
          // files phase stops it and waits for it before removing the workspace.
          ...(runner
            ? {
                stopJobs: async (jobIds: readonly string[]) => {
                  await runner?.stopJobs(jobIds);
                  // An attempt reports before its engine has stopped; the
                  // engine can hold the workspace until it has. Bounded like
                  // the runner's own wait.
                  await Promise.race([hermesRuntime?.released(jobIds), Bun.sleep(10_000)]);
                },
              }
            : {}),
        });
        // Resumed in the background: a removal waiting on a provider or a held
        // file does not hold up the listener, and a shutdown waits for it.
        if (options.workers !== false) removals.start();
      }
      if (options.workers !== false) {
        // A paired computer's screenshots an earlier version kept in job
        // workspaces move to the service's own store, and are tried again until
        // they have; each attempt also moves its own job's first.
        void moveWorkspaceScreensUntilDone(env.MELETE_WORK_DIR, {
          report: (line) => process.stderr.write(`${line}\n`),
        });
        await operations.start();
        await triggers.start();
        await runner.start();
        // Threads that deleted routines left behind before deleting a routine
        // took its thread go now, in the background.
        if (handle && jobs) {
          const removing = { jobs, sql: handle.sql, runner };
          void removeDeletedRoutineThreads(removing).catch(() => {
            process.stderr.write('removing the threads of deleted routines failed\n');
          });
        }
        if (handle && processFactory)
          processMonitor = startProcessMonitor(processFactory, handle.sql, triggers, () =>
            leading(leases, 'process-monitor'),
          );
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
        // Pushes to people's devices, when this installation has its VAPID keys.
        if (handle) {
          pushDispatcher = new PushDispatcher(
            new PushService(handle.db, pushConfig(env)),
            triggers.jobs.boss,
          );
          await pushDispatcher.start();
        }
      }
      if (options.workers === false) await replies?.recover();
      if (options.workers === false) await operations.recover();
    }
  } catch (error) {
    await close();
    throw error;
  }

  const sqlForHealth = handle?.sql;
  const checkDatabase = async () => {
    if (!handle) return 'not_configured' as const;
    return (await pingDatabase(handle)) ? ('ok' as const) : ('unreachable' as const);
  };
  const detail = () =>
    healthDetail({
      version: VERSION,
      database: checkDatabase,
      ...(runtimeProbe ? { runtime: runtimeProbe } : {}),
      ...(sqlForHealth ? { sql: sqlForHealth } : {}),
    });
  // The operator is told when the service turns unhealthy, where alerts are configured.
  if (options.workers !== false) {
    const senders = alertSendersFromEnv(env);
    if (senders.length) {
      healthMonitor = new HealthMonitor({
        check: detail,
        senders,
        intervalMs: env.MELETE_ALERT_INTERVAL_SECONDS * 1000,
        repeatMs: env.MELETE_ALERT_REPEAT_MINUTES * 60_000,
        onError: (error) => process.stderr.write(`alert not sent: ${error.message}\n`),
        leads: () => leading(leases, 'health-alerts'),
      });
      healthMonitor.start();
    }
  }

  const app = createApp({
    env,
    privacy,
    spending,
    healthDetail: detail,
    ...(blobs ? { blobs: blobs.store } : {}),
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
    sandboxComputers,
    sandboxPreviews,
    removals,
    episodes,
    proposer: learning?.proposer,
    evaluator,
    runtimeAdapter: options.runtime ? 'injected' : env.MELETE_RUNTIME_ADAPTER,
    runner,
    runs,
    broker: effectBoundary?.broker,
    registry,
    sql: handle?.sql,
    providerSignIn: signIn,
    modelSettings,
    voiceCompanion: voiceCompanion?.companion ?? null,
    checkDatabase,
    attachments,
    ...(handle ? { checkMemory: () => memoryHealth(handle.sql) } : {}),
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
    blobs: blobs?.store,
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

/**
 * The blob store this installation is configured for, and its collector, which
 * runs once a day where this process runs workers.
 */
function startBlobs(sql: Sql, env: Env, workers: boolean, leads: () => boolean | Promise<boolean>) {
  const store = configuredBlobStore(env);
  // Every instance may run workers; only the one holding the lease collects.
  const collector = new BlobCollector({ sql, store, leads });
  if (workers) collector.start();
  return { store, collector };
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
