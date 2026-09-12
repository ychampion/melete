import type {
  Action,
  CapabilityManifest,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JobConstraints,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import type { CatalogMetadata } from '../broker/catalog.ts';
import type { Query } from '../broker/records.ts';
import type { ConnectorDescription, RepairAttemptContext } from './faults.ts';

/** Trusted service context, assembled from persisted job state, never tool arguments. */
export type ConnectorContext = {
  job_id: string;
  space_id: string;
  idempotency_key: string;
  constraints: JobConstraints;
  signal?: AbortSignal;
  /**
   * Present only on a repaired re-execution. A connector may read it to take
   * the route the policy authorized; it is never a way to change what is sent.
   */
  repair?: RepairAttemptContext;
};

export interface Connector {
  manifest: ConnectorManifest;
  /** Resolve trusted resource identities before hashing an approval payload. */
  prepare?(payload: JsonObject, ctx: ConnectorContext, tx: Query): Promise<JsonObject>;
  /** Recheck bound resources under the admission/dispatch transaction. */
  validateBinding?(action: Action, ctx: ConnectorContext, tx: Query): Promise<void>;
  /**
   * Present when this connector is a generative capability rather than a reach
   * into something that already exists. It carries the cost and the mime type
   * the call produces, both from trusted configuration.
   */
  capability?: CapabilityManifest;
  /** Trusted discovery metadata: source, examples and core priorities. Never from a tool result. */
  catalog?: CatalogMetadata;
  execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult>;
  health(): Promise<ConnectorHealth>;
  /**
   * The shape the destination wants now. Answered after a `schema_drift` fault
   * so the policy can compare it with what was sent and propose a mapping. A
   * connector without one simply cannot be repaired that way.
   */
  describe?(action: Action, ctx: ConnectorContext): Promise<ConnectorDescription>;
  /**
   * Refresh a stale credential through the credential store. True when a fresh
   * credential is in hand; false when the grant is gone and nothing was
   * refreshed. It never substitutes a different identity.
   */
  refreshCredential?(action: Action, ctx: ConnectorContext): Promise<boolean>;
  /** Reopen a transport only after repair has proved the previous call did not execute. */
  reconnect?(action: Action, ctx: ConnectorContext): Promise<void>;
  /**
   * Equivalent authorized routes for the SAME operation, best first. Consulted
   * only after a route said definitively that it did not execute.
   */
  routes?(action: Action, ctx: ConnectorContext): Promise<string[]>;
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
