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
import type { Declaration, ReversalPlan } from '../broker/reversals.ts';
import type { SignalSource } from '../signals/types.ts';
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
  /**
   * Set by the broker when this action was let through only because what it
   * makes is new in the person's space (`staysInSpace`), with no approval and
   * no standing permission behind it. The connector must then not replace
   * anything that has appeared at that name since.
   */
  only_new?: boolean;
};

export interface Connector {
  manifest: ConnectorManifest;
  /**
   * Resolve trusted resource identities before hashing an approval payload.
   * `kind` is the tool asked for, for tools whose payloads look alike.
   */
  prepare?(
    payload: JsonObject,
    ctx: ConnectorContext,
    tx: Query,
    kind?: string,
  ): Promise<JsonObject>;
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
  /**
   * True when this particular action stays in the person's own space, where
   * they can open and delete it, although its tool can also reach outside: an
   * artifact saved to the space rather than emailed. It is then treated as
   * work in the agent's own workspace, under the person's own settings.
   */
  staysInSpace?(action: Pick<Action, 'kind' | 'canonical_payload'>, spaceId: string): boolean;
  /**
   * Payload paths (as `collectOriginFields` names them) whose values this
   * connector proved itself before anyone was asked, and proves again in
   * `validateBinding`: a file it checked is the person's own. Where such a value
   * came from in the conversation then says nothing more, so the broker leaves
   * it out of origin checking. Only `resource` fields are ever left out; a
   * recipient, destination or amount is always checked.
   */
  verifiedFields?(action: Pick<Action, 'kind' | 'canonical_payload'>): readonly string[];
  health(): Promise<ConnectorHealth>;
  /**
   * For a connected app's own tools, which the built-in list in
   * `broker/reversals.ts` does not know: how one of them is taken back
   * (`reversal`, `compensation`, `hold` or `none`). Left out, it is `none`.
   */
  reversalDeclared?(kind: string): Declaration | null;
  /**
   * The reversal or compensation for one of its own changes that succeeded,
   * built from that change's receipt and payload only. Null when it has none.
   */
  reversal?(action: Action): ReversalPlan | null;
  /**
   * How the signal poller reads what changed in this account: new mail, or the
   * occurrences on a calendar. Only reads; a connector without it is never
   * polled.
   */
  signals?: SignalSource;
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
  /**
   * In place of `close` when the connection itself is gone: stop, then
   * release what only this connection owned, such as its kept data. The
   * registry calls it on removal; shutdown never does.
   */
  retire?(): Promise<void>;
}

/**
 * An installed account is unavailable to public compartments. It serves its own
 * person's space, or a room's space when the room's owners added it there; which
 * jobs in a room it serves is the `shared_use` rule's to say.
 */
export function connectorAllowsAudience(
  connector: Connector,
  constraints: JobConstraints,
  audience: string,
): boolean {
  if (!connector.catalog?.audience) return true;
  if (constraints.public_compartment) return false;
  return audience === connector.catalog.audience || audience === 'space';
}
