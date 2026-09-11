import { createHash } from 'node:crypto';
import {
  type Action,
  type ActionStatus,
  type ApprovalDecisionRequest,
  type CapabilityClaims,
  type ConnectorTool,
  canonicalizePayload,
  type DispatchResult,
  dispatchResult,
  type EffectProposalResponse,
  findTool,
  hashOriginWarnings,
  intentKey,
  isTrustGatedEffect,
  jobConstraints,
  type OriginWarning,
  originWarnings,
  type ProposeActionRequest,
  type Receipt,
  type ToolSpec,
  type VerifyResult,
  verifyResult,
} from '@melete/contracts';
import { Ajv } from 'ajv';
import type { PgBoss } from 'pg-boss';
import type { ParameterOrJSON, Sql, TransactionSql } from 'postgres';
import { checkConnectionGeneration } from '../connectors/generation.ts';
import type { Connector, ConnectorContext } from '../connectors/types.ts';
import { agentAccess, directSend } from '../experience/access.ts';
import { plainText } from '../experience/projectors.ts';
import { QUEUES } from '../jobs/queue.ts';
import {
  bindEffect,
  type EffectAuthorityResolver,
  loadBinding,
  requireMatchingBinding,
  resolveEffectAuthority,
  saveBinding,
} from './authority.ts';
import { type ReservationRequest, reserveLocked } from './budget.ts';
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
   * Where the values in a payload came from. The memory lane supplies the real
   * resolver; without one the broker asks nobody and warns about nothing, which
   * is what v0.1 ships until that lane lands.
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
  private readonly validator = new Ajv({ strict: false, allErrors: false });
  private readonly dispatchTimeoutMs: number;

  constructor(private readonly options: BrokerOptions) {
    this.sql = options.sql;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
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
    const [connection] = await tx`select provider, scopes, status from connection
      where id = ${connectionId} and space_id = ${job.space_id} for share`;
    if (connection?.status !== 'active') throw new BrokerFault('unknown_connection');
    const connector = this.options.connectors.get(connectionId);
    if (!connector || connector.manifest.provider !== connection.provider)
      throw new BrokerFault('connector_unavailable');
    const tool = findTool(connector.manifest, kind);
    if (!tool) throw new BrokerFault('unknown_tool');
    const required = new Set([...tool.required_scopes, tool.name]);
    if (
      ![...required].every(
        (scope) => claims.scopes.includes(scope) && connection.scopes.includes(scope),
      )
    ) {
      throw new BrokerFault('scope_denied');
    }
    return { tool, connector };
  }

  async catalog(claims: CapabilityClaims): Promise<ToolSpec[]> {
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const connections = await tx`select id, provider, scopes from connection
        where space_id = ${job.space_id} and status = 'active' order by id`;
      const tools: ToolSpec[] = [];
      const access = await agentAccess(tx, job.id);
      for (const connection of connections) {
        if (
          access.missingAgent ||
          (access.chat && !access.agentId) ||
          (access.allowed && !access.allowed.includes(connection.id))
        )
          continue;
        const connector = this.options.connectors.get(connection.id);
        if (!connector || connector.manifest.provider !== connection.provider) continue;
        for (const tool of connector.manifest.tools) {
          if (access.chat && directSend(tool.name)) continue;
          if (
            ![tool.name, ...tool.required_scopes].every(
              (s) => claims.scopes.includes(s) && connection.scopes.includes(s),
            )
          )
            continue;
          tools.push({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
            effect_class: tool.effect_class,
            connection_id: connection.id,
          });
        }
      }
      if (access.chat)
        tools.push({
          name: 'say',
          description:
            'Tell the person in one or two first-person sentences what you will do next. Do not include reasoning, internal names, or technical details. This narration has no action cost and needs no approval.',
          input_schema: {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1, maxLength: 600 } },
            required: ['text'],
            additionalProperties: false,
          },
          effect_class: 'read',
          connection_id: null,
        });
      return tools.sort((a, b) =>
        a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : (a.connection_id ?? '').localeCompare(b.connection_id ?? '', 'en'),
      );
    });
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

  private validatePayload(tool: ConnectorTool, payload: Action['canonical_payload']) {
    if (!this.validator.validate(tool.input_schema, payload))
      throw new BrokerFault('payload_invalid');
  }

  private async proposalView(
    action: Action,
    key: string,
    repeated: boolean,
  ): Promise<EffectProposalResponse> {
    const [approval] = await this
      .sql`select id, origin_warnings from approval where action_id = ${action.id}
      and payload_hash = ${action.payload_hash}`;
    return {
      action_id: action.id,
      status: action.status,
      effect_class: action.effect_class,
      payload_hash: action.payload_hash,
      canonical_payload: action.canonical_payload,
      requires_approval: Boolean(approval) && approval?.decision !== 'approved',
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
          tool.name !== 'email.draft',
      );
    const gated = isTrustGatedEffect(tool.effect_class);
    const fields = gated ? collectOriginFields(action.canonical_payload) : [];
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
    if (job.state === 'running')
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
  ): Promise<EffectProposalResponse> {
    const canonical = canonicalizePayload(request.payload);
    const proposal = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const access = await agentAccess(tx, job.id);
      if (access.chat && directSend(request.kind))
        throw new BrokerFault('scope_denied', 'Review the draft and use its send control.');
      const { tool } = await this.tool(tx, job, claims, request.connection_id, request.kind);
      this.validatePayload(tool, canonical.canonical);
      // The identity of the effect itself, independent of which attempt is
      // alive. A runtime that died between proposing and hearing back proposes
      // the same key and is handed the action it already made.
      const key = intentKey({
        job_id: job.id,
        job_revision: job.revision,
        connection_id: request.connection_id,
        kind: request.kind,
        payload_hash: canonical.hash,
        ...(access.turnId ? { turn_id: access.turnId } : {}),
      });
      const ref =
        request.client_ref === undefined
          ? null
          : `broker:proposal:${job.id}:${createHash('sha256')
              .update(access.turnId ? `${access.turnId}:${request.client_ref}` : request.client_ref)
              .digest('hex')}`;
      if (ref) {
        const [event] = await tx`select payload from event where dedup_key = ${ref}`;
        if (event) {
          const existing = await loadAction(tx, event.payload.action_id);
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
      await this.admit(claims, action.id, canonical.hash);
      return this.proposalView(await this.dispatch(action.id), key, repeated);
    }
    // A crash between the two durable steps has not sent anything yet.
    if (action.status === 'admitted')
      return this.proposalView(await this.dispatch(action.id), key, repeated);
    return this.proposalView(action, key, repeated);
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
        const { tool } = await this.tool(tx, job, claims, action.connection_id, action.kind);
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

  private context(job: LockedJob, action: Action): ConnectorContext {
    return {
      job_id: job.id,
      space_id: job.space_id,
      idempotency_key: action.id,
      constraints: jobConstraints.parse(job.constraints),
    };
  }

  async dispatch(id: string): Promise<Action> {
    const original = await loadAction(this.sql, id);
    const prepared = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, original.job_id);
      const action = await loadAction(tx, id, true);
      if (action.status !== 'admitted') return { action, context: null };
      const [connection] = await tx`select status, provider, scopes from connection
        where id = ${action.connection_id} and space_id = ${job.space_id} for share`;
      const stored = await loadBinding(tx, action);
      try {
        const access = await agentAccess(tx, job.id);
        if (
          access.paused ||
          (access.allowed && !access.allowed.includes(action.connection_id)) ||
          access.missingAgent ||
          (access.chat && (!access.agentId || directSend(action.kind)))
        )
          throw new BrokerFault('scope_denied');
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
        if (fenced)
          return {
            action: await this.rejectDispatch(tx, job, action, fenced.reason),
            context: null,
          };
        const connector = this.options.connectors.get(action.connection_id);
        const tool = connector && findTool(connector.manifest, action.kind);
        if (
          !connector ||
          connector.manifest.provider !== connection?.provider ||
          !tool ||
          ![tool.name, ...tool.required_scopes].every((scope) => connection.scopes.includes(scope))
        )
          throw new BrokerFault('scope_denied');
        requireMatchingBinding(
          stored,
          bindEffect(action, job, authority, stored.tuple.expires_at as string | null),
        );
        // Admission authorized these origins. If the world has since learned
        // that one of them came from somewhere else, nothing leaves.
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
    const connector = this.options.connectors.get(prepared.action.connection_id);
    if (!connector)
      return this.recordResult(id, {
        outcome: 'unknown',
        reason: 'Connector disappeared after dispatch admission',
      });
    const controller = new AbortController();
    const execution = Promise.resolve()
      .then(() =>
        connector.execute(prepared.action, {
          ...(prepared.context as ConnectorContext),
          signal: controller.signal,
        }),
      )
      .then((result) => dispatchResult.parse(result))
      .catch(
        (): DispatchResult => ({
          outcome: 'unknown',
          reason: 'The destination did not return a confirmed acknowledgement',
        }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.dispatchTimeoutMs);
    });
    const result = await Promise.race([execution, timeout]);
    clearTimeout(timer);
    if (result === 'timeout') {
      controller.abort();
      const unknown = await this.recordResult(id, { outcome: 'unknown', reason: question });
      // A cooperative abort is not proof of non-delivery; a later receipt is still a fact.
      void execution.then((late) => this.recordResult(id, late)).catch(() => {});
      return unknown;
    }
    return this.recordResult(id, result);
  }

  async recordResult(id: string, result: DispatchResult): Promise<Action> {
    result = dispatchResult.parse(result);
    const original = await loadAction(this.sql, id);
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, original.job_id);
      const action = await loadAction(tx, id, true);
      if (!['dispatched', 'unknown', 'unresolved'].includes(action.status)) return action;
      const [attempt] = await tx`select epoch from attempt where id = ${action.attempt_id}`;
      const late = attempt?.epoch !== job.lease_epoch;
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
        } else receipt = { ...result.receipt, late };
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
    if (!['unknown', 'unresolved'].includes(action.status)) return action;
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
      if (!['unknown', 'unresolved'].includes(current.status)) return current;
      const [attempt] = await tx`select epoch from attempt where id = ${current.attempt_id}`;
      const late = attempt?.epoch !== currentJob.lease_epoch;
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
        result.decision === 'succeeded' && result.receipt ? { ...result.receipt, late } : null;
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

  /** Only uncertain dispositions are recovered. This path never invokes execute(). */
  async recoverDispatched(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - this.dispatchTimeoutMs).toISOString();
    const rows = await this
      .sql`select id from action where status = 'dispatched' and dispatched_at <= ${cutoff}`;
    for (const row of rows)
      await this.recordResult(row.id, {
        outcome: 'unknown',
        reason: 'Dispatch ended without a durable receipt',
      });
    return rows.length;
  }

  /** W1 may use its own cancel transaction; both serialize on the same job row. */
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
    await tx`update job set next_wake_at = now() where id = ${job.id}`;
    if (this.options.boss) {
      await this.options.boss.send(
        QUEUES.attempt,
        { job_id: job.id, expected_epoch: job.lease_epoch, reason },
        {
          singletonKey: `${job.id}:${job.lease_epoch}`,
          db: {
            executeSql: async (text, values) => ({
              rows: await tx.unsafe(text, values as ParameterOrJSON<never>[] | undefined),
            }),
          },
        },
      );
    }
  }
}
