import { browserControlResponse } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../../api/errors.ts';
import { appendEvent } from '../../broker/records.ts';
import type { ConnectorContext } from '../../connectors/types.ts';
import type { BrowserWorkerClient } from './client.ts';
import { BrowserLiveService, type BrowserLiveServiceOptions } from './live-service.ts';
import { BrowserFault, type BrowserSession } from './sessions.ts';
import { BrowserSiteService } from './sites.ts';

export type BrowserWorkers = {
  get(spaceId: string): Promise<BrowserWorkerClient>;
  /** Where one directory per space lives, and how one space's worker stops: see forgetSpace. */
  readonly spacesRoot?: string;
  release?(spaceId: string): Promise<void>;
};
type Binding = Pick<BrowserSession, 'id' | 'space_id' | 'job_id' | 'control_epoch' | 'control'>;
export const browserInputReasons = new Set([
  'stale_control_epoch',
  'human_control',
  'fresh_observation_required',
  'sensitive_input_require_takeover',
]);

/** The database maps a worker session to service-owned authority; tool arguments cannot rebind it. */
export class BrowserSessionService {
  onPark?: (jobId: string, attemptIds: string[]) => void;
  /** The live views of these sessions, in memory for as long as the process runs. */
  readonly live: BrowserLiveService;
  /** The sites these sessions have signed in to, recorded over the space's one profile. */
  readonly sites: BrowserSiteService;
  constructor(
    readonly sql: Sql,
    readonly workers: BrowserWorkers,
    options: { live?: BrowserLiveServiceOptions } = {},
  ) {
    this.live = new BrowserLiveService(this, options.live);
    this.sites = new BrowserSiteService(sql, workers);
  }

