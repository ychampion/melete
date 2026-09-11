import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import { configuredConnectors, readConnectionConfig } from '../connectors/configured.ts';
import type { DatabaseHandle } from '../db/client.ts';
import type { Env } from '../env.ts';
import { fakeProvider, providersFromEnv } from '../gateway/index.ts';
import { startQueue } from '../jobs/queue.ts';
import { createMemoryTrustResolver } from '../memory/broker-trust.ts';
import type { EffectAuthorityResolver } from './authority.ts';
import { createInternalServer } from './internal-server.ts';
import type { TrustResolver } from './trust.ts';

/** Start only the effect listener; the API keeps its own port and authentication surface. */
export async function startEffectBoundary(
  handle: DatabaseHandle,
  env: Env,
  dependencies: {
    resolveAuthority?: EffectAuthorityResolver;
    /** Left out, memory answers. Pass one to isolate the broker in a test. */
    resolveTrust?: TrustResolver;
  } = {},
) {
  if (!env.MELETE_CAPABILITY_KEY || !env.MELETE_APPROVAL_KEY || !env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL, MELETE_CAPABILITY_KEY and MELETE_APPROVAL_KEY are required for the effect boundary',
    );
  }
  const binding = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(env.MELETE_BROKER_BIND);
  if (!binding?.[1] || !binding[2] || Number(binding[2]) > 65535 || Number(binding[2]) < 1) {
    throw new Error('MELETE_BROKER_BIND must be hostname:port');
  }
  const hostname = binding[1].replace(/^\[|\]$/g, '');
  const port = Number(binding[2]);
  const registry = await configuredConnectors({
    sql: handle.sql,
    workRoot: env.MELETE_WORK_DIR,
    spacesRoot: env.MELETE_SPACES_DIR,
    masterKey: env.MELETE_MASTER_KEY,
    connections: await readConnectionConfig(env.MELETE_CONNECTIONS_FILE),
    enableTestConnector: env.MELETE_ENABLE_TEST_CONNECTOR,
  });
  const providers = [
    ...providersFromEnv({
      FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: env.GOOGLE_API_KEY,
      OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
      OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
    }),
    ...(env.MELETE_ENABLE_FAKE_PROVIDER ? [fakeProvider] : []),
  ];
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
  const queue = await startQueue(env.DATABASE_URL);
  queue.boss.on('error', () => process.stderr.write('effect queue error\n'));
  const internal = createInternalServer({
    sql: handle.sql,
    connectors: registry,
    capabilityKey: env.MELETE_CAPABILITY_KEY,
    approvalKey: env.MELETE_APPROVAL_KEY,
    boss: queue.boss,
    providers,
    defaultProvider: env.MELETE_DEFAULT_PROVIDER,
    connectTls: (host) => certificates.get(host),
    resolveAuthority: dependencies.resolveAuthority,
    resolveTrust: dependencies.resolveTrust ?? createMemoryTrustResolver(),
  });
  try {
    await internal.broker.recoverDispatched();
    await new Promise<void>((resolve, reject) => {
      internal.server.once('error', reject);
      internal.server.listen(port, hostname, resolve);
    });
  } catch (error) {
    await queue.stop();
    throw error;
  }
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
      await queue.stop();
    },
  };
}
