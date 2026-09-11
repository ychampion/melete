import type {
  Action,
  CapabilityManifest,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JobConstraints,
  VerifyResult,
} from '@melete/contracts';

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
  /**
   * Present when this connector is a generative capability rather than a reach
   * into something that already exists. It carries the cost and the mime type
   * the call produces, both from trusted configuration.
   */
  capability?: CapabilityManifest;
  execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
}