  async record(session: BrowserSession, scope: { space_id: string; job_id: string }) {
    if (session.space_id !== scope.space_id || session.job_id !== scope.job_id)
      throw new BrowserFault('session_scope_mismatch');
    await this
      .sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
      values (${session.id}, ${scope.space_id}, ${scope.job_id}, ${session.control_epoch}, ${session.control})
      on conflict (id) do update set control_epoch = excluded.control_epoch,
        control = excluded.control, updated_at = now()
      where browser_session_binding.space_id = excluded.space_id
        and browser_session_binding.job_id = excluded.job_id
        and browser_session_binding.control_epoch <= excluded.control_epoch`;
  }

  async lease(ctx: ConnectorContext, sessionId?: string) {
    if (sessionId) await this.authorize(sessionId, ctx);
    const worker = await this.workers.get(ctx.space_id);
    const session = await worker.lease(ctx.job_id, {
      public_compartment: ctx.constraints.public_compartment,
      allowed_domains: [...ctx.constraints.allowed_domains],
    });
    if (sessionId && session.id !== sessionId) throw new BrowserFault('session_not_found');
    await this.record(session, ctx);
    return { session, worker };
  }

  async authorize(
    sessionId: string,
    scope?: { space_id: string; job_id: string },
  ): Promise<Binding> {
    const [binding] = await this.sql<
      Binding[]
    >`select b.id, b.space_id, b.job_id, b.control_epoch, b.control
      from browser_session_binding b join job j on j.id = b.job_id and j.space_id = b.space_id
      join space s on s.id = b.space_id where b.id = ${sessionId}`;
    if (
      !binding ||
      (scope && (binding.space_id !== scope.space_id || binding.job_id !== scope.job_id))
    )
      throw new BrowserFault('session_not_found');
    return binding;
  }

  /** The epoch is fenced durably before any replacement runtime can start. No model decision is involved. */
  async park(
    scope: { space_id: string; job_id: string },
    sessionId: string,
    reason: string,
    expectedAttemptId?: string,
  ) {
    await this.authorize(sessionId, scope);
    const fenced = await this.sql.begin(async (tx) => {
      const [job] =
        await tx`select id, space_id, state, lease_epoch, wait from job where id = ${scope.job_id} for update`;
      if (
        !job ||
        job.space_id !== scope.space_id ||
        ['completed', 'cancelled', 'failed'].includes(job.state)
      )
        return [];
      if (expectedAttemptId) {
        const [execution] =
          await tx`select epoch, ended_at from attempt where id = ${expectedAttemptId} and job_id = ${scope.job_id}`;
        if (!execution || execution.epoch !== job.lease_epoch || execution.ended_at) return [];
      }
      if (job.state === 'waiting_for_input' && job.wait?.question?.startsWith('Browser control:'))
        return [];
      const state =
        job.state === 'needs_reconciliation' ? 'needs_reconciliation' : 'waiting_for_input';
      const wait =
        state === 'needs_reconciliation'
          ? job.wait
          : {
              kind: 'user_input',
              question: `Browser control: ${reason}. Return control, then request a fresh observation before continuing.`,
            };
      await tx`update job set state = ${state}, wait = ${JSON.stringify(wait)}::jsonb,
        lease_epoch = lease_epoch + 1, state_version = state_version + 1,
        next_wake_at = null, updated_at = now() where id = ${scope.job_id}`;
      const attempts = await tx`update attempt set outcome = 'fenced',
        outcome_detail = ${JSON.stringify({ kind: 'browser_control', session_id: sessionId, reason })}::jsonb,
        ended_at = now(), lease_expires_at = null, lease_status = 'ended'
        where job_id = ${scope.job_id} and ended_at is null returning id`;
      for (const attempt of attempts)
        await appendEvent(
          tx,
          scope.job_id,
          attempt.id,
          'attempt_ended',
          { kind: 'browser_control', session_id: sessionId, reason },
          `${attempt.id}:ended`,
        );
      await appendEvent(tx, scope.job_id, null, 'job_state_changed', {
        from: job.state,
        to: state,
        reason,
        session_id: sessionId,
      });
      return attempts.map((attempt) => String(attempt.id));
    });
    // Signal only attempts fenced by this transaction; a newly resumed attempt is a different lease.
    if (fenced.length) this.onPark?.(scope.job_id, fenced);
  }

  /**
   * A person may steer only the browser of a job they own, in a space they may
   * still use. Anything else reads as an absent session, before the worker moves.
   * Every route a person reaches asks this one question.
   */
  async steerable(sessionId: string, principalId?: string): Promise<Binding & { job_id: string }> {
    const binding = await this.authorize(sessionId);
    if (!binding.job_id) throw new BrowserFault('session_not_found');
    if (principalId) {
      const [owned] = await this.sql`select 1 from job j join space s on s.id = j.space_id
        where j.id = ${binding.job_id} and j.space_id = ${binding.space_id}
          and coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId}
          and ((s.kind = 'personal'
              and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
            or (s.kind = 'shared' and exists (select 1 from space_membership m
              where m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null)))`;
      if (!owned) throw new BrowserFault('session_not_found');
    }
    return { ...binding, job_id: binding.job_id };
  }

  /**
   * A person's control is recorded before the worker is asked for it, so nothing can be learned
   * into a recipe in between. A worker that refuses leaves the binding as it found it.
   */
  private async hold(sessionId: string): Promise<Binding | undefined> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<
        Binding[]
      >`select id, space_id, job_id, control_epoch, control from browser_session_binding
        where id = ${sessionId} for update`;
      if (!before) return undefined;
      await tx`update browser_session_binding set control = 'human', updated_at = now()
        where id = ${sessionId}`;
      return before;
    });
  }

  private async release(before: Binding): Promise<void> {
    await this.sql`update browser_session_binding set control = ${before.control},
      updated_at = now() where id = ${before.id} and control = 'human'
        and control_epoch = ${before.control_epoch}`;
  }

  async control(sessionId: string, operation: 'takeover' | 'handback', principalId?: string) {
    const binding = await this.steerable(sessionId, principalId);
    const worker = await this.workers.get(binding.space_id);
    const held = operation === 'takeover' ? await this.hold(sessionId) : undefined;
    // The worker bumps immediately, before the database transaction can wait on any job row lock.
    const session: BrowserSession & { site?: string } = await worker[operation](sessionId).catch(
      async (error: unknown) => {
        // A refusal leaves control where it was. An unfinished call may have taken control, so
        // that binding stays with the person until a lease records what the worker really holds.
        if (held && error instanceof BrowserFault) await this.release(held);
        throw error;
      },
    );
    const scope = { space_id: binding.space_id, job_id: binding.job_id };
    await this.record(session, scope);
    // Any live view of this session belongs to the epoch that has just ended.
    this.live.ended(sessionId);
    if (operation === 'takeover') await this.park(scope, sessionId, 'human_control');
    else {
      await appendEvent(this.sql, scope.job_id, null, 'notice', {
        kind: 'browser_handback',
        session_id: sessionId,
        control_epoch: session.control_epoch,
        fresh_observation_required: true,
      });
      // The takeover ended on a site whose cookies the profile now holds: the space is signed in.
      if (session.site) await this.sites.record(binding.space_id, session.site);
    }
    return {
      session_id: session.id,
      control_epoch: session.control_epoch,
      control: session.control,
      fresh_observation_required: true,
    };
  }
}

/** Mounted after the existing owner session and same-origin middleware. */
export function mountBrowserSessions(app: Hono, sessions: BrowserSessionService) {
  for (const operation of ['takeover', 'handback'] as const) {
    app.post(`/browser/sessions/:id/${operation}`, async (c) => {
      try {
        return c.json(
          browserControlResponse.parse(
            await sessions.control(c.req.param('id'), operation, c.get('owner').id),
          ),
        );
      } catch (error) {
        if (error instanceof BrowserFault)
          throw new ServiceError(
            error.reason,
            `Browser control could not change: ${error.reason}.`,
            error.reason === 'session_not_found' ? 404 : 409,
          );
        throw error;
      }
    });
  }
}
