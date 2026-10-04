import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import { loadSkills } from '@melete/skills';
import { gatewayAttachments } from '../attachments/model.ts';
import {
  type ConfiguredConnection,
  configuredBrowserSessions,
  connectorsFromEnv,
  readConnectionConfig,
} from '../connectors/configured.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { webSearchFromEnv } from '../connectors/web-search.ts';
import type { DatabaseHandle } from '../db/client.ts';
import { bindEgressAdmission } from '../egress/credentials.ts';
import { type Env, parseBrokerBind } from '../env.ts';
import {
  chaseFollowUpPort,
  recordChaseScope,
  resolveChaseScopedGrant,
  resolvePersonGrant,
} from '../experience/chase-scope.ts';
import { configuredProviders, providerSignIn } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import type { GatewayOptions } from '../gateway/index.ts';
import { ModelSettingsService } from '../gateway/model-settings.ts';
import { routingFromEnv } from '../gateway/routing.ts';
import { type SpendingGuard, spendingFromEnv } from '../gateway/spending.ts';
import { startQueue } from '../jobs/queue.ts';
import { filesystemSpaces } from '../knowledge/spaces.ts';
import { createMemoryTrustResolver } from '../memory/broker-trust.ts';
import type { PrivacyRouter } from '../privacy/router.ts';
import type { BlobStore } from '../storage/blob.ts';
import type { BrowserSessionService } from '../workers/browser/routes.ts';
import type { EffectAuthorityResolver } from './authority.ts';
import type { ComposeExecutor } from './compose.ts';
import { egressAdmission } from './egress-admission.ts';
import { createInternalServer } from './internal-server.ts';
import { configuredReviewGateway } from './review-gateway.ts';
import { configuredSearchGateway } from './search-gateway.ts';
import type { BrokerOptions, BrokerService } from './service.ts';
import type { TrustResolver } from './trust.ts';

