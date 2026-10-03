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
   * How many guests the existing item this action changes has now, read from
   * the destination: the attendees of the event a `calendar.update` rewrites.
   * Throws when it cannot be read. Auto-review asks it before treating such a
   * change as one that reaches nobody but the person.
   */
  existingGuests?(action: Action, ctx: ConnectorContext): Promise<number>;
  /**
   * Present when this connector is a generative capability rather than a reach
   * into something that already exists. It carries the cost and the mime type
   * the call produces, both from trusted configuration.
   */
  capability?: CapabilityManifest;
  /** Trusted discovery metadata: source, examples and core priorities. Never from a tool result. */
  catalog?: CatalogMetadata;
  /**
   * For an installed MCP server: whether the server declares this tool
   * read-only. Only then is a read of it whose answer never came settled as
   * failed; without it, the person is asked, as for any other effect.
   */
  readOnlyDeclared?(kind: string): boolean;
  execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult>;
  /**
   * What a dispatch is settled as when the process that sent it ended before
   * its answer came back. Called only for such orphaned dispatches, and only
   * for a connector that opts in by defining it: a command in the agent's own
   * sandbox can read its marker. It returns `failed` only when that record
   * shows the step never started; anything still open stays `unknown`, so a
   * late receipt can still land. Without it, such a dispatch is unknown.
   */
  abandoned?(action: Action, ctx: ConnectorContext): Promise<DispatchResult>;
  /**
   * Its steps run on the agent's own computer. An outcome left open stays
   * `unknown`, but it is the agent's to check (a screenshot, the page, what a
   * command left behind), so the person is never asked whether it worked.
   */
  ownComputer?: boolean;
  /**
   * How long one dispatch of this action may take before its outcome is
   * unknown, for a connector whose work may outlast the broker's own dispatch
   * timeout: a command the admitted payload gives two minutes. The broker
   * never waits less than its own timeout, whatever this says.
   */
  dispatchBudgetMs?(action: Pick<Action, 'kind' | 'canonical_payload'>): number;
  /**
   * True when this particular action needs the person's approval although its
   * tool alone does not, because of what the payload names: opening an
   * address on the person's own network, for one. It can only add a question,
   * never remove one.
   */
  asksFirst?(action: Pick<Action, 'kind' | 'canonical_payload'>): boolean;
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
   * Present only when the installation declared a ledger feed. Reads that feed
   * once, as a `read` of the declared tool, and returns what the tool answered.
   * Authority is re-read first, exactly as for `execute`; the service, never a
   * job, calls it, and what comes back is still checked item by item.
   */
  ledgerFeed?(signal?: AbortSignal): Promise<JsonObject>;
  /**
   * Equivalent authorized routes for the SAME operation, best first. Consulted
   * only after a route said definitively that it did not execute.
   */
  routes?(action: Action, ctx: ConnectorContext): Promise<string[]>;
  close?(): Promise<void>;
  /**
   * In place of `close` when the connection itself is gone: stop, then
   * release what only this connection owned, such as its kept data. The
   * registry calls it on removal; shutdown never does.
   */
  retire?(): Promise<void>;
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
