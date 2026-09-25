import { createHash } from 'node:crypto';
import {
  type Action,
  type ActionStatus,
  type ApprovalDecisionRequest,
  BROKER_TIMEOUT_MS,
  type CapabilityClaims,
  type ConnectorFault,
  type ConnectorTool,
  canonicalizePayload,
  type DispatchResult,
  dispatchResult,
  type EffectProposalResponse,
  type ExecutionSettlement,
  executionIntent,
  findTool,
  hashOriginWarnings,
  intentKey,
  isTrustGatedEffect,
  type JsonObject,
  jobConstraints,
  type OriginWarning,
  originWarnings,
  type ProposeActionRequest,
  type ReactRequest,
  type Receipt,
  reactRequest,
  repairCounters,
  repairTrace,
  type ToolSpec,
  type VerifyResult,
  verifyResult,
} from '@melete/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { PgBoss } from 'pg-boss';
import type { ParameterOrJSON, Sql, TransactionSql } from 'postgres';
import { REACT_TOOL, supersededExecution } from '../connectors/catalog.ts';
import {
  asConnectorFault,
  type ConnectorDescription,
  type RepairAttemptContext,
  unclassifiedFault,
} from '../connectors/faults.ts';
import { checkConnectionGeneration } from '../connectors/generation.ts';
import {
  type Connector,
  type ConnectorContext,
  connectorAllowsAudience,
} from '../connectors/types.ts';
import { agentAccess, directSend } from '../experience/access.ts';
import { plainText } from '../experience/projectors.ts';
import { type AttemptWake, attemptQueue } from '../jobs/queue.ts';
import { jobVisibleTo } from '../principals/authority.ts';
import { recordGeneratedArtifact } from './artifacts.ts';
import {
  bindEffect,
  type EffectAuthorityResolver,
  loadBinding,
  requireMatchingBinding,
  resolveEffectAuthority,
  saveBinding,
} from './authority.ts';
import { type ReservationRequest, reserveLocked } from './budget.ts';
import { type CatalogOptions, resolveToolAlias, SKILL_READ_TOOL, ToolCatalog } from './catalog.ts';
import { COMPOSE_TOOL, type ComposeExecutor, ComposeService } from './compose.ts';
import { grantsConnectionScopes } from './connection-scopes.ts';
import { BrokerFault } from './errors.ts';
import type { BrokerOperations } from './http.ts';
import {
  actionFromRow,
  appendEvent,
  checkAttempt,
  type LockedJob,
  loadAction,
  lockJob,
  type Query,
  recordId,
} from './records.ts';
import { type MappingProposal, type RepairPorts, type RepairRun, runRepair } from './repair.ts';
import { RESUME_ACTION_TOOL } from './resume.ts';
import { RUNTIME_WAIT_TOOL, requestRuntimeWait } from './runtime-wait.ts';
import {
  collectOriginFields,
  createTableTrustResolver,
  resolveOriginWarnings,
  type TrustResolver,
} from './trust.ts';

type ConnectorResolver = { get(connectionId: string): Connector | undefined };
export type BrokerOptions = {
  sql: Sql;
  connectors: ConnectorResolver;
  /** The started queue shares this Postgres; its send joins the state transaction. */
  boss?: PgBoss;
  dispatchTimeoutMs?: number;
  /** Trusted connector pricing, never a cost supplied by the model. */
  estimateSpend?: (action: Action) => number;
  resolveAuthority?: EffectAuthorityResolver;
  /**
   * Called inside the transaction that persists a successful receipt, with the
   * receipt already written. This is where a file that declared an expectation
   * becomes an artifact row with its validation results beside it. Optional:
   * a broker with no recorder still dispatches, it just records nothing extra.
   */
  recordArtifact?: (
    tx: Query,
    input: { job: LockedJob; action: Action; receipt: Receipt },
  ) => Promise<void>;
  /**
   * Where the values in a payload came from. Start-up passes the memory core's
   * resolver; without one the broker asks nobody and warns about nothing.
   */
  resolveTrust?: TrustResolver;
  /**
   * Whether a standing grant already covers this effect. v0.1 ships none, so
   * the default is no grant and every external send is approved once. A grant
   * only ever removes the approval when nothing about the payload is in doubt.
   */
  resolveStandingGrant?: StandingGrantResolver;
  /** Approval lifetime is service policy, never a value supplied by a tool caller. */
  approvalTtlMs?: number;
  /**
   * Re-open an output that failed its own validation and produce a revised
   * payload, or nothing. Absent, a bad output stops at `needs_input`: a file
   * existing is never a delivery, and nothing here invents a revision.
   */
  reviseOutput?: (input: { action: Action; fault: ConnectorFault }) => Promise<JsonObject | null>;
  /**
   * How the jobs module parks a responsibility: end the attempt, release the
   * worker, and put the job on a timer, all inside the broker's transaction.
   * Without one the broker performs the equivalent itself, which is correct on
   * its own but does not know about anything the service layer adds later.
   */
  parkAttempt?: (
    tx: Query,
    input: { job_id: string; attempt_id: string; wake_at: string; reason: string },
  ) => Promise<void>;
  catalog?: Pick<CatalogOptions, 'coreTokenBudget' | 'skills'>;
  /** The execution cell supplies this; omission keeps composition unavailable. */
  composeExecutor?: ComposeExecutor;
  /** The service runner must finalize its attempt before changing the job state. */
  deferApprovalWaitToRunner?: boolean;
};

export type StandingGrantInput = {
  job: LockedJob;
  action: Action;
  tool: ConnectorTool;
  phase: 'proposal' | 'admission' | 'execution';
};
export type StandingGrantResolver = (tx: Query, input: StandingGrantInput) => Promise<boolean>;

/** What admission decided about one action before it reserved anything. */
type Admissibility = {
  warnings: OriginWarning[];
  warnings_hash: string;
  standing_grant: boolean;
  requires_approval: boolean;
};

const question =
  'Melete cannot confirm whether this was sent. Check the destination, then mark it.';
/** Settled by the owner's answer rather than by evidence, so later evidence still counts. */
const ownerAnswered = (action: Action) =>
  ['succeeded', 'failed'].includes(action.status) &&
  (action.reconciliation as Record<string, unknown> | null)?.decided_by === 'owner';

/** The longest a connector may ask one dispatch to take. */
const MAX_DISPATCH_BUDGET_MS = 10 * 60_000;
const needsApproval = (tool: ConnectorTool) =>
  tool.requires_approval || tool.effect_class === 'write_external' || tool.effect_class === 'spend';

const untrustedOrigin = (warnings: OriginWarning[]) =>
  `This effect uses ${warnings.length === 1 ? 'a value' : 'values'} Melete cannot vouch for: ` +
  `${warnings.map((warning) => `${warning.field} (${warning.origin_trust})`).join(', ')}. ` +
  'It needs your approval with that in front of you, whatever was agreed before.';

/**
 * The sentence a tool result carries. Built from the record, so a second
 * proposal of a send that already happened names the receipt, and a second
 * proposal of a send nobody can confirm says exactly that instead of retrying.
 */
function dispositionMessage(action: Action, repeated: boolean): string {
  const receiptRef = (action.receipt?.external_ref as string | null | undefined) ?? action.id;
  const already = repeated ? 'already ' : '';
  switch (action.status) {
    case 'proposed':
      return 'Proposed. Nothing has left Melete yet.';
    case 'needs_approval':
      return `This effect is ${already}waiting for your approval. Nothing has been sent.`;
    case 'approved':
      return `This effect is ${already}approved and waiting to be admitted. Nothing has been sent.`;
    case 'denied':
      return 'You denied this effect. It was not sent, and it will not be.';
    case 'admitted':
      return `This effect is ${already}admitted and has not been dispatched yet.`;
    case 'dispatched':
      return `This effect was ${already}dispatched and the result has not come back yet.`;
    case 'succeeded':
      return `This effect ${already}succeeded at ${action.resolved_at ?? action.created_at}, receipt ${receiptRef}. Nothing was sent again.`;
    case 'failed':
      return `This effect ${already}failed at ${action.resolved_at ?? action.created_at}. Nothing was sent again.`;
    case 'unknown':
      return `${question} It was ${already}attempted at ${action.dispatched_at ?? action.created_at} and was not sent again.`;
    case 'unresolved':
      return `${question} Verification could not decide, and it was not sent again.`;
  }
}

export class BrokerService implements BrokerOperations {
  readonly sql: Sql;
  readonly discovery: ToolCatalog;
  readonly compose?: ComposeService;
  private readonly validator = new Ajv({ strict: false, allErrors: false, addUsedSchema: false });
  private readonly validator2020 = new Ajv2020({
    strict: false,
    allErrors: false,
    addUsedSchema: false,
  });
  private readonly dispatchTimeoutMs: number;

  constructor(private readonly options: BrokerOptions) {
    this.sql = options.sql;
    this.discovery = new ToolCatalog({
      sql: options.sql,
      connectors: options.connectors,
      ...options.catalog,
      nativeTools: [
        REACT_TOOL,
        RUNTIME_WAIT_TOOL,
        RESUME_ACTION_TOOL,
        SKILL_READ_TOOL,
        ...(options.composeExecutor ? [COMPOSE_TOOL] : []),
      ],
    });
    if (options.composeExecutor) {
      this.compose = new ComposeService({
        broker: this,
        catalog: (claims) => this.discovery.available(claims),
        executor: options.composeExecutor,
      });
    }
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? BROKER_TIMEOUT_MS;
    if (
      options.approvalTtlMs !== undefined &&
      (!Number.isSafeInteger(options.approvalTtlMs) || options.approvalTtlMs <= 0)
    )
      throw new Error('approvalTtlMs must be a positive integer');
  }