/** Start only the effect listener; the API keeps its own port and authentication surface. */
export async function startEffectBoundary(
  handle: DatabaseHandle,
  env: Env,
  dependencies: {
    resolveAuthority?: EffectAuthorityResolver;
    /** Left out, memory answers. Pass one to isolate the broker in a test. */
    resolveTrust?: TrustResolver;
    /** Service-owned cell execution; never selected by runtime tool arguments. */
    composeExecutor?: ComposeExecutor;
    browserSessions?: BrowserSessionService;
    connections?: ConfiguredConnection[];
    fakeProvider?: GatewayOptions['fake'];
    /** A broker and registry the service already built, so both listeners share them. */
    broker?: BrokerService;
    registry?: ConnectorRegistry;
    /** The owner's provider sign-ins, shared with the API that manages them. */
    signIn?: ProviderSignIn;
    /** The service's privacy router: what model requests may carry and where they go. */
    privacy: PrivacyRouter;
    /** The model connected in the app; left out, read from this database. */
    modelSettings?: ModelSettingsService;
    /** Long work's tools. */
    runs?: BrokerOptions['runs'];
    /** The installation's spending caps, shared by every gateway of the service. */
    spending?: SpendingGuard;
    /** Where the files people send in chat are kept, for the gateway to show the model. */
    blobs?: BlobStore;
  },
) {
  if (!env.MELETE_CAPABILITY_KEY || !env.MELETE_APPROVAL_KEY || !env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL, MELETE_CAPABILITY_KEY and MELETE_APPROVAL_KEY are required for the effect boundary',
    );
  }
  const binding = parseBrokerBind(env.MELETE_BROKER_BIND);
  if (!binding) throw new Error('MELETE_BROKER_BIND must be hostname:port');
  const { hostname, port } = binding;
  const signIn = dependencies.signIn ?? providerSignIn(handle.sql, env);
  const providers = configuredProviders(env, undefined, signIn);
  // Keys and endpoints the owner connects in the app join per model call.
  const modelSettings =
    dependencies.modelSettings ?? new ModelSettingsService({ db: handle.db, env, signIn });
  const connections =
    dependencies.connections ?? (await readConnectionConfig(env.MELETE_CONNECTIONS_FILE));
  const browser = dependencies.browserSessions
    ? undefined
    : await configuredBrowserSessions({ sql: handle.sql, env, connections });
  const spending = dependencies.spending ?? spendingFromEnv(handle.sql, env);
  // The model's own web search, metered on the job, for a registry built here.
  const search = dependencies.registry
    ? undefined
    : await configuredSearchGateway(handle.sql, env, dependencies.privacy, {
        signIn,
        settings: modelSettings,
        spending,
      });
  const registry =
    dependencies.registry ??
    (await connectorsFromEnv(handle.sql, env, {
      connections,
      browserSessions: dependencies.browserSessions ?? browser?.sessions,
      privateContext: ({ spaceId, agentId }, query) =>
        dependencies.privacy.marksPrivate(spaceId, agentId, query),
      webSearch: webSearchFromEnv(env, { native: search?.backend }),
      spending,
      searchPrivacy: ({ jobId, query }) => dependencies.privacy.outsideSearchRefusal(jobId, query),
    }));
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined;
  let review: Awaited<ReturnType<typeof configuredReviewGateway>> | undefined;
  const routing = routingFromEnv(env);
  try {
    review = await configuredReviewGateway(
      env,
      dependencies.privacy,
      dependencies.signIn ?? providerSignIn(handle.sql, env),
      env.MELETE_ENABLE_FAKE_PROVIDER ? dependencies.fakeProvider : undefined,
      { settings: modelSettings, spending },
    );
    const certificates = new Map<string, Pick<SecureContextOptions, 'key' | 'cert'>>();
    if (env.MELETE_GATEWAY_TLS_DIR) {
      for (const host of new Set(
        providers
          .filter((provider) => !provider.fake)
          .map((provider) => new URL(provider.baseUrl).hostname),
      )) {
        try {
          certificates.set(host, {
            key: await readFile(join(env.MELETE_GATEWAY_TLS_DIR, `${host}.key.pem`)),
            cert: await readFile(join(env.MELETE_GATEWAY_TLS_DIR, `${host}.cert.pem`)),
          });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    }
    queue = await startQueue(env.DATABASE_URL);
    const activeQueue = queue;
    const spaces = filesystemSpaces(env.MELETE_SPACES_DIR);
    queue.boss.on('error', () => process.stderr.write('effect queue error\n'));
    const internal = createInternalServer({
      artifactRoots: { workRoot: env.MELETE_WORK_DIR, spacesRoot: env.MELETE_SPACES_DIR },
      sql: handle.sql,
      connectors: registry,
      capabilityKey: env.MELETE_CAPABILITY_KEY,
      approvalKey: env.MELETE_APPROVAL_KEY,
      deferApprovalWaitToRunner: true,
      boss: queue.boss,
      providers,
      currentProviders: (configured) => modelSettings.providers(configured),
      defaultProvider: env.MELETE_DEFAULT_PROVIDER,
      defaultMaxTokens: env.MELETE_DEFAULT_MAX_OUTPUT_TOKENS,
      fake: env.MELETE_ENABLE_FAKE_PROVIDER ? dependencies.fakeProvider : undefined,
      connectTls: (host) => certificates.get(host),
      privacy: dependencies.privacy,
      spending,
      ...(env.MELETE_JOB_USD_COUNTS_MODELS ? { modelDollars: spending.prices } : {}),
      routes: (attempt) => modelSettings.attemptRoutes(routing, attempt),
      reasoningEffort: env.MELETE_REASONING_EFFORT_AGENT,
      ...(dependencies.blobs
        ? {
            attachments: gatewayAttachments(handle.sql, dependencies.blobs, (provider, model) =>
              modelSettings.visionFor(provider, model),
            ),
          }
        : {}),
      resolveAuthority: dependencies.resolveAuthority,
      resolveTrust: dependencies.resolveTrust ?? createMemoryTrustResolver(),
      resolveStandingGrant: resolvePersonGrant,
      resolveScopedGrant: resolveChaseScopedGrant,
      recordStandingScope: recordChaseScope,
      chaseFollowUp: chaseFollowUpPort,
      runs: dependencies.runs,
      autoReview: {
        reviewer: review?.reviewer ?? null,
        timeoutMs: env.MELETE_REVIEW_TIMEOUT_MS,
        hourlyLimit: env.MELETE_REVIEW_HOURLY_LIMIT,
      },
      broker: dependencies.broker,
      composeExecutor: dependencies.composeExecutor,
      catalog: {
        skills: async (spaceId) =>
          loadSkills({ spaceSkillsDirectory: (await spaces.byId(spaceId))?.paths.skills }).skills,
      },
    });
    await internal.broker.recoverDispatched();
    // Changes a command makes with a connected account are admitted by this broker.
    const unbindEgress = bindEgressAdmission(egressAdmission(internal.broker));
    await new Promise<void>((resolve, reject) => {
      internal.server.once('error', reject);
      internal.server.listen(port, hostname, resolve);
    });
    const recovery = setInterval(() => {
      void internal.broker
        .recoverDispatched()
        .catch(() => process.stderr.write('action recovery failed\n'));
      // A parked action comes back on its own clock, not on a worker's patience.
      void internal.broker
        .resumeParked()
        .catch(() => process.stderr.write('parked action resume failed\n'));
      // A review a restart cut short goes to the person instead of waiting forever.
      void internal.broker
        .escalateStaleReviews(env.MELETE_REVIEW_TIMEOUT_MS * 2 + 15_000)
        .catch(() => process.stderr.write('stale review escalation failed\n'));
    }, 15_000);
    recovery.unref();
    return {
      ...internal,
      registry,
      close: async () => {
        clearInterval(recovery);
        unbindEgress();
        await new Promise<void>((resolve) => internal.server.close(() => resolve()));
        try {
          await activeQueue.stop();
        } finally {
          try {
            await registry.close();
          } finally {
            try {
              await browser?.pool.close();
            } finally {
              try {
                await review?.close();
              } finally {
                await search?.close();
              }
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      await queue?.stop();
    } finally {
      try {
        await registry.close();
      } finally {
        try {
          await browser?.pool.close();
        } finally {
          try {
            await review?.close();
          } finally {
            await search?.close();
          }
        }
      }
    }
    throw error;
  }
}
