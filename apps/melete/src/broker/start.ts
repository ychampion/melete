import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import { loadSkills } from '@melete/skills';
import {
  type ConfiguredConnection,
  configuredBrowserSessions,
  connectorsFromEnv,
  readConnectionConfig,
} from '../connectors/configured.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { DatabaseHandle } from '../db/client.ts';
import { type Env, parseBrokerBind } from '../env.ts';
import {
  recordChaseScope,
  resolveChaseGrant,
  resolvePersonGrant,
} from '../experience/chase-scope.ts';
import { configuredProviders, providerSignIn } from '../gateway/configured.ts';
import type { ProviderSignIn } from '../gateway/credentials.ts';
import type { GatewayOptions } from '../gateway/index.ts';
import { startQueue } from '../jobs/queue.ts';
import { filesystemSpaces } from '../knowledge/spaces.ts';
import { createMemoryTrustResolver } from '../memory/broker-trust.ts';
import type { BrowserSessionService } from '../workers/browser/routes.ts';
import type { EffectAuthorityResolver } from './authority.ts';
import type { ComposeExecutor } from './compose.ts';
import { createInternalServer } from './internal-server.ts';
import type { BrokerService } from './service.ts';
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
  } = {},
) {
  if (!env.MELETE_CAPABILITY_KEY || !env.MELETE_APPROVAL_KEY || !env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL, MELETE_CAPABILITY_KEY and MELETE_APPROVAL_KEY are required for the effect boundary',
    );
  }
  const binding = parseBrokerBind(env.MELETE_BROKER_BIND);
  if (!binding) throw new Error('MELETE_BROKER_BIND must be hostname:port');
  const { hostname, port } = binding;
  const providers = configuredProviders(
    env,
    undefined,
    dependencies.signIn ?? providerSignIn(handle.sql, env),
  );
  const connections =
    dependencies.connections ?? (await readConnectionConfig(env.MELETE_CONNECTIONS_FILE));
  const browser = dependencies.browserSessions
    ? undefined
    : await configuredBrowserSessions({ sql: handle.sql, env, connections });
  const registry =
    dependencies.registry ??
    (await connectorsFromEnv(handle.sql, env, {
      connections,
      browserSessions: dependencies.browserSessions ?? browser?.sessions,
    }));
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined;
  try {
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
      defaultProvider: env.MELETE_DEFAULT_PROVIDER,
      defaultMaxTokens: env.MELETE_DEFAULT_MAX_OUTPUT_TOKENS,
      fake: env.MELETE_ENABLE_FAKE_PROVIDER ? dependencies.fakeProvider : undefined,
      connectTls: (host) => certificates.get(host),
      resolveAuthority: dependencies.resolveAuthority,
      resolveTrust: dependencies.resolveTrust ?? createMemoryTrustResolver(),
      resolveStandingGrant: resolvePersonGrant,
      resolveScopedGrant: resolveChaseGrant,
      recordStandingScope: recordChaseScope,
      broker: dependencies.broker,
      composeExecutor: dependencies.composeExecutor,
      catalog: {
        skills: async (spaceId) =>
          loadSkills({ spaceSkillsDirectory: (await spaces.byId(spaceId))?.paths.skills }).skills,
      },
    });
    await internal.broker.recoverDispatched();
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
    }, 15_000);
    recovery.unref();
    return {
      ...internal,
      registry,
      close: async () => {
        clearInterval(recovery);
        await new Promise<void>((resolve) => internal.server.close(() => resolve()));
        try {
          await activeQueue.stop();
        } finally {
          try {
            await registry.close();
          } finally {
            await browser?.pool.close();
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
        await browser?.pool.close();
      }
    }
    throw error;
  }
}
