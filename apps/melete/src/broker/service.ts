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
  findTool,
  jobConstraints,
  type ProposeActionRequest,
  type ProposeActionResponse,
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
  /** Approval lifetime is service policy, never a value supplied by a tool caller. */
  approvalTtlMs?: number;
};

const question =
  'Melete cannot confirm whether this was sent. Check the destination, then mark it.';
const needsApproval = (tool: ConnectorTool) =>
  tool.requires_approval || tool.effect_class === 'write_external' || tool.effect_class === 'spend';

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

  private async tool(
    tx: Query,
    job: LockedJob,
    claims: CapabilityClaims,
    connectionId: string,
    kind: string,
  ) {
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
      for (const connection of connections) {
        const connector = this.options.connectors.get(connection.id);
        if (!connector || connector.manifest.provider !== connection.provider) continue;
        for (const tool of connector.manifest.tools) {
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

  private async proposalView(action: Action): Promise<ProposeActionResponse> {
    const [approval] = await this.sql`select id from approval where action_id = ${action.id}
      and payload_hash = ${action.payload_hash}`;
    return {
      action_id: action.id,
      status: action.status,
      effect_class: action.effect_class,
      payload_hash: action.payload_hash,
      canonical_payload: action.canonical_payload,
      requires_approval: Boolean(approval),
      approval_id: approval?.id ?? null,
    };
  }

  async propose(
    claims: CapabilityClaims,
    request: ProposeActionRequest,
  ): Promise<ProposeActionResponse> {
    const canonical = canonicalizePayload(request.payload);
    const action = await this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      const { tool } = await this.tool(tx, job, claims, request.connection_id, request.kind);
      this.validatePayload(tool, canonical.canonical);
      const ref =
        request.client_ref === undefined
          ? null
          : `broker:proposal:${job.id}:${createHash('sha256').update(request.client_ref).digest('hex')}`;
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
          return existing;
        }
      }
      const id = recordId('act');
      const [row] = await tx`insert into action
        (id, job_id, attempt_id, connection_id, kind, effect_class, canonical_payload, payload_hash, idempotency_key)
        values (${id}, ${job.id}, ${claims.attempt_id}, ${request.connection_id}, ${request.kind},
          ${tool.effect_class}, ${canonical.json}::jsonb, ${canonical.hash}, ${id}) returning *`;
      if (!row) throw new Error('Action insert returned no record');
      const created = actionFromRow(row);
      const expiresAt = needsApproval(tool)
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
        { action_id: id, kind: request.kind, payload_hash: canonical.hash },
        ref ?? undefined,
      );
      if (needsApproval(tool)) {
        const approvalId = recordId('apr');
        await tx`insert into approval (id, action_id, job_revision, payload_hash, expires_at)
          values (${approvalId}, ${id}, ${job.revision}, ${canonical.hash}, ${expiresAt})`;
        await this.setStatus(tx, actionFromRow(row), 'needs_approval');
        await appendEvent(tx, job.id, claims.attempt_id, 'approval_requested', {
          action_id: id,
          approval_id: approvalId,
        });
        if (job.state === 'running') {
          await this.moveJob(tx, job, 'waiting_for_approval', {
            kind: 'approval',
            action_ids: [id],
          });
        }
      }
      return loadAction(tx, id);
    });
    // Repeated proposals retrieve the durable disposition; unknown is never replayed.
    if (action.status === 'proposed' || action.status === 'approved') {
      await this.admit(claims, action.id, canonical.hash);
      return this.proposalView(await this.dispatch(action.id));
    }
    // A crash between the two durable steps has not sent anything yet.
    if (action.status === 'admitted') return this.proposalView(await this.dispatch(action.id));
    return this.proposalView(action);
  }

  async decide(id: string, request: ApprovalDecisionRequest) {
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
        if (!['proposed', 'approved'].includes(action.status))
          throw new BrokerFault('action_not_admissible');
        let authorization: string | null = null;
        let expiresAt: string | null = null;
        if (needsApproval(tool)) {
          const [approval] = await tx`select * from approval where action_id = ${id}
            and payload_hash = ${action.payload_hash} for update`;
          if (approval?.decision !== 'approved' || action.status !== 'approved')
            throw new BrokerFault('approval_required');
          if (approval.job_revision !== job.revision) throw new BrokerFault('revision_mismatch');
          if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now())
            throw new BrokerFault('approval_required', 'Approval expired');
          authorization = approval.id;
          expiresAt = approval.expires_at ? new Date(approval.expires_at).toISOString() : null;
        }
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
