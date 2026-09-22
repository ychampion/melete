/**
 * What a sandbox connection holds, and what it builds.
 *
 * The row keeps the adapter, the image, the egress policy, what a sandbox
 * keeps between attempts and how long one may run. The provider key is sealed
 * and lent one call at a time; nothing here reads it, prints it or returns it.
 *
 * A configuration is checked against the adapter's own manifest before a row
 * exists, so a request for something the provider cannot honour is refused
 * rather than quietly widened: an allow-list on a provider without one, a
 * lifetime past its maximum, a region it does not place in, or persistence it
 * does not offer.
 */
import {
  modalTokenParts,
  type SandboxAdapter,
  type SandboxConnectionConfig,
  sandboxAdapter,
  sandboxConnectionConfig,
  sandboxCredentials,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { SecretAccess } from '../connectors/secrets.ts';
import { createE2bProvider, e2bCapabilities } from './adapters/e2b.ts';
import { createModalProvider, modalCapabilities } from './adapters/modal.ts';
import { createModalSdkTransport } from './adapters/modal-sdk.ts';
import { checkSpec, sandboxLabels } from './manifest.ts';
import type { EgressPolicy, SandboxCapabilities, SandboxProvider, SandboxSpec } from './types.ts';

/** What `POST /connections` stores for a sandbox: never the key. */
export const storedSandboxConnection = z
  .object({ kind: z.literal('sandbox'), sandbox: sandboxConnectionConfig })
  .strict();

export type SandboxCredentialValue =
  | { api_key: string }
  | { token_id: string; token_secret: string };
/** Lends the sealed provider credential for as long as `use` runs. */
export type SandboxCredential = <T>(
  use: (value: SandboxCredentialValue) => Promise<T>,
) => Promise<T>;

export type SandboxProviderOptions = {
  credential: SandboxCredential;
  /** The `melete.project` label: which installation owns a sandbox. */
  project: string;
  /** E2B's lifetime maximum follows the account's plan. */
  e2bPlan?: 'hobby' | 'pro';
  /** How long Modal keeps a workspace snapshot this service never deletes. */
  snapshotTtlSeconds?: number | null;
  /** Replaces E2B's HTTP transport. Only a test fixture passes one. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

/** A sandbox id no provider will have, for asking whether a key is accepted at all. */
const PROBE_SANDBOX_ID = 'sb-melete-installation-probe';

export const sandboxEgressPolicy = (config: SandboxConnectionConfig): EgressPolicy =>
  config.egress === 'cidr_allowlist'
    ? { kind: 'cidr_allowlist', cidrs: [...(config.cidrs ?? [])] }
    : { kind: config.egress };

export function sandboxCapabilitiesFor(
  config: SandboxConnectionConfig,
  plan: 'hobby' | 'pro' = 'hobby',
): SandboxCapabilities {
  return config.adapter === 'e2b' ? e2bCapabilities(plan) : modalCapabilities();
}

export const modalAppNameFor = (project: string) => `melete-${project}`;

/**
 * The spec one session opens with. `session` is the id the sandbox is labelled
 * with, so a sandbox always names the row that owns it.
 */
export function sandboxSpecFor(
  config: SandboxConnectionConfig,
  ids: {
    project: string;
    /** The connection whose account this sandbox lives in. */
    connectionId: string;
    spaceId: string;
    jobId?: string | null;
    attemptId?: string | null;
    session: string;
  },
): SandboxSpec {
  return {
    image: config.image,
    egress: sandboxEgressPolicy(config),
    region: config.region ?? null,
    lifetimeSeconds: config.lifetime_seconds,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({
      project: ids.project,
      connection: ids.connectionId,
      space: ids.spaceId,
      job: ids.jobId ?? null,
      attempt: ids.attemptId ?? null,
      session: ids.session,
    }),
    env: { LANG: 'C.UTF-8' },
  };
}

/**
 * Throws `SandboxRefusal` when the adapter's manifest cannot honour this
 * configuration. Called before a row is written and again whenever a session
 * opens, so a manifest that narrows later still refuses.
 */
export function checkSandboxConfiguration(
  config: SandboxConnectionConfig,
  options: { project: string; spaceId: string; plan?: 'hobby' | 'pro' },
): void {
  const capabilities = sandboxCapabilitiesFor(config, options.plan);
  checkSpec(
    capabilities,
    sandboxSpecFor(config, {
      project: options.project,
      // A configuration is checked before its connection exists, so the two
      // identifiers a manifest never judges by value stand in for themselves.
      connectionId: 'conn_00000000000000000000000000',
      spaceId: options.spaceId,
      session: 'sbx_00000000000000000000000000',
    }),
    config.persistence,
  );
}

export type OpenedSandboxProvider = { provider: SandboxProvider; close(): Promise<void> };

/** Build the provider a sandbox connection selects. The key stays in the callback. */
export function createSandboxProvider(
  config: Pick<SandboxConnectionConfig, 'adapter'>,
  options: SandboxProviderOptions,
): OpenedSandboxProvider {
  if (config.adapter === 'e2b') {
    const provider = createE2bProvider({
      credential: (use) =>
        options.credential((value) =>
          'api_key' in value
            ? use(value.api_key)
            : Promise.reject(new Error('this connection holds no E2B key')),
        ),
      ...(options.e2bPlan ? { plan: options.e2bPlan } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return { provider, close: async () => {} };
  }
  const transport = createModalSdkTransport({
    credential: (use) =>
      options.credential((value) =>
        'token_id' in value
          ? use({ tokenId: value.token_id, tokenSecret: value.token_secret })
          : Promise.reject(new Error('this connection holds no Modal token')),
      ),
  });
  const provider = createModalProvider({
    transport,
    appName: modalAppNameFor(options.project),
    ...(options.snapshotTtlSeconds === undefined
      ? {}
      : { snapshotTtlSeconds: options.snapshotTtlSeconds }),
  });
  return { provider, close: async () => provider.close() };
}

export type SandboxTeardownOptions = Omit<SandboxProviderOptions, 'credential'> & {
  sql: Sql;
  secrets: SecretAccess;
  /** Set when this environment could redirect Modal's traffic; then Modal is refused. */
  modalRefusal?: string | null;
  /** Builds the provider for an adapter. Only a test replaces it. */
  open?: typeof createSandboxProvider;
};

/**
 * Providers for tearing down a connection's sandboxes, built from its row when
 * they are asked for rather than taken from the connectors this process
 * serves. A space under removal serves no connectors, and its sandboxes and
 * snapshots still have to go.
 *
 * Nothing reaches a provider until the row has been read again and still names
 * a sandbox connection with that adapter and a key, so an identifier that no
 * longer means what it did is refused rather than handed to whichever provider
 * it resembles.
 */
export function sandboxTeardownProviders(options: SandboxTeardownOptions): {
  providerFor(adapter: string, connectionId: string): SandboxProvider;
  close(): Promise<void>;
} {
  const opened = new Map<string, OpenedSandboxProvider>();
  const holding = async (adapter: SandboxAdapter, connectionId: string) => {
    const [row] = await options.sql`select space_id, provider, secret_ref, configuration
      from connection where id = ${connectionId}`;
    const stored = storedSandboxConnection.safeParse(row?.configuration);
    if (row?.provider !== 'sandbox' || !stored.success)
      throw new Error(`connection ${connectionId} is not a sandbox connection`);
    if (stored.data.sandbox.adapter !== adapter)
      throw new Error(
        `connection ${connectionId} holds the ${stored.data.sandbox.adapter} adapter, not ${adapter}`,
      );
    if (!row.secret_ref)
      throw new Error(`connection ${connectionId} no longer holds a provider key`);
    return { spaceId: String(row.space_id), secretRef: String(row.secret_ref) };
  };
  return {
    providerFor(name, connectionId) {
      const adapter = sandboxAdapter.parse(name);
      if (adapter === 'modal' && options.modalRefusal) throw new Error(options.modalRefusal);
      const key = `${connectionId}:${adapter}`;
      let entry = opened.get(key);
      if (!entry) {
        const { sql: _sql, secrets, modalRefusal: _refusal, open, ...settings } = options;
        entry = (open ?? createSandboxProvider)(
          { adapter },
          {
            ...settings,
            credential: async (use) => {
              const held = await holding(adapter, connectionId);
              return secrets.withSecret(held.secretRef, held.spaceId, (sealed) =>
                use(sandboxCredentialValue(adapter, sealed)),
              );
            },
          },
        );
        opened.set(key, entry);
      }
      const inner = entry.provider;
      // Every call waits on the row check first, the ones that never read a
      // key included.
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            await holding(adapter, connectionId);
            return value.apply(target, args);
          };
        },
      });
    },
    async close() {
      const all = [...opened.values()];
      opened.clear();
      await Promise.all(all.map((entry) => entry.close()));
    },
  };
}

/** The sealed credential, read as the adapter that needs it. Never logged. */
export function sandboxCredentialValue(
  adapter: SandboxAdapter,
  sealed: string,
): SandboxCredentialValue {
  const { api_key } = sandboxCredentials.parse(JSON.parse(sealed) as unknown);
  if (adapter === 'e2b') return { api_key };
  const parts = modalTokenParts(api_key);
  if (!parts) throw new Error('this connection holds no Modal token');
  return parts;
}

/**
 * Which environment settings could put something between this service and
 * Modal, since its gRPC transport reads them itself. The wiring decides what
 * to do about them; the adapter never looks.
 */
export const PROXY_ENVIRONMENT_KEYS = [
  'grpc_proxy',
  'https_proxy',
  'http_proxy',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
] as const;

/**
 * Why the Modal adapter must not be built in this environment, or null. A
 * proxy or a replaced root-certificate file would see or re-root the token's
 * traffic, so it is refused unless the operator opted in.
 */
export function modalEnvironmentRefusal(
  source: Record<string, string | undefined>,
  allowed: boolean,
): string | null {
  const set = PROXY_ENVIRONMENT_KEYS.filter((key) => (source[key] ?? '').length > 0);
  if (!set.length || allowed) return null;
  return `this service's environment sets ${set.join(', ')}, which Modal's gRPC transport follows; set MELETE_SANDBOX_ALLOW_PROXY_ENVIRONMENT=true if that proxy and its trust anchors are yours`;
}

/**
 * Ask the provider about a sandbox it cannot have. A key it accepts answers
 * `gone`; a key it refuses raises, and the caller says only that much. No
 * sandbox is created, and nothing is destroyed.
 */
export async function probeSandboxProvider(
  provider: SandboxProvider,
  signal: AbortSignal,
): Promise<'ok' | 'unavailable'> {
  try {
    await provider.inspect(
      { providerSandboxId: PROBE_SANDBOX_ID, imageDigest: null, region: null },
      signal,
    );
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
