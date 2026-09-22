/**
 * The sandbox providers this service can use, one entry each.
 *
 * A provider is a plugin: an adapter file that speaks to it, and one entry
 * here saying what it can do and how to open it. Nothing below reaches a
 * provider until a connection that selects it is opened, and the Modal SDK in
 * particular is imported only then, so an installation with no sandbox
 * connection never loads it.
 */
import type { SandboxAdapter } from '@melete/contracts';
import type { OpenedSandboxProvider, SandboxProviderOptions } from '../connection.ts';
import type { EgressPolicy, SandboxCapabilities } from '../types.ts';
import { createDaytonaProvider, daytonaCapabilities, daytonaEgressRefusal } from './daytona.ts';
import { createE2bProvider, e2bCapabilities } from './e2b.ts';
import { createModalProvider, modalCapabilities } from './modal.ts';
import { createModalSdkTransport } from './modal-sdk.ts';

/** The Modal app this installation's sandboxes live in. */
const modalAppNameFor = (project: string) => `melete-${project}`;

export type SandboxAdapterPlugin = {
  /** What the provider can enforce, which the manifest checks a configuration against. */
  capabilities(plan: 'hobby' | 'pro'): SandboxCapabilities;
  /** A provider for one connection; its key stays in the credential callback. */
  open(options: SandboxProviderOptions): OpenedSandboxProvider;
  /**
   * Why the provider cannot hold an egress policy its capabilities allow in
   * kind, or null; for limits finer than the manifest says, such as a range
   * count. Checked before a connection is installed.
   */
  egressRefusal?(egress: EgressPolicy): string | null;
};

export const SANDBOX_ADAPTER_PLUGINS: Record<SandboxAdapter, SandboxAdapterPlugin> = {
  e2b: {
    capabilities: (plan) => e2bCapabilities(plan),
    open(options) {
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
    },
  },
  daytona: {
    capabilities: () => daytonaCapabilities(),
    egressRefusal: daytonaEgressRefusal,
    open(options) {
      const retention = options.snapshotTtlSeconds;
      const provider = createDaytonaProvider({
        credential: (use) =>
          options.credential((value) =>
            'api_key' in value
              ? use(value.api_key)
              : Promise.reject(new Error('this connection holds no Daytona key')),
          ),
        // How long Daytona keeps a stopped workspace, in its own unit.
        ...(retention ? { stoppedRetentionMinutes: Math.ceil(retention / 60) } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return { provider, close: async () => {} };
    },
  },
  modal: {
    capabilities: () => modalCapabilities(),
    open(options) {
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
    },
  },
};
