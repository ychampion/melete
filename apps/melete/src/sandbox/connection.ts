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
  sandboxConnectionConfig,
  sandboxCredentials,
} from '@melete/contracts';
import { z } from 'zod';
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
      spaceId: options.spaceId,
      session: 'sbx_00000000000000000000000000',
    }),
    config.persistence,
  );
}

export type OpenedSandboxProvider = { provider: SandboxProvider; close(): Promise<void> };

/** Build the provider a sandbox connection selects. The key stays in the callback. */
export function createSandboxProvider(
  config: SandboxConnectionConfig,
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
