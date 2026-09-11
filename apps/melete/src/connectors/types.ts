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
}
