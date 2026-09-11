import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JobConstraints,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import type { Query } from '../broker/records.ts';

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
  /** Resolve trusted resource identities before hashing an approval payload. */
  prepare?(payload: JsonObject, ctx: ConnectorContext, tx: Query): Promise<JsonObject>;
  /** Recheck bound resources under the admission/dispatch transaction. */
  validateBinding?(action: Action, ctx: ConnectorContext, tx: Query): Promise<void>;
  execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
}
