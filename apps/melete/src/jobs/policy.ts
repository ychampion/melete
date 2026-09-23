import {
  type ConnectionLifecycle,
  type ContextInvalidated,
  connectionGeneration,
  connectionLifecycle,
  jobBudget,
  policyGeneration,
  waitSpec,
} from '@melete/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import {
  action,
  approval,
  attempt,
  backgroundOperation,
  connection,
  job,
  secret,
  space,
  trigger,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { requestPrincipal, spaceAuthority } from '../principals/authority.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobService } from './service.ts';

/** Account changes commit fences before signalling disposable inference processes. */
export class PolicyService {
  constructor(
    readonly jobs: JobService,
    readonly runner?: AttemptRunner,
    readonly options: {
      /**
       * Runs inside a revocation, or a switch to another key, after its
       * authority and generation checks and before the key it replaces is
       * gone: what that key alone can undo is undone here. It never refuses
       * the change.
       */
      beforeKeyChange?: (
        connection: { id: string; provider: string },
        change: 'revoke' | 'switch',
      ) => Promise<void>;
    } = {},
  ) {}

  async invalidateInTransaction(
    tx: Transaction,
    spaceId: string,
    generation: number,
    connectionId: string | null,
    reason: ContextInvalidated['reason'],
  ): Promise<ContextInvalidated[]> {
    const affected = await tx.select({ id: job.id }).from(job).where(eq(job.spaceId, spaceId));
    const controls: ContextInvalidated[] = [];
    for (const candidate of affected) {
      const row = await this.jobs.lock(tx, candidate.id);
      if (!row) continue;
      const [running] = await tx
        .select()
        .from(attempt)
        .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt)));
      await tx.update(attempt).set({ contextSnapshotRef: null }).where(eq(attempt.jobId, row.id));
      const pending = await tx
        .select()
        .from(action)
        .where(
          and(
            eq(action.jobId, row.id),
            inArray(action.status, [
              'proposed',
              'needs_approval',
              'approved',
              'admitted',
              'dispatched',
            ]),
          ),
        );
      for (const effect of pending) {
        const status = effect.dispatchedAt ? 'unknown' : 'failed';
        await tx
          .update(action)
          .set({
            status,
            resolvedAt: effect.dispatchedAt ? null : new Date(),
            reconciliation: { reason, policy_generation: generation },
          })
          .where(eq(action.id, effect.id));
        await appendEvent(tx, {
          jobId: row.id,
          attemptId: effect.attemptId,
          type: 'action_status_changed',
          payload: { action_id: effect.id, from: effect.status, to: status, reason },
          dedupKey: `${effect.id}:generation:${generation}`,
        });
        const decisions = await tx
          .update(approval)
          .set({ decision: 'denied', decidedAt: new Date(), decidedBy: 'owner' })
          .where(and(eq(approval.actionId, effect.id), isNull(approval.decision)))
          .returning();
        for (const decision of decisions)
          await appendEvent(tx, {
            jobId: row.id,
            attemptId: effect.attemptId,
            type: 'approval_decided',
            payload: {
              approval_id: decision.id,
              action_id: effect.id,
              decision: 'denied',
              payload_hash: decision.payloadHash,
              reason,
            },
            dedupKey: `${decision.id}:decision`,
          });
      }
      // Local continuations carry inference context; remote accepted effects keep their own truth.
      await tx
        .update(backgroundOperation)
        .set({
          state: 'interrupted',
          leaseExpiresAt: null,
          substrateDisposition: 'local_process_interrupted',
          version: sql`${backgroundOperation.version} + 1`,
        })
        .where(
          and(
            eq(backgroundOperation.jobId, row.id),
            eq(backgroundOperation.kind, 'local_process'),
            inArray(backgroundOperation.state, ['registered', 'ready', 'claimed']),
          ),
        );
      const payload = {
        type: 'context_invalidated' as const,
        job_id: row.id,
        policy_generation: generation,
        connection_id: connectionId,
        reason,
      };
      await appendEvent(tx, {
        jobId: row.id,
        attemptId: running?.id,
        type: 'context_invalidated',
        payload: { ...payload, ...(running ? { attempt_id: running.id } : {}) },
        dedupKey: `${row.id}:context:${generation}`,
      });
      if (running && row.state === 'running') {
        const control = { ...payload, attempt_id: running.id };
        controls.push(control);
        await tx
          .update(attempt)
          .set({
            endedAt: new Date(),
            outcome: 'fenced',
            outcomeDetail: control,
            leaseExpiresAt: null,
            leaseStatus: 'context_invalidated',
          })
          .where(eq(attempt.id, running.id));
        await appendEvent(tx, {
          jobId: row.id,
          attemptId: running.id,
          type: 'attempt_ended',
          payload: control,
          dedupKey: `${running.id}:ended`,
        });
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(attempt)
          .where(eq(attempt.jobId, row.id));
        await this.jobs.move(
          tx,
          row,
          {
            kind: 'attempt_failed',
            retryable: true,
            attempts_remaining: Math.max(
              0,
              jobBudget.parse(row.budget).max_attempts - Number(count?.n ?? 0),
            ),
          },
          { attemptId: running.id, bumpEpoch: true, reason: 'recovery', payload: { reason } },
        );
      } else if (
        row.state === 'waiting_for_approval' &&
        pending.some((effect) => effect.status === 'needs_approval')
      ) {
        await this.jobs.move(
          tx,
          row,
          { kind: 'approval_decided', decision: 'denied' },
          { reason: 'approval', payload: { reason } },
        );
      } else if (row.state === 'waiting_for_event_or_time' && connectionId) {
        const wait = waitSpec.parse(row.wait);
        if (wait.kind === 'event') {
          const [registration] = await tx
            .select()
            .from(trigger)
            .where(eq(trigger.id, wait.trigger_id));
          if (
            (registration?.spec as { connection_id?: string } | undefined)?.connection_id ===
            connectionId
          )
            await this.jobs.move(
              tx,
              row,
              { kind: 'event_fired' },
              { reason: 'recovery', payload: { reason } },
            );
        }
      }
    }
    return controls;
  }
  private async signal(controls: ContextInvalidated[]) {
    for (const control of controls) await this.runner?.invalidateContext(control);
  }

  async changeConnection(id: string, input: ConnectionLifecycle) {
    const request = connectionLifecycle.parse(input);
    const result = await this.jobs.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, id))
        .for('update');
      if (!source) throw new ServiceError('not_found', 'Connection not found.', 404);
      if (
        requestPrincipal() &&
        (await spaceAuthority(tx, source.spaceId, requestPrincipal(), true)).role !== 'owner'
      )
        throw new ServiceError('scope_denied', 'Space owner required.', 403);
      if (source.generation !== request.expected_generation)
        throw new ServiceError('generation_conflict', 'The connection generation changed.');
      if (request.kind === 'switch') {
        const [credential] = await tx
          .select({ id: secret.id })
          .from(secret)
          .where(and(eq(secret.id, request.secret_ref), eq(secret.spaceId, source.spaceId)));
        if (!credential)
          throw new ServiceError(
            'invalid_credential',
            'Choose a credential in the same space.',
            400,
          );
      }
      if (
        (request.kind === 'revoke' && source.status !== 'revoked') ||
        (request.kind === 'switch' && request.secret_ref !== source.secretRef)
      )
        await this.options.beforeKeyChange?.(
          { id: source.id, provider: source.provider },
          request.kind,
        );
      const [parent] = await tx
        .update(space)
        .set({ policyGeneration: sql`${space.policyGeneration} + 1` })
        .where(eq(space.id, source.spaceId))
        .returning();
      if (!parent) throw new Error('Connection space disappeared');
      const [updated] = await tx
        .update(connection)
        .set({
          generation: source.generation + 1,
          status: request.kind === 'revoke' ? 'revoked' : 'active',
          secretRef: request.kind === 'switch' ? request.secret_ref : null,
          health: 'unknown',
          lastCheckedAt: null,
        })
        .where(eq(connection.id, id))
        .returning();
      if (!updated) throw new Error('Locked connection disappeared');
      if (request.kind === 'revoke')
        await tx
          .update(trigger)
          .set({ enabled: false })
          .where(
            and(
              // A watch listens on its connection exactly as an event trigger does.
              inArray(trigger.kind, ['event', 'watch']),
              sql`${trigger.spec}->>'connection_id' = ${id}`,
            ),
          );
      const controls = await this.invalidateInTransaction(
        tx,
        source.spaceId,
        parent.policyGeneration,
        id,
        request.kind === 'switch' ? 'credential_switched' : 'connection_revoked',
      );
      return {
        response: connectionGeneration.parse({
          connection_id: id,
          generation: updated.generation,
          policy_generation: parent.policyGeneration,
          status: updated.status,
        }),
        controls,
      };
    });
    await this.signal(result.controls);
    return result.response;
  }

  async changePolicy(spaceId: string, expectedGeneration: number) {
    const result = await this.jobs.transaction(async (tx) => {
      const [parent] = await tx.select().from(space).where(eq(space.id, spaceId)).for('update');
      if (!parent) throw new ServiceError('not_found', 'Space not found.', 404);
      if (
        requestPrincipal() &&
        (await spaceAuthority(tx, spaceId, requestPrincipal(), true)).role !== 'owner'
      )
        throw new ServiceError('scope_denied', 'Space owner required.', 403);
      if (parent.policyGeneration !== expectedGeneration)
        throw new ServiceError('generation_conflict', 'The policy generation changed.');
      const generation = parent.policyGeneration + 1;
      await tx.update(space).set({ policyGeneration: generation }).where(eq(space.id, spaceId));
      return {
        response: policyGeneration.parse({ space_id: spaceId, policy_generation: generation }),
        controls: await this.invalidateInTransaction(
          tx,
          spaceId,
          generation,
          null,
          'policy_changed',
        ),
      };
    });
    await this.signal(result.controls);
    return result.response;
  }
}
