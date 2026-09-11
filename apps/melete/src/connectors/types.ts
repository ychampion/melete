import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JobConstraints,
  VerifyResult,
} from '@melete/contracts';
import type { CatalogMetadata } from '../broker/catalog.ts';

/** Trusted service context, assembled from persisted job state, never tool arguments. */
export type ConnectorContext = {
  job_id: string;
  space_id: string;
  idempotency_key: string;
  constraints: JobConstraints;
  signal?: AbortSignal;
};

export interface Connector {
  manifest: ConnectorManifest;
  catalog?: CatalogMetadata;
  execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
  close?(): Promise<void>;
}

/** An operator's owner-only installation is unavailable to public compartments. */
export function connectorAllowsAudience(
  connector: Connector,
  constraints: JobConstraints,
  audience: string,
): boolean {
  return (
    !connector.catalog?.audience ||
    (connector.catalog.audience === audience && !constraints.public_compartment)
  );
}