  async authorize(claims: CapabilityClaims): Promise<void> {
    await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
    });
  }

  /** The owner adapter asks the same origin resolver as admission, inside its decision lock. */
  async origins(tx: Query, job: LockedJob, action: Action) {
    return resolveOriginWarnings(tx, this.options.resolveTrust ?? createTableTrustResolver({}), {
      space_id: job.space_id,
      job_id: job.id,
      connection_id: action.connection_id,
      kind: action.kind,
      effect_class: action.effect_class,
      canonical_payload: action.canonical_payload,
      fields: collectOriginFields(action.canonical_payload),
    });
  }

  private async tool(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
    connectionId: string,
    kind: string,
  ) {
    const access = await agentAccess(tx, job.id);
    if (
      access.paused ||
      (access.allowed && !access.allowed.includes(connectionId)) ||
      access.missingAgent ||
      (access.chat && !access.agentId)
    )
      throw new BrokerFault('scope_denied');
    const [connection] =
      await tx`select c.provider, c.scopes, c.status, s.audience from connection c
      join space s on s.id = c.space_id
      where c.id = ${connectionId} and c.space_id = ${job.space_id} for share`;
    if (connection?.status !== 'active') throw new BrokerFault('unknown_connection');
    await this.checkExecutionBackend(tx, job.space_id, String(connection.provider));
    const connector = this.options.connectors.get(connectionId);
    if (
      !connector ||
      connector.manifest.provider !== connection.provider ||
      connector.capability?.available === false
    )
      throw new BrokerFault('connector_unavailable');
    if (!connectorAllowsAudience(connector, job.constraints, connection.audience))
      throw new BrokerFault('scope_denied');
    const tool = resolveToolAlias(connector, connectionId, kind);
    if (!tool) throw new BrokerFault('unknown_tool');
    const required = new Set([...tool.required_scopes, tool.name]);
    if (!grantsConnectionScopes(claims, connection.scopes, [...required])) {
      throw new BrokerFault('scope_denied');
    }
    return { tool, connector };
  }

  /**
   * Answer a message with a glyph. It writes one event on this job's own
   * stream, touches nothing outside the installation, and is refused for a
   * message belonging to another job: a reaction is still a statement about
   * something, and the runtime may only speak about its own responsibility.
   * With no target it lands on the owner's latest message on this job, since no
   * attempt input shows an event seq; a job with no owner message has none.
   */
  async react(claims: CapabilityClaims, request: ReactRequest) {
    const value = reactRequest.parse(request);
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const [target] = value.message_id
        ? await tx`select seq, job_id, type from event where seq = ${Number(value.message_id)}`
        : await tx`select seq, job_id, type from event where job_id = ${job.id}
            and type = 'notice' and payload->>'kind' = 'user_message'
            order by seq desc limit 1`;
      if (!target || target.job_id !== job.id || target.type === 'reaction')
        throw new BrokerFault('action_not_found');
      const messageId = String(target.seq);
      await appendEvent(
        tx,
        job.id,
        claims.attempt_id,
        'reaction',
        { message_id: messageId, emoji: value.emoji, by: 'assistant' },
        `reaction:${messageId}:assistant:${value.emoji}`,
      );
      return { message_id: messageId, emoji: value.emoji };
    });
  }

  requestWait(claims: CapabilityClaims, input: unknown) {
    return requestRuntimeWait(this.sql, claims, input);
  }

  async catalog(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.discovery.catalog(claims);
  }

  async get(claims: CapabilityClaims, id: string): Promise<Action> {
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const action = await loadAction(tx, id);
      if (action.job_id !== job.id) throw new BrokerFault('action_not_found');
      await this.tool(tx, job, claims, action.connection_id, action.kind);
      return action;
    });
  }

  /**
   * In-cell intents validate the arguments before execution. Legacy completed
   * records retain their schema, and settlement uses it for the later result.
   * An in-cell connector must declare that record schema so neither proposal
   * form nor settlement can admit an unchecked shape.
   */
  private validatePayload(tool: ConnectorTool, payload: Action['canonical_payload']) {
    if (tool.execution === 'in_cell' && !tool.record_schema)
      throw new BrokerFault('payload_invalid', 'An in-cell tool must declare a record schema');
    const intent = tool.execution === 'in_cell' ? executionIntent.safeParse(payload) : null;
    if (intent?.success) {
      this.compiled(tool.input_schema)(intent.data.intent);
      return;
    }
    const schema = tool.execution === 'in_cell' ? tool.record_schema : tool.input_schema;
    if (!schema) throw new BrokerFault('payload_invalid');
    this.compiled(schema)(payload);
  }

  /**
   * A tool schema the broker cannot compile is an operator fault, not a model
   * one: changing the arguments cannot repair it, so it is refused as such.
   */
  private compiled(schema: ConnectorTool['input_schema']) {
    let validate: ValidateFunction;
    try {
      const validator =
        schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
          ? this.validator2020
          : this.validator;
      validate = validator.compile(schema);
    } catch {
      throw new BrokerFault(
        'schema_invalid',
        'Tool schema cannot compile; operator repair is required',
      );
    }
    if ('$async' in validate && validate.$async)
      throw new BrokerFault('schema_invalid', 'Asynchronous tool schemas are unsupported');
    return (payload: unknown) => {
      if (validate(payload) !== true) throw new BrokerFault('payload_invalid');
    };
  }

  private async proposalView(
    action: Action,
    key: string,
    repeated: boolean,
  ): Promise<EffectProposalResponse> {
    const [approval] = await this
      .sql`select id, decision, origin_warnings from approval where action_id = ${action.id}
      and payload_hash = ${action.payload_hash}`;
    return {
      action_id: action.id,
      status: action.status,
      effect_class: action.effect_class,
      payload_hash: action.payload_hash,
      canonical_payload: action.canonical_payload,
      requires_approval: action.status === 'needs_approval' && !approval?.decision,
      approval_id: approval?.id ?? null,
      intent_key: action.intent_key ?? key,
      repeated,
      message: dispositionMessage(action, repeated),
      origin_warnings: originWarnings.parse(approval?.origin_warnings ?? []),
    };
  }

  /**
   * What admission would decide about this action right now: where its values
   * came from, whether a standing grant covers it, and therefore whether a
   * person still has to answer. Recomputed at every phase, because the answer
   * is about the world at that moment and not about what a proposal believed.
   */
  private async classify(
    tx: Query,
    job: LockedJob,
    action: Action,
    tool: ConnectorTool,
    phase: StandingGrantInput['phase'] = 'proposal',
  ): Promise<Admissibility> {
    const access = await agentAccess(tx, job.id);
    const requiresApproval =
      needsApproval(tool) ||
      Boolean(
        access.agentId &&
          access.asksBeforeActing &&
          tool.effect_class !== 'read' &&
          tool.name !== 'email.draft' &&
          tool.name !== 'email.discard',
      );
    const gated = isTrustGatedEffect(tool.effect_class);
    const fields = gated ? collectOriginFields(action.canonical_payload, action.kind) : [];
    const warnings = await resolveOriginWarnings(
      tx,
      gated
        ? (this.options.resolveTrust ??
            (this.options.resolveStandingGrant ? createTableTrustResolver({}) : undefined))
        : undefined,
      {
        space_id: job.space_id,
        job_id: job.id,
        connection_id: action.connection_id,
        kind: action.kind,
        effect_class: tool.effect_class,
        canonical_payload: action.canonical_payload,
        fields,
      },
    );
    // A grant is only ever a shortcut past a question nobody needs to ask. It
    // never covers a value whose origin Melete cannot vouch for.
    const granted =
      warnings.length === 0 && requiresApproval && this.options.resolveStandingGrant
        ? await this.options.resolveStandingGrant(tx, { job, action, tool, phase })
        : false;
    return {
      warnings,
      warnings_hash: hashOriginWarnings(warnings),
      standing_grant: granted,
      requires_approval: requiresApproval && !granted,
    };
  }

  private approvalRow(row: Record<string, unknown>) {
    return {
      id: row.id as string,
      decision: (row.decision ?? null) as 'approved' | 'denied' | null,
      job_revision: row.job_revision as number,
      expires_at: (row.expires_at ?? null) as string | Date | null,
      origin_warnings: originWarnings.parse(row.origin_warnings ?? []),
    };
  }

  private async askOwner(
    tx: Query,
    job: LockedJob,
    action: Action,
    approvalId: string,
    classified: Admissibility,
  ) {
    await appendEvent(tx, job.id, action.attempt_id, 'approval_requested', {
      action_id: action.id,
      approval_id: approvalId,
      origin_warnings: classified.warnings,
      origin_warnings_hash: classified.warnings_hash,
    });
    if (job.state === 'running' && !this.options.deferApprovalWaitToRunner)
      await this.moveJob(tx, job, 'waiting_for_approval', {
        kind: 'approval',
        action_ids: [action.id],
      });
  }

  /**
   * The live question attached to this action. A decision is bound to the set
   * of doubts it was taken against: when that set changes the answer stops
   * counting, the action goes back to needs_approval, and the person is asked
   * again with the new doubts attached. The superseded answer stays in the
   * event log, which is where the history of a decision belongs.
   */
  private async holdApproval(
    tx: Query,
    job: LockedJob,
    action: Action,
    existing: Record<string, unknown> | undefined,
    classified: Admissibility,
  ) {
    const warnings = JSON.stringify(classified.warnings);
    if (!existing) {
      // The binding fixes the expiry; a later approval cannot extend it.
      const stored = await loadBinding(tx, action);
      const expiresAt = (stored.tuple.expires_at ?? null) as string | null;
      const approvalId = recordId('apr');
      const [row] = await tx`insert into approval
        (id, action_id, job_revision, payload_hash, expires_at, origin_warnings)
        values (${approvalId}, ${action.id}, ${job.revision}, ${action.payload_hash},
          ${expiresAt}, ${warnings}::jsonb) returning *`;
      if (!row) throw new Error('Approval insert returned no record');
      if (action.status !== 'needs_approval') await this.setStatus(tx, action, 'needs_approval');
      await this.askOwner(tx, job, action, approvalId, classified);
      return this.approvalRow(row);
    }
    const held = this.approvalRow(existing);
    if (hashOriginWarnings(held.origin_warnings) === classified.warnings_hash) return held;
    const [row] = await tx`update approval set decision = null, decided_at = null,
      decided_by = null, requested_at = now(), origin_warnings = ${warnings}::jsonb
      where id = ${held.id} returning *`;
    if (!row) throw new Error('Approval update returned no record');
    await appendEvent(tx, job.id, action.attempt_id, 'notice', {
      action_id: action.id,
      approval_id: held.id,
      phase: 'approval_superseded',
      reason: 'untrusted_recipient_origin',
      superseded_decision: held.decision,
      superseded_origin_warnings: held.origin_warnings,
    });
    if (action.status !== 'needs_approval') await this.setStatus(tx, action, 'needs_approval');
    await this.askOwner(tx, job, action, held.id, classified);
    return this.approvalRow(row);
  }

  async propose(
    claims: CapabilityClaims,
    request: ProposeActionRequest,
    readOnly = false,
  ): Promise<EffectProposalResponse> {
    const proposal = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const access = await agentAccess(tx, job.id);
      if (access.chat && directSend(request.kind))
        throw new BrokerFault('scope_denied', 'Review the draft and use its send control.');
      const { tool, connector } = await this.tool(
        tx,
        job,
        claims,
        request.connection_id,
        request.kind,
      );
      if (readOnly && (tool.effect_class !== 'read' || tool.requires_approval))
        throw new BrokerFault(
          'scope_denied',
          'Composition may invoke only auto-admitted read tools',
        );
      // A presentation alias binds one granted account; the durable intent and
      // connector dispatch keep the original verb, including after a restart.
      request = { ...request, kind: tool.name };
      let canonical = canonicalizePayload(request.payload);
      this.validatePayload(tool, canonical.canonical);
      if (connector.prepare) {
        canonical = canonicalizePayload(
          await connector.prepare(
            canonical.canonical,
            {
              job_id: job.id,
              space_id: job.space_id,
              idempotency_key: '',
              constraints: jobConstraints.parse(job.constraints),
            },
            tx,
          ),
        );
        this.validatePayload(tool, canonical.canonical);
      }
      // The identity of the effect itself, independent of which attempt is
      // alive. A runtime that died between proposing and hearing back proposes
      // the same key and is handed the action it already made.
      const effectKey = intentKey({
        job_id: job.id,
        job_revision: job.revision,
        connection_id: request.connection_id,
        kind: request.kind,
        payload_hash: canonical.hash,
        ...(access.turnId ? { turn_id: access.turnId } : {}),
      });
      // Repeated reads reuse their observation within an attempt; later attempts
      // observe the current source. External effects retain durable job identity.
      const scope = tool.effect_class === 'read' ? claims.attempt_id : job.id;
      const key =
        tool.effect_class === 'read'
          ? createHash('sha256').update(`${effectKey}:${scope}`).digest('hex')
          : effectKey;
      const refBase =
        request.client_ref === undefined
          ? null
          : `broker:proposal:${scope}:${createHash('sha256')
              .update(access.turnId ? `${access.turnId}:${request.client_ref}` : request.client_ref)
              .digest('hex')}`;
      const ref = refBase ? `${refBase}:revision:${job.revision}` : null;
      if (refBase) {
        // LIKE treats '_' in every job id as a wildcard unless escaped.
        const refPattern = `${refBase.replace(/[\\%_]/g, '\\$&')}:revision:%`;
        const [event] = await tx`select payload from event where job_id = ${job.id}
          and (dedup_key = ${refBase} or dedup_key like ${refPattern})
          order by seq desc limit 1`;
        if (event) {
          const existing = await loadAction(tx, event.payload.action_id);
          const currentEffectIdentity = intentKey({
            job_id: job.id,
            job_revision: job.revision,
            connection_id: existing.connection_id,
            kind: existing.kind,
            payload_hash: existing.payload_hash,
            ...(access.turnId ? { turn_id: access.turnId } : {}),
          });
          const currentIdentity =
            tool.effect_class === 'read'
              ? createHash('sha256').update(`${currentEffectIdentity}:${scope}`).digest('hex')
              : currentEffectIdentity;
          const obsoleteUnadmitted =
            existing.intent_key !== currentIdentity &&
            ['proposed', 'needs_approval', 'approved', 'denied'].includes(existing.status);
          if (obsoleteUnadmitted) {
            // A correction revokes an unadmitted approval. Preserve the old
            // record, refuse its dispatch, and create a binding for this revision.
            if (['proposed', 'needs_approval', 'approved'].includes(existing.status))
              await this.rejectDispatch(tx, job, existing, 'job_revision_changed');
          } else {
            if (
              existing.payload_hash !== canonical.hash ||
              existing.kind !== request.kind ||
              existing.connection_id !== request.connection_id
            ) {
              throw new BrokerFault(
                'approval_hash_mismatch',
                'A retried proposal must use the same content',
              );
            }
            return { action: existing, key, repeated: true };
          }
        }
      }
      // The unique index is the durable half of this; the job row lock is what
      // makes two live attempts take their turn rather than race.
      const [prior] = await tx`select * from action where intent_key = ${key} for update`;
      if (prior) return { action: actionFromRow(prior), key, repeated: true };
      const id = recordId('act');
      const [row] = await tx`insert into action
        (id, job_id, attempt_id, connection_id, kind, effect_class, canonical_payload, payload_hash, idempotency_key, intent_key)
        values (${id}, ${job.id}, ${claims.attempt_id}, ${request.connection_id}, ${request.kind},
          ${tool.effect_class}, ${canonical.json}::jsonb, ${canonical.hash}, ${id}, ${key}) returning *`;
      if (!row) throw new Error('Action insert returned no record');
      const created = actionFromRow(row);
      const classified = await this.classify(tx, job, created, tool);
      const expiresAt = classified.requires_approval
        ? new Date(Date.now() + (this.options.approvalTtlMs ?? 86_400_000)).toISOString()
        : null;
      const authority = await resolveEffectAuthority(
        tx,
        { job, action: created, phase: 'proposal' },
        this.options.resolveAuthority,
      );
      await saveBinding(tx, created, bindEffect(created, job, authority, expiresAt));
      await appendEvent(
        tx,
        job.id,
        claims.attempt_id,
        'action_requested',
        { action_id: id, kind: request.kind, payload_hash: canonical.hash, intent_key: key },
        ref ?? undefined,
      );
      if (classified.requires_approval) {
        const approvalId = recordId('apr');
        await tx`insert into approval
          (id, action_id, job_revision, payload_hash, expires_at, origin_warnings)
          values (${approvalId}, ${id}, ${job.revision}, ${canonical.hash}, ${expiresAt},
            ${JSON.stringify(classified.warnings)}::jsonb)`;
        await this.setStatus(tx, created, 'needs_approval');
        await this.askOwner(tx, job, created, approvalId, classified);
      }
      return { action: await loadAction(tx, id), key, repeated: false };
    });
    const { action, key, repeated } = proposal;
    // Repeated proposals retrieve the durable disposition; unknown is never replayed.
    if (action.status === 'proposed' || action.status === 'approved') {
      await this.admit(claims, action.id, action.payload_hash);
      return this.proposalView(await this.dispatch(action.id), key, repeated);
    }
    // A crash between the two durable steps has not sent anything yet.
    if (action.status === 'admitted')
      return this.proposalView(await this.dispatch(action.id), key, repeated);
    return this.proposalView(action, key, repeated);
  }

  /**
   * Carry out an approved action by id. The caller supplies no payload: the
   * stored canonical bytes go through the same admission and dispatch a
   * byte-identical proposal would reach, under this attempt's authority, so the
   * payload-hash and revision binding, the budget reservation and the fence are
   * the ones that already exist. Any other status reads back its durable
   * disposition, which is why an unknown outcome is never sent again.
   */
  async resume(claims: CapabilityClaims, id: string): Promise<EffectProposalResponse> {
    const action = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const stored = await loadAction(tx, id);
      if (stored.job_id !== job.id) throw new BrokerFault('action_not_found');
      const access = await agentAccess(tx, job.id);
      if (access.chat && directSend(stored.kind))
        throw new BrokerFault('scope_denied', 'Review the draft and use its send control.');
      const { tool } = await this.tool(tx, job, claims, stored.connection_id, stored.kind);
      // An in-cell intent is executed by the runtime that proposes it, not replayed here.
      if (tool.execution === 'in_cell' && ['approved', 'admitted'].includes(stored.status))
        throw new BrokerFault(
          'action_not_admissible',
          'This approved action runs inside the runtime. Propose the same tool again with the approved arguments.',
        );
      return stored;
    });
    const key = action.intent_key ?? '';
    if (action.status === 'approved') {
      await this.admit(claims, action.id, action.payload_hash);
      return this.proposalView(await this.dispatch(action.id), key, false);
    }
    // A crash between the two durable steps has not sent anything yet.
    if (action.status === 'admitted')
      return this.proposalView(await this.dispatch(action.id), key, false);
    return this.proposalView(action, key, true);
  }

  proposeRead(claims: CapabilityClaims, request: ProposeActionRequest) {
    return this.propose(claims, request, true);
  }

  async say(claims: CapabilityClaims, text: string, ref: string): Promise<void> {
    const safe = plainText(text, '', 600);
    if (
      !safe ||
      safe !== text.trim() ||
      !/^(I\b|I['â€™]m\b|I['â€™]ll\b)/i.test(safe) ||
      (safe.match(/[.!?](?:\s|$)/g)?.length ?? 0) > 2
    )
      throw new BrokerFault('payload_invalid', 'Use one or two plain first-person sentences.');
    await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      await appendEvent(
        tx,
        job.id,
        claims.attempt_id,
        'notice',
        { kind: 'experience_say', text: safe },
        `say:${claims.attempt_id}:${createHash('sha256').update(ref).digest('hex')}`,
      );
    });
  }

  async decide(
    id: string,
    request: ApprovalDecisionRequest,
    guard?: (
      tx: Query,
      job: LockedJob,
      action: Action,
      approval: Record<string, unknown>,
    ) => Promise<void>,
  ) {
    const original = await loadAction(this.sql, id);
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, original.job_id);
      const action = await loadAction(tx, id, true);
      const [approval] = await tx`select * from approval where action_id = ${id}
        and payload_hash = ${request.payload_hash} for update`;
      if (
        !approval ||
        action.payload_hash !== request.payload_hash ||
        canonicalizePayload(action.canonical_payload).hash !== request.payload_hash
      ) {
        throw new BrokerFault('approval_hash_mismatch');
      }
      if (approval.job_revision !== job.revision) throw new BrokerFault('revision_mismatch');
      if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now())
        throw new BrokerFault('approval_required', 'Approval expired');
      const authority = await resolveEffectAuthority(
        tx,
        { job, action, phase: 'decision' },
        this.options.resolveAuthority,
      );
      requireMatchingBinding(
        await loadBinding(tx, action),
        bindEffect(
          action,
          job,
          authority,
          approval.expires_at ? new Date(approval.expires_at).toISOString() : null,
        ),
      );
      if (['cancelled', 'completed', 'failed'].includes(job.state))
        throw new BrokerFault('stale_epoch');
      await guard?.(tx, job, action, approval);
      if (approval.decision) {
        if (approval.decision !== request.decision) throw new BrokerFault('action_not_admissible');
        return {
          approval_id: approval.id,
          action_id: id,
          decision: approval.decision,
          payload_hash: approval.payload_hash,
          decided_at: new Date(approval.decided_at).toISOString(),
        };
      }
      if (action.status !== 'needs_approval') throw new BrokerFault('action_not_admissible');
      const decidedAt = new Date().toISOString();
      await tx`update approval set decision = ${request.decision}, decided_at = ${decidedAt},
        decided_by = 'owner' where id = ${approval.id}`;
      await this.setStatus(tx, action, request.decision);
      await appendEvent(tx, job.id, action.attempt_id, 'approval_decided', {
        action_id: id,
        approval_id: approval.id,
        decision: request.decision,
        note: request.note ?? null,
      });
      if (job.state === 'waiting_for_approval') await this.wake(tx, job, 'approval');
      return {
        approval_id: approval.id,
        action_id: id,
        decision: request.decision,
        payload_hash: approval.payload_hash,
        decided_at: decidedAt,
      };
    });
  }

  async admit(claims: CapabilityClaims, id: string, expectedHash: string): Promise<Action> {
    const result = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      try {
        await checkAttempt(tx, job, claims);
        const action = await loadAction(tx, id, true);
        if (action.job_id !== job.id) throw new BrokerFault('action_not_found');
        const { tool, connector } = await this.tool(
          tx,
          job,
          claims,
          action.connection_id,
          action.kind,
        );
        await connector.validateBinding?.(action, this.context(job, action), tx);
        if (
          canonicalizePayload(action.canonical_payload).hash !== action.payload_hash ||
          action.payload_hash !== expectedHash ||
          tool.effect_class !== action.effect_class
        ) {
          throw new BrokerFault('approval_hash_mismatch');
        }
        this.validatePayload(tool, action.canonical_payload);
        if (action.status === 'denied') throw new BrokerFault('approval_denied');
        const classified = await this.classify(tx, job, action, tool, 'admission');
        let authorization: string | null = null;
        let expiresAt: string | null = null;
        if (classified.requires_approval) {
          const [row] = await tx`select * from approval where action_id = ${id}
            and payload_hash = ${action.payload_hash} for update`;
          const approval = await this.holdApproval(tx, job, action, row, classified);
          // A doubt about where a value came from is refused in its own words,
          // before the bookkeeping states get a chance to answer instead.
          if (
            classified.warnings.length > 0 &&
            (approval.decision !== 'approved' ||
              action.status !== 'approved' ||
              hashOriginWarnings(approval.origin_warnings) !== classified.warnings_hash)
          ) {
            throw new BrokerFault(
              'untrusted_recipient_origin',
              untrustedOrigin(classified.warnings),
            );
          }
          if (!['proposed', 'approved'].includes(action.status))
            throw new BrokerFault('action_not_admissible');
          if (approval.decision !== 'approved' || action.status !== 'approved')
            throw new BrokerFault('approval_required');
          if (approval.job_revision !== job.revision) throw new BrokerFault('revision_mismatch');
          if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now())
            throw new BrokerFault('approval_required', 'Approval expired');
          authorization = approval.id;
          expiresAt = approval.expires_at ? new Date(approval.expires_at).toISOString() : null;
        }
        if (!['proposed', 'approved'].includes(action.status))
          throw new BrokerFault('action_not_admissible');
        const authority = await resolveEffectAuthority(
          tx,
          { job, action, phase: 'admission' },
          this.options.resolveAuthority,
        );
        const binding = bindEffect(action, job, authority, expiresAt);
        requireMatchingBinding(await loadBinding(tx, action), binding);
        const requests: ReservationRequest[] = [{ kind: 'calls', amount: 1 }];
        if (tool.effect_class === 'spend') {
          const cost = this.options.estimateSpend?.(action);
          if (cost === undefined || !Number.isFinite(cost) || cost < 0)
            throw new BrokerFault('budget_exceeded', 'Trusted spend estimate required');
          requests.push({ kind: 'usd_est', amount: cost });
        }
        const reservations = await reserveLocked(tx, job, claims, id, requests);
        await tx`update action set authorization_ref = ${authorization},
          budget_reservation = ${reservations[0]?.id ?? null}, attempt_id = ${claims.attempt_id}
          where id = ${id}`;
        await this.setStatus(tx, { ...action, attempt_id: claims.attempt_id }, 'admitted');
        await appendEvent(
          tx,
          job.id,
          claims.attempt_id,
          'notice',
          {
            action_id: id,
            phase: 'execution_authorized',
            ...binding,
            standing_grant: classified.standing_grant,
            origin_warnings_hash: classified.warnings_hash,
          },
          `broker:execution:${id}`,
        );
        return { action: await loadAction(tx, id), error: null };
      } catch (error) {
        if (!(error instanceof BrokerFault)) throw error;
        // Return instead of throwing inside the transaction, so the refusal is durable.
        await appendEvent(tx, job.id, null, 'notice', {
          action_id: id,
          phase: 'admission_rejected',
          code: error.code,
          reason: error.message,
        });
        return { action: null, error };
      }
    });
    if (result.error) throw result.error;
    if (!result.action) throw new Error('Admission returned no action');
    return result.action;
  }

  /**
   * Everything that has to be true for these bytes to leave, re-asked.
   *
   * The connection is still this connection and still active, the generation
   * the admission reviewed is still current, the tool and its scopes are still
   * held, the effect binding still matches, and the origins are still the ones
   * the approval was given against. It returns a fenced reason when the world
   * has moved and throws a `BrokerFault` when authority was never there.
   *
   * A dispatch asks this once before it marks the action dispatched. A repair
   * asks it again before every further execution, because a revocation during a
   * backoff is exactly the case a retry must not out-run.
   */
  /** The cell's exec connection, refused in a space that runs its commands in a sandbox. */
  private async checkExecutionBackend(tx: Query, spaceId: string, provider: string) {
    if (provider !== 'exec') return;
    const active = await tx`select provider from connection
      where space_id = ${spaceId} and status = 'active'`;
    if (
      supersededExecution(
        provider,
        active.map((row) => String(row.provider)),
      )
    )
      throw new BrokerFault(
        'connector_unavailable',
        'This space runs its commands in its sandbox connection.',
      );
  }

  private async checkAuthority(tx: Query, job: LockedJob, action: Action): Promise<string | null> {
    // The agent binding: a paused conversation, a persona
    // whose allowed connections exclude this one, a missing persona, or a chat
    // turn without an agent sends nothing; a chat never sends directly.
    const access = await agentAccess(tx, job.id);
    if (
      access.paused ||
      (access.allowed && !access.allowed.includes(action.connection_id)) ||
      access.missingAgent ||
      (access.chat && (!access.agentId || directSend(action.kind)))
    )
      throw new BrokerFault('scope_denied');
    const [connection] =
      await tx`select c.status, c.provider, c.scopes, s.audience from connection c
      join space s on s.id = c.space_id
      where c.id = ${action.connection_id} and c.space_id = ${job.space_id} for share`;
    // Admitted before the space had a sandbox connection is not enough: the
    // command still runs where the space runs commands now.
    if (connection) await this.checkExecutionBackend(tx, job.space_id, String(connection.provider));
    const stored = await loadBinding(tx, action);
    const authority = await resolveEffectAuthority(
      tx,
      { job, action, phase: 'execution' },
      this.options.resolveAuthority,
    );
    const fenced = checkConnectionGeneration(
      stored.connection_generation,
      authority.connectionGeneration,
      connection?.status === 'active',
    );
    if (fenced) return fenced.reason;
    const connector = this.options.connectors.get(action.connection_id);
    const tool = connector && findTool(connector.manifest, action.kind);
    if (
      !connector ||
      connector.manifest.provider !== connection?.provider ||
      !connectorAllowsAudience(connector, job.constraints, connection.audience) ||
      !tool ||
      tool.effect_class !== action.effect_class ||
      ![tool.name, ...tool.required_scopes].every((scope) => connection.scopes.includes(scope))
    )
      throw new BrokerFault('scope_denied');
    // Repair retries must recheck the same artifact and mailbox binding as
    // initial dispatch, since either can change during a backoff.
    await connector.validateBinding?.(action, this.context(job, action), tx);
    requireMatchingBinding(
      stored,
      bindEffect(action, job, authority, stored.tuple.expires_at as string | null),
    );
    // Admission authorized these origins. If the world has since learned that
    // one of them came from somewhere else, nothing leaves.
    const classified = await this.classify(tx, job, action, tool, 'execution');
    if (classified.requires_approval && !action.authorization_ref)
      throw new BrokerFault(
        'approval_required',
        'The standing permission no longer covers this action.',
      );
    const [authorizing] = action.authorization_ref
      ? await tx`select origin_warnings from approval where id = ${action.authorization_ref}`
      : [];
    const authorized = originWarnings.parse(authorizing?.origin_warnings ?? []);
    if (hashOriginWarnings(authorized) !== classified.warnings_hash) {
      throw new BrokerFault(
        'untrusted_recipient_origin',
        classified.warnings.length > 0
          ? untrustedOrigin(classified.warnings)
          : 'The origins of this effect no longer match the ones that were approved.',
      );
    }
    return null;
  }

  /**
   * The same question, asked outside the dispatch transaction and answered as a
   * reason rather than an exception, so the repair policy can stop without
   * sending instead of learning about it from a thrown error.
   */
  private async authorityLost(action: Action): Promise<string | null> {
    try {
      return await this.sql.begin(async (tx) => {
        const job = await lockJob(tx, action.job_id);
        const current = await loadAction(tx, action.id, true);
        return this.checkAuthority(tx, job, current);
      });
    } catch (error) {
      if (error instanceof BrokerFault) return error.message;
      throw error;
    }
  }

  private context(job: LockedJob, action: Action): ConnectorContext {
    return {
      job_id: job.id,
      space_id: job.space_id,
      idempotency_key: action.id,
      constraints: jobConstraints.parse(job.constraints),
    };
  }

  /**
   * `now` is the instant the due check is made against. The recovery scan
   * supplies the same instant it selected with, so a parked action is never
   * chosen by one clock and refused by another; everything else takes the wall
   * clock and never notices.
   */
  async dispatch(
    id: string,
    now = Date.now(),
    cellClaim?: { claims: CapabilityClaims; claimed: () => void },
  ): Promise<Action> {
    const original = await loadAction(this.sql, id);
    const prepared = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, original.job_id);
      const action = await loadAction(tx, id, true);
      if (cellClaim) {
        await checkAttempt(tx, job, cellClaim.claims);
        if (
          action.job_id !== cellClaim.claims.job_id ||
          action.attempt_id !== cellClaim.claims.attempt_id
        )
          throw new BrokerFault('action_not_found');
      }
      if (action.status !== 'admitted') return { action, context: null };
      // A parked action is admitted and not yet due. The row lock is what makes
      // this a decision rather than a race: a wake, a repeated proposal and a
      // queue redelivery all serialize on it, and a destination that asked to
      // be left alone for a minute is left alone for a minute.
      if (action.retry_after_at && Date.parse(action.retry_after_at) > now) {
        return { action, context: null };
      }
      const inCell =
        this.options.connectors
          .get(action.connection_id)
          ?.manifest.tools.some(
            (tool) => tool.name === action.kind && tool.execution === 'in_cell',
          ) && executionIntent.safeParse(action.canonical_payload).success;
      if (cellClaim && !inCell) throw new BrokerFault('unknown_tool');
      if (inCell && !cellClaim) return { action, context: null };
      try {
        const fenced = await this.checkAuthority(tx, job, action);
        if (fenced)
          return {
            action: await this.rejectDispatch(tx, job, action, fenced),
            context: null,
          };
      } catch (error) {
        if (!(error instanceof BrokerFault)) throw error;
        return { action: await this.rejectDispatch(tx, job, action, error.message), context: null };
      }
      // Admission authorizes these bytes only. A storage mutation must not reach a connector.
      if (canonicalizePayload(action.canonical_payload).hash !== action.payload_hash) {
        await this.setStatus(tx, action, 'failed');
        await tx`update budget_ledger set settled = 0 where action_id = ${id} and settled is null`;
        await appendEvent(tx, job.id, action.attempt_id, 'notice', {
          action_id: id,
          phase: 'dispatch_rejected',
          code: 'approval_hash_mismatch',
        });
        return { action: await loadAction(tx, id), context: null };
      }
      await tx`update action set dispatched_at = now() where id = ${id}`;
      await this.setStatus(tx, action, 'dispatched');
      return { action: await loadAction(tx, id), context: this.context(job, action) };
    });
    if (!prepared.context) return prepared.action;
    if (cellClaim) {
      cellClaim.claimed();
      return prepared.action;
    }
    const connector = this.options.connectors.get(prepared.action.connection_id);
    if (!connector)
      return this.recordResult(id, {
        outcome: 'unknown',
        reason: 'Connector disappeared after dispatch admission',
      });
    const controller = new AbortController();
    const budgetMs = this.dispatchBudget(connector, prepared.action);
    const execution = Promise.resolve().then(() =>
      runRepair(
        prepared.action.canonical_payload,
        this.repairPorts(prepared, connector, controller),
        {
          classify: (error) => asConnectorFault(error) ?? unclassifiedFault(error),
          // An approved send keeps the hash the person read, so a revision of one
          // is refused rather than sent under an approval it no longer matches.
          trustGated: isTrustGatedEffect(prepared.action.effect_class),
          operation: prepared.action.kind,
          // The dispatch timeout is the repair budget too: a retry that cannot
          // finish inside it is not attempted at all.
          deadlineAt: Date.now() + budgetMs,
        },
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budgetMs);
    });
    const result = await Promise.race([execution, timeout]);
    clearTimeout(timer);
    if (result === 'timeout') {
      controller.abort();
      const unknown = await this.recordResult(id, { outcome: 'unknown', reason: question });
      // A cooperative abort is not proof of non-delivery; a later receipt is still a fact.
      void execution.then((late) => this.settleRepair(prepared.action, late)).catch(() => {});
      return unknown;
    }
    return this.settleRepair(prepared.action, result);
  }

  /**
   * What the policy is allowed to do to this destination. Every port is a
   * capability the connector declared; a connector that cannot describe itself
   * simply cannot be repaired that way, and the policy stops instead.
   */
  private repairPorts(
    prepared: { action: Action; context: ConnectorContext | null },
    connector: Connector,
    controller: AbortController,
  ): RepairPorts {
    const action = prepared.action;
    const base = prepared.context as ConnectorContext;
    const ctx = (repair?: RepairAttemptContext): ConnectorContext => ({
      ...base,
      signal: controller.signal,
      ...(repair ? { repair } : {}),
    });
    // The action is never rewritten. A repaired attempt sends the same identity,
    // the same hash and the same approval, with the payload the policy chose.
    const wire = (payload: JsonObject): Action => ({ ...action, canonical_payload: payload });
    return {
      // Asked before every execution, including the first: the dispatch
      // transaction committed a moment ago and the world can move in a moment.
      authorityLost: () => this.authorityLost(action),
      execute: async ({ payload, route, mapping, attempt }) =>
        dispatchResult.parse(
          await connector.execute(wire(payload), ctx({ attempt, route, mapping })),
        ),
      verify: async () => verifyResult.parse(await connector.verify(action, ctx())),
      ...(connector.reconnect
        ? {
            reconnect: async () => {
              if (await this.authorityLost(action)) return;
              await (connector.reconnect as NonNullable<Connector['reconnect']>)(action, ctx());
            },
          }
        : {}),
      ...(connector.describe
        ? {
            describe: () =>
              (connector.describe as NonNullable<Connector['describe']>)(action, ctx()),
          }
        : {}),
      ...(connector.refreshCredential
        ? {
            refreshCredential: async () => {
              if (await this.authorityLost(action)) return false;
              const refreshed = await (
                connector.refreshCredential as NonNullable<Connector['refreshCredential']>
              )(action, ctx());
              // A fresh token is not a grant. The connection row decides.
              return refreshed && (await this.grantPermits(action));
            },
          }
        : {}),
      ...(connector.routes
        ? { routes: () => (connector.routes as NonNullable<Connector['routes']>)(action, ctx()) }
        : {}),
      ...(this.options.reviseOutput
        ? {
            revise: (fault) =>
              (this.options.reviseOutput as NonNullable<BrokerOptions['reviseOutput']>)({
                action,
                fault,
              }),
          }
        : {}),
      recordCandidate: async ({ fault, proposal, description, evaluation }) =>
        this.recordCandidate(action, fault, proposal, description, evaluation),
    };
  }

  /** A refreshed credential only helps if the connection still permits the call. */
  private async grantPermits(action: Action): Promise<boolean> {
    const [connection] = await this
      .sql`select status, scopes from connection where id = ${action.connection_id}`;
    if (connection?.status !== 'active') return false;
    const scopes = (connection.scopes ?? []) as string[];
    return scopes.includes(action.kind);
  }

  /**
   * Write a drift mapping down as a proposal. It is a record before it is ever
   * a change, and it becomes `applied` only where a passing test says it may.
   */
  private async recordCandidate(
    action: Action,
    fault: ConnectorFault,
    proposal: MappingProposal,
    description: ConnectorDescription,
    evaluation: { passed: boolean; detail: string },
  ): Promise<{ id: string }> {
    const state = !proposal.safe ? 'rejected' : evaluation.passed ? 'evaluated' : 'rejected';
    const [row] = await this.sql`
      insert into repair_candidate
        (id, action_id, job_id, connection_id, kind, fault_kind, state, observed_schema,
         proposed_mapping, test, evaluation, safe)
      values (${recordId('rpc')}, ${action.id}, ${action.job_id}, ${action.connection_id},
        ${action.kind}, ${fault.kind}, ${state},
        ${JSON.stringify(description.schema ?? { required: description.required })}::jsonb,
        ${JSON.stringify(proposal.mapping)}::jsonb, ${JSON.stringify(proposal.test)}::jsonb,
        ${JSON.stringify({ ...evaluation, evaluated_at: new Date().toISOString() })}::jsonb,
        ${proposal.safe})
      on conflict (action_id, proposed_mapping) do update
        set state = excluded.state, evaluation = excluded.evaluation,
            observed_schema = excluded.observed_schema, safe = excluded.safe, updated_at = now()
      returning id`;
    return { id: row?.id as string };
  }

  /**
   * Persist what the policy did, then let the action come to rest.
   *
   * The trace is written first and unconditionally, so an escalation that fails
   * still leaves the evidence of what was tried behind it.
   */
  private async settleRepair(action: Action, run: RepairRun): Promise<Action> {
    const id = action.id;
    // A parked action comes back on a later wake, and what it met before the
    // wait is the reason it waited. Appending rather than replacing keeps a
    // recurring rate limit visible on the record that completed.
    const [stored] = await this
      .sql`select repair_trace, repair_counters from action where id = ${id}`;
    const trace = [...repairTrace.parse(stored?.repair_trace ?? []), ...run.trace];
    const counters = { ...repairCounters.parse(stored?.repair_counters ?? {}) };
    for (const [kind, count] of Object.entries(run.counters)) {
      counters[kind] = (counters[kind] ?? 0) + count;
    }
    await this.sql`update action set repair_trace = ${JSON.stringify(trace)}::jsonb,
      repair_counters = ${JSON.stringify(counters)}::jsonb,
      repair_disposition = ${run.disposition},
      retry_after_at = ${run.retry_after_at}
      where id = ${id}`;
    if (run.disposition === 'parked_until_retry') return this.park(action, run);
    // A mapping that carried the send is only `applied` once the send landed.
    if (run.disposition === 'completed') {
      await this.sql`update repair_candidate set state = 'applied', updated_at = now()
        where action_id = ${id} and state = 'evaluated' and safe = true`;
    }
    const settled = await this.recordResult(id, run.result as DispatchResult);
    if (run.question) await this.escalate(settled, run);
    return settled;
  }

  /**
   * A rate limit releases the worker. The action goes back to admitted with the
   * instant it may be approached again, and the job waits on a timer, so a
   * destination that asked for a minute is not asked again for a minute.
   */
  private async park(action: Action, run: RepairRun): Promise<Action> {
    const wakeAt = run.retry_after_at ?? new Date().toISOString();
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, action.job_id);
      const current = await loadAction(tx, action.id, true);
      if (current.status !== 'dispatched') return current;
      await tx`update action set dispatched_at = null where id = ${action.id}`;
      await this.setStatus(tx, current, 'admitted');
      await appendEvent(tx, job.id, current.attempt_id, 'notice', {
        action_id: action.id,
        phase: 'repair_parked',
        retry_after_at: wakeAt,
      });
      if (['cancelled', 'failed', 'completed'].includes(job.state))
        return loadAction(tx, action.id);
      if (this.options.parkAttempt) {
        // The jobs module owns attempt and worker lifecycle. Where it has
        // supplied its own release, the broker asks for the wait and stays out
        // of the state machine entirely.
        await this.options.parkAttempt(tx, {
          job_id: job.id,
          attempt_id: current.attempt_id,
          wake_at: wakeAt,
          reason: 'rate_limited',
        });
        return loadAction(tx, action.id);
      }
      await this.moveJob(tx, job, 'waiting_for_event_or_time', { kind: 'timer', wake_at: wakeAt });
      await tx`update job set next_wake_at = ${wakeAt},
        substrate_disposition = 'timer_or_event' where id = ${job.id}`;
      await this.releaseAttempt(tx, job, current.attempt_id, wakeAt);
      return loadAction(tx, action.id);
    });
  }

  /**
   * End the attempt the wait belongs to, the way the jobs module ends one.
   *
   * A job that waits while its attempt still holds a lease is a worker nobody
   * will ever reclaim: the runner's recovery sweep only fences attempts whose
   * job is still `running`, so a lease left open here is left open forever, and
   * the heartbeat that would renew it belongs to a process that has moved on.
   */
  private async releaseAttempt(
    tx: Query,
    job: LockedJob,
    attemptId: string,
    wakeAt: string,
  ): Promise<void> {
    const outcome = {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'timer', wake_at: wakeAt },
      summary: 'The destination asked to be left alone, so this waits on a timer.',
    };
    await tx`update attempt set outcome = 'waiting_for_event_or_time',
      outcome_detail = ${JSON.stringify(outcome)}::jsonb, ended_at = now(),
      lease_status = 'ended', lease_expires_at = null
      where id = ${attemptId} and ended_at is null`;
    await appendEvent(tx, job.id, attemptId, 'attempt_ended', { outcome }, `${attemptId}:ended`);
  }

  /**
   * One diagnosis, with the progress that was made, in the owner's one queue.
   * The database holds a single open question per responsibility, so a job that
   * keeps failing the same way asks once and not once per attempt.
   */
  private async escalate(action: Action, run: RepairRun): Promise<void> {
    const reconnect = run.disposition === 'needs_reconnect';
    const uncertain = run.disposition === 'needs_reconciliation';
    const text = reconnect
      ? 'This connection no longer permits the send. Reconnect it and Melete will carry on from here.'
      : uncertain
        ? (run.question as string)
        : `Melete could not finish this and stopped rather than guess. ${run.question}`;
    const because = [
      `${action.kind} stopped at ${run.disposition.replace(/_/g, ' ')} after ${run.executions} ${
        run.executions === 1 ? 'attempt' : 'attempts'
      }.`,
      uncertain
        ? 'The destination never acknowledged it, so nobody can say whether it arrived.'
        : 'Nothing was sent twice and nothing was changed to make it go through.',
    ];
    await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, action.job_id);
      if (['cancelled', 'completed'].includes(job.state)) return;
      const [row] = await tx`insert into question
          (id, source, job_id, attempt_id, text, because, if_ignored, blocks_external_effect)
        values (${recordId('qst')}, 'job', ${job.id}, ${action.attempt_id}, ${text},
          ${JSON.stringify(because)}::jsonb,
          'This responsibility stays where it is until you answer, and nothing is sent in the meantime.',
          true)
        on conflict (job_id) where state = 'open' do nothing
        returning id`;
      await appendEvent(tx, job.id, action.attempt_id, 'notice', {
        action_id: action.id,
        phase: 'repair_escalated',
        disposition: run.disposition,
        question_id: (row?.id as string) ?? null,
      });
    });
  }

  /**
   * Bring back the actions a rate limit parked. Only an admitted action with a
   * due `retry_after_at` is resumed, under its own id, so the destination sees
   * the same request it declined to take a minute ago.
   */
  async resumeParked(now = Date.now()): Promise<number> {
    const due = new Date(now).toISOString();
    const rows = await this.sql`select id from action
      where status = 'admitted' and retry_after_at is not null and retry_after_at <= ${due}
      order by retry_after_at`;
    for (const row of rows) await this.dispatch(row.id as string, now);
    return rows.length;
  }

  async startExecution(claims: CapabilityClaims, id: string): Promise<{ execute: boolean }> {
    let execute = false;
    await this.dispatch(id, Date.now(), {
      claims,
      claimed: () => {
        execute = true;
      },
    });
    return { execute };
  }

  async settleExecution(
    claims: CapabilityClaims,
    id: string,
    result: ExecutionSettlement,
  ): Promise<Action> {
    const action = await loadAction(this.sql, id);
    // Settlement accepts late evidence. This read supplies identity and context
    // without a transaction lock; recordResult holds the job and action locks
    // together inside the transaction that persists the receipt.
    const [job] = await this.sql<LockedJob[]>`select * from job where id = ${action.job_id}`;
    if (
      !job ||
      action.job_id !== claims.job_id ||
      job.space_id !== claims.space_id ||
      action.attempt_id !== claims.attempt_id
    )
      throw new BrokerFault('action_not_found');
    const connector = this.options.connectors.get(action.connection_id);
    const tool = connector && findTool(connector.manifest, action.kind);
    const proposed = executionIntent.safeParse(action.canonical_payload);
    if (!connector || tool?.execution !== 'in_cell' || !proposed.success)
      throw new BrokerFault('unknown_tool');
    if (!['dispatched', 'unknown', 'unresolved'].includes(action.status)) {
      if (['succeeded', 'failed'].includes(action.status)) return action;
      throw new BrokerFault('action_not_admissible');
    }
    if ('error' in result)
      return this.recordResult(id, { outcome: 'failed', reason: result.error, retryable: false });
    const { record } = result;
    const intent = proposed.data.intent;
    if (
      record.command !== (intent.code ?? intent.command) ||
      record.cwd !== (intent.cwd ?? '.') ||
      record.language !== (action.kind === 'exec.python' ? 'python' : 'shell')
    )
      throw new BrokerFault(
        'payload_invalid',
        'Execution result does not match the admitted command',
      );
    if (!tool.record_schema || !this.validator.validate(tool.record_schema, record))
      throw new BrokerFault('payload_invalid');
    // The immutable intent stays on the action; the connector validates the
    // separate result and records it on the receipt, including late receipts.
    const checked = await connector.execute(
      { ...action, canonical_payload: record },
      this.context(job, action),
    );
    return this.recordResult(id, checked);
  }

  async recordResult(id: string, result: DispatchResult): Promise<Action> {
    result = dispatchResult.parse(result);
    const original = await loadAction(this.sql, id);
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, original.job_id);
      const action = await loadAction(tx, id, true);
      const owned = ownerAnswered(action);
      if (!owned && !['dispatched', 'unknown', 'unresolved'].includes(action.status)) return action;
      const [attempt] = await tx`select epoch from attempt where id = ${action.attempt_id}`;
      const late = attempt?.epoch !== job.lease_epoch;
      if (owned) {
        if (result.outcome === 'failed')
          return this.landAfterOwner(
            tx,
            job,
            action,
            { outcome: 'failed', reason: result.reason },
            late,
          );
        if (
          result.outcome === 'succeeded' &&
          result.receipt.action_id === id &&
          result.receipt.connection_id === action.connection_id
        )
          return this.landAfterOwner(
            tx,
            job,
            action,
            { outcome: 'succeeded', receipt: result.receipt },
            late,
          );
        return action;
      }
      const wasUncertain = action.status === 'unknown' || action.status === 'unresolved';
      let receipt: Receipt | null = null;
      if (result.outcome === 'succeeded') {
        if (
          result.receipt.action_id !== id ||
          result.receipt.connection_id !== action.connection_id
        ) {
          result = {
            outcome: 'unknown',
            reason: 'Receipt identity did not match the dispatched action',
          };
        } else
          receipt = await recordGeneratedArtifact(tx, job, action, { ...result.receipt, late });
      }
      if (wasUncertain && result.outcome === 'unknown') return action;
      await this.setStatus(tx, action, result.outcome);
      await tx`update action set receipt = ${receipt ? JSON.stringify(receipt) : null}::jsonb,
        resolved_at = ${result.outcome === 'unknown' ? null : new Date().toISOString()},
        reconciliation = ${JSON.stringify(
          result.outcome === 'unknown'
            ? { reason: question, detail: result.reason, late }
            : result.outcome === 'failed'
              ? { reason: result.reason, retryable: result.retryable, late }
              : {
                  late,
                  ...(wasUncertain ? { decision: 'succeeded', source: 'authentic_receipt' } : {}),
                },
        )}::jsonb
        where id = ${id}`;
      if (result.outcome !== 'unknown') {
        await tx`update budget_ledger set settled = reserved where action_id = ${id} and settled is null`;
      }
      await appendEvent(tx, job.id, action.attempt_id, 'notice', {
        action_id: id,
        phase: 'receipt',
        outcome: result.outcome,
        late,
      });
      // A receipt that carries a declared artifact becomes rows here, in the
      // same transaction, so an artifact never exists without the receipt that
      // produced it and a validation never exists without its artifact.
      if (receipt && this.options.recordArtifact) {
        await this.options.recordArtifact(tx, { job, action, receipt });
      }
      if (
        result.outcome === 'unknown' &&
        !late &&
        !['cancelled', 'failed', 'completed'].includes(job.state)
      ) {
        await this.moveJob(tx, job, 'needs_reconciliation', { kind: 'user_input', question });
      }
      if (
        wasUncertain &&
        result.outcome !== 'unknown' &&
        !late &&
        job.state === 'needs_reconciliation'
      ) {
        const [pending] =
          await tx`select count(*)::int as count from action where job_id = ${job.id}
          and status in ('unknown', 'unresolved', 'dispatched')`;
        if (pending?.count === 0) await this.wake(tx, job, 'recovery');
      }
      return loadAction(tx, id);
    });
  }

  async verify(id: string): Promise<Action> {
    const action = await loadAction(this.sql, id);
    if (!ownerAnswered(action) && !['unknown', 'unresolved'].includes(action.status)) return action;
    const [job] = await this.sql<LockedJob[]>`select * from job where id = ${action.job_id}`;
    if (!job) throw new BrokerFault('action_not_found');
    const connector = this.options.connectors.get(action.connection_id);
    const tool = connector && findTool(connector.manifest, action.kind);
    let result: VerifyResult;
    try {
      result =
        !connector || !tool?.verify
          ? { decision: 'unsupported', reason: question }
          : verifyResult.parse(await connector.verify(action, this.context(job, action)));
    } catch {
      result = { decision: 'undecided', reason: question };
    }
    return this.sql.begin(async (tx) => {
      const currentJob = await lockJob(tx, job.id);
      const current = await loadAction(tx, id, true);
      const owned = ownerAnswered(current);
      if (!owned && !['unknown', 'unresolved'].includes(current.status)) return current;
      const [attempt] = await tx`select epoch from attempt where id = ${current.attempt_id}`;
      const late = attempt?.epoch !== currentJob.lease_epoch;
      if (owned) {
        if (result.decision === 'failed')
          return this.landAfterOwner(
            tx,
            currentJob,
            current,
            { outcome: 'failed', reason: 'The provider reported it did not happen.' },
            late,
          );
        if (
          result.decision === 'succeeded' &&
          result.receipt &&
          result.receipt.action_id === id &&
          result.receipt.connection_id === current.connection_id
        )
          return this.landAfterOwner(
            tx,
            currentJob,
            current,
            { outcome: 'succeeded', receipt: result.receipt },
            late,
          );
        return current;
      }
      if (
        result.decision === 'succeeded' &&
        result.receipt &&
        (result.receipt.action_id !== id || result.receipt.connection_id !== current.connection_id)
      ) {
        result = { decision: 'undecided', reason: 'Verification receipt identity mismatch' };
      }
      const resolved = result.decision === 'succeeded' || result.decision === 'failed';
      const status = resolved ? (result.decision as 'succeeded' | 'failed') : 'unresolved';
      await this.setStatus(tx, current, status);
      const receipt =
        result.decision === 'succeeded' && result.receipt
          ? await recordGeneratedArtifact(tx, currentJob, current, { ...result.receipt, late })
          : null;
      await tx`update action set reconciliation = ${JSON.stringify({ ...result, question: resolved ? null : question, late })}::jsonb,
        resolved_at = ${resolved ? new Date().toISOString() : null},
        receipt = coalesce(${receipt ? JSON.stringify(receipt) : null}::jsonb, receipt) where id = ${id}`;
      if (resolved) {
        await tx`update budget_ledger set settled = reserved where action_id = ${id} and settled is null`;
        const [pending] =
          await tx`select count(*)::int as count from action where job_id = ${job.id}
          and status in ('unknown', 'unresolved', 'dispatched')`;
        if (pending?.count === 0 && !late && currentJob.state === 'needs_reconciliation')
          await this.wake(tx, currentJob, 'recovery');
      } else if (!late && !['cancelled', 'failed', 'completed'].includes(currentJob.state)) {
        await this.moveJob(tx, currentJob, 'needs_reconciliation', {
          kind: 'user_input',
          question,
        });
      }
      return loadAction(tx, id);
    });
  }

  /**
   * The owner says what happened to an effect Melete could not confirm. The
   * answer settles it as `verify` would, recorded as the owner's, and the
   * action is never dispatched again. Only the job's own principal, in a space
   * they can still see, may answer; authentic provider evidence that arrives
   * later still lands (see `landAfterOwner`).
   */
  async resolveByOwner(
    actorId: string,
    id: string,
    input: { resolution: 'succeeded' | 'failed' | 'unresolved'; note?: string },
  ): Promise<
    { status: 'resolved'; action: Action } | { status: 'not_found' } | { status: 'not_awaiting' }
  > {
    const action = await loadAction(this.sql, id).catch(() => null);
    if (!action) return { status: 'not_found' };
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, action.job_id);
      if (!(await jobVisibleTo(tx, job.id, actorId))) return { status: 'not_found' as const };
      const current = await loadAction(tx, id, true);
      if (!['unknown', 'unresolved'].includes(current.status))
        return { status: 'not_awaiting' as const };
      const resolved = input.resolution !== 'unresolved';
      const decidedAt = new Date().toISOString();
      const [attempt] = await tx`select epoch from attempt where id = ${current.attempt_id}`;
      const late = attempt?.epoch !== job.lease_epoch;
      await this.setStatus(tx, current, input.resolution);
      await tx`update action set reconciliation = ${JSON.stringify({
        decided_by: 'owner',
        decided_at: decidedAt,
        resolution: input.resolution,
        note: input.note ?? '',
        late,
      })}::jsonb, resolved_at = ${resolved ? decidedAt : null} where id = ${id}`;
      await appendEvent(tx, job.id, current.attempt_id, 'notice', {
        action_id: id,
        phase: 'owner_resolved',
        resolution: input.resolution,
        late,
      });
      if (resolved) {
        await tx`update budget_ledger set settled = reserved where action_id = ${id} and settled is null`;
        const [pending] =
          await tx`select count(*)::int as count from action where job_id = ${job.id}
          and status in ('unknown', 'unresolved', 'dispatched')`;
        if (pending?.count === 0 && !late && job.state === 'needs_reconciliation')
          await this.wake(tx, job, 'recovery');
      }
      return { status: 'resolved' as const, action: await loadAction(tx, id) };
    });
  }

  /**
   * Evidence a provider sends after the owner answered for it. The owner's
   * answer stood in for evidence nobody had; authentic evidence is what
   * happened. A provider success over an owner's "failed" moves the action to
   * succeeded. A provider failure never undoes a success the owner reported,
   * since the effect may have happened by another route. Either way the
   * owner's answer is kept beside the provider's, and a disagreement is told.
   */
  private async landAfterOwner(
    tx: TransactionSql,
    job: LockedJob,
    action: Action,
    evidence: { outcome: 'succeeded'; receipt: Receipt } | { outcome: 'failed'; reason: string },
    late: boolean,
  ): Promise<Action> {
    const owner = (action.reconciliation ?? {}) as Record<string, unknown>;
    const provider =
      evidence.outcome === 'succeeded'
        ? { decision: 'succeeded', source: 'authentic_receipt', late }
        : { decision: 'failed', reason: evidence.reason, late };
    const already = (owner.provider_answer ?? {}) as Record<string, unknown>;
    if (already.decision === provider.decision) return action;
    const overturned = evidence.outcome === 'succeeded' && action.status === 'failed';
    const receipt =
      evidence.outcome === 'succeeded'
        ? await recordGeneratedArtifact(tx, job, action, { ...evidence.receipt, late })
        : null;
    if (overturned) await this.setStatus(tx, action, 'succeeded');
    await tx`update action set
      receipt = coalesce(${receipt ? JSON.stringify(receipt) : null}::jsonb, receipt),
      reconciliation = ${JSON.stringify(
        overturned
          ? { ...provider, superseded_owner_answer: owner }
          : { ...owner, provider_answer: provider },
      )}::jsonb
      where id = ${action.id}`;
    if (receipt && this.options.recordArtifact)
      await this.options.recordArtifact(tx, { job, action, receipt });
    if (evidence.outcome !== action.status)
      await appendEvent(tx, job.id, action.attempt_id, 'notice', {
        action_id: action.id,
        phase: 'provider_evidence',
        outcome: evidence.outcome,
        owner_answer: action.status,
        status: overturned ? 'succeeded' : action.status,
        late,
      });
    return loadAction(tx, action.id);
  }

  /** Only uncertain dispositions are recovered. This path never invokes execute(). */
  async recoverDispatched(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - this.dispatchTimeoutMs).toISOString();
    const rows = await this.sql`select id, connection_id, kind, canonical_payload, dispatched_at
      from action where status = 'dispatched' and dispatched_at <= ${cutoff}`;
    let recovered = 0;
    for (const row of rows) {
      // A dispatch its connector gave longer than the default is still inside
      // its own budget, and calling it unknown now would be a guess.
      const connector = this.options.connectors.get(row.connection_id);
      const budgetMs = connector
        ? this.dispatchBudget(connector, {
            kind: row.kind,
            canonical_payload: row.canonical_payload,
          })
        : this.dispatchTimeoutMs;
      if (new Date(row.dispatched_at).getTime() > now - budgetMs) continue;
      await this.recordResult(row.id, {
        outcome: 'unknown',
        reason: 'Dispatch ended without a durable receipt',
      });
      recovered += 1;
    }
    return recovered;
  }

  /** The broker's own timeout, or longer where the connector says this action needs it. */
  private dispatchBudget(
    connector: Connector,
    action: Pick<Action, 'kind' | 'canonical_payload'>,
  ): number {
    const asked = connector.dispatchBudgetMs?.(action);
    return typeof asked === 'number' && Number.isFinite(asked)
      ? Math.max(this.dispatchTimeoutMs, Math.min(asked, MAX_DISPATCH_BUDGET_MS))
      : this.dispatchTimeoutMs;
  }

  /** The service layer may use its own cancel transaction; both serialize on the same job row. */
  async cancel(jobId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, jobId);
      if (['cancelled', 'completed', 'failed'].includes(job.state)) return;
      await tx`update job set lease_epoch = lease_epoch + 1 where id = ${jobId}`;
      await this.moveJob(tx, job, 'cancelled', { kind: 'none' });
    });
  }

  private async setStatus(tx: Query, action: Action, status: ActionStatus) {
    await tx`update action set status = ${status} where id = ${action.id}`;
    await appendEvent(tx, action.job_id, action.attempt_id, 'action_status_changed', {
      action_id: action.id,
      from: action.status,
      to: status,
    });
  }

  private async rejectDispatch(
    tx: Query,
    job: LockedJob,
    action: Action,
    reason: string,
  ): Promise<Action> {
    await this.setStatus(tx, action, 'failed');
    await tx`update action set resolved_at = now(), reconciliation = ${JSON.stringify({ reason, retryable: false })}::jsonb where id = ${action.id}`;
    await tx`update budget_ledger set settled = 0 where action_id = ${action.id} and settled is null`;
    await appendEvent(tx, job.id, action.attempt_id, 'notice', {
      action_id: action.id,
      phase: 'dispatch_rejected',
      outcome: 'fenced',
      reason,
    });
    return loadAction(tx, action.id);
  }

  private async moveJob(tx: Query, job: LockedJob, state: string, wait: Record<string, unknown>) {
    await tx`update job set state = ${state}, wait = ${JSON.stringify(wait)}::jsonb,
      state_version = state_version + 1, updated_at = now() where id = ${job.id}`;
    await appendEvent(tx, job.id, null, 'job_state_changed', { from: job.state, to: state });
    job.state = state;
  }

  private async wake(tx: TransactionSql, job: LockedJob, reason: 'approval' | 'recovery') {
    await this.moveJob(tx, job, 'queued', { kind: 'none' });
    const [current] = await tx`update job set next_wake_at = now() where id = ${job.id}
      returning lease_epoch, state_version, scheduling_class, next_wake_at`;
    if (!current) throw new Error('Wake update returned no job');
    if (this.options.boss) {
      const wake: AttemptWake = {
        job_id: job.id,
        expected_epoch: current.lease_epoch,
        expected_version: current.state_version,
        reason,
      };
      await this.options.boss.send(attemptQueue(current.scheduling_class), wake, {
        startAfter: current.next_wake_at,
        retryLimit: 0,
        expireInSeconds: 1800,
        db: {
          executeSql: async (text, values) => ({
            rows: await tx.unsafe(text, values as ParameterOrJSON<never>[] | undefined),
          }),
        },
      });
    }
  }
}
