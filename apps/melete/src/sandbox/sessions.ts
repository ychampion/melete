/**
 * The lease on a remote sandbox.
 *
 * A session is written before its sandbox is created, so the database decides
 * whether this attempt may have a sandbox at all, and a crash between the two
 * leaves a row the sweeper and the reconciler can finish. The sandbox is
 * labelled with the session id, so a sandbox whose row never became `ready`
 * is recognisable as this installation's orphan.
 *
 * Sandbox time is always metered onto the row. A cap is optional and belongs
 * to the job: when one is given and the job has used it, opening another
 * session is refused. Nothing here ever stops a sandbox or a command because
 * of the cap; a renewal is never refused for time used.
 */
import type { Sql, TransactionSql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { checkSpec, LABEL_SESSION, SandboxRefusal, type SessionPersistence } from './manifest.ts';
import type { SessionStatus } from './schema.ts';
import type { EgressPolicy, SandboxHandle, SandboxProvider, SandboxSpec } from './types.ts';

export const PENDING_SANDBOX = 'pending:';

export type SessionRow = {
  id: string;
  connectionId: string;
  spaceId: string;
  jobId: string | null;
  attemptId: string | null;
  agentId: string | null;
  adapter: string;
  providerSandboxId: string;
  imageRef: string;
  imageDigest: string | null;
  region: string | null;
  egressPolicy: EgressPolicy;
  persistence: SessionPersistence;
  resumeRef: string | null;
  status: SessionStatus;
  leaseExpiresAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  secondsCharged: number | null;
  budgetLedgerId: string | null;
  lastError: string | null;
};

export type OpenSession = {
  connectionId: string;
  spaceId: string;
  jobId: string | null;
  attemptId: string | null;
  agentId: string | null;
  persistence?: SessionPersistence;
  /** The job's sandbox-time budget in seconds. Absent or null means no cap. */
  maxSandboxSeconds?: number | null;
};

type Query = Sql | TransactionSql;
type Row = Record<string, unknown>;

/** The driver may hand back a timestamp as a Date or as Postgres text. */
const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));

const toRow = (row: Row): SessionRow => ({
  id: row.id as string,
  connectionId: row.connection_id as string,
  spaceId: row.space_id as string,
  jobId: (row.job_id as string | null) ?? null,
  attemptId: (row.attempt_id as string | null) ?? null,
  agentId: (row.agent_id as string | null) ?? null,
  adapter: row.adapter as string,
  providerSandboxId: row.provider_sandbox_id as string,
  imageRef: row.image_ref as string,
  imageDigest: (row.image_digest as string | null) ?? null,
  region: (row.region as string | null) ?? null,
  egressPolicy: row.egress_policy as EgressPolicy,
  persistence: row.persistence as SessionPersistence,
  resumeRef: (row.resume_ref as string | null) ?? null,
  status: row.status as SessionStatus,
  leaseExpiresAt: toDate(row.lease_expires_at),
  openedAt: toDate(row.opened_at),
  closedAt: row.closed_at === null || row.closed_at === undefined ? null : toDate(row.closed_at),
  secondsCharged: row.seconds_charged === null ? null : Number(row.seconds_charged),
  budgetLedgerId: (row.budget_ledger_id as string | null) ?? null,
  lastError: (row.last_error as string | null) ?? null,
});

export const sessionHandle = (row: SessionRow): SandboxHandle => ({
  providerSandboxId: row.providerSandboxId,
  imageDigest: row.imageDigest,
  region: row.region,
});

const uniqueViolation = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && error.code === '23505'
    ? String((error as { constraint_name?: string }).constraint_name ?? '')
    : null;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Mark a session lost. With `from`, only while it is still in that status, so
 * a session that changed after it was looked at is left to its new owner.
 */
export async function markSessionLost(
  sql: Query,
  id: string,
  reason: string,
  from?: SessionStatus,
): Promise<boolean> {
  const statuses = from ? [from] : ['opening', 'ready', 'paused', 'closing'];
  const rows = await sql`update sandbox_session set status = 'lost', closed_at = now(),
      seconds_charged = coalesce(seconds_charged, extract(epoch from now() - opened_at)),
      last_error = ${reason}
    where id = ${id} and status in ${sql(statuses)}
    returning id`;
  return rows.length > 0;
}

/** Time used by one job's sandboxes: live sessions count up to now, ended ones as charged. */
async function usedSeconds(tx: Query, jobId: string): Promise<number> {
  const [row] = await tx`select coalesce(sum(case
      when status in ('opening', 'ready', 'closing')
        then greatest(coalesce(seconds_charged, 0), extract(epoch from now() - opened_at))
      else coalesce(seconds_charged, 0) end), 0)::float8 as used
    from sandbox_session where job_id = ${jobId}`;
  return Number(row?.used ?? 0);
}

export class SandboxSessions {
  constructor(
    private readonly sql: Sql,
    private readonly options: { leaseSeconds: number },
  ) {
    if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds <= 0)
      throw new Error('a sandbox lease needs a positive whole number of seconds');
  }

  async get(id: string): Promise<SessionRow | null> {
    const [row] = await this.sql`select * from sandbox_session where id = ${id}`;
    return row ? toRow(row) : null;
  }

  async usedSeconds(jobId: string): Promise<number> {
    return usedSeconds(this.sql, jobId);
  }

  /**
   * Refuse, record, then create. `specFor` receives the session id, which the
   * sandbox must carry as its `melete.session` label.
   */
  async open(
    input: OpenSession,
    provider: SandboxProvider,
    specFor: (sessionId: string) => SandboxSpec,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    const id = recordId('sbx');
    const spec = specFor(id);
    const persistence = input.persistence ?? 'ephemeral';
    checkSpec(provider.capabilities, spec, persistence);
    if (spec.labels[LABEL_SESSION] !== id)
      throw new Error('the sandbox labels must name the session that owns it');
    const cap = input.maxSandboxSeconds ?? null;
    if (cap !== null && (!Number.isFinite(cap) || cap < 0))
      throw new Error('a sandbox-time cap is a non-negative number of seconds');
    try {
      await this.sql.begin(async (tx) => {
        if (cap !== null) {
          if (!input.jobId) throw new Error('a sandbox-time cap is a job budget and needs a job');
          await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-job:${input.jobId}`}))`;
          const used = await usedSeconds(tx, input.jobId);
          if (used >= cap)
            throw new SandboxRefusal(
              'sandbox_time_exhausted',
              `this job has used ${Math.floor(used)}s of its ${cap}s of sandbox time`,
            );
        }
        if (input.agentId) {
          await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-workspace:${input.spaceId}:${input.agentId}`}))`;
          const [existing] = await tx`select id from sandbox_session
            where space_id = ${input.spaceId} and agent_id = ${input.agentId}
              and status in ('opening', 'ready', 'paused')
            limit 1`;
          if (existing)
            throw new SandboxRefusal(
              'workspace_exists',
              'this agent already has a live workspace in this space',
            );
        }
        await tx`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id,
            agent_id, adapter, provider_sandbox_id, image_ref, region, egress_policy, persistence,
            status, lease_expires_at)
          values (${id}, ${input.connectionId}, ${input.spaceId}, ${input.jobId}, ${input.attemptId},
            ${input.agentId}, ${provider.capabilities.adapter}, ${`${PENDING_SANDBOX}${id}`},
            ${spec.image}, ${spec.region}, ${JSON.stringify(spec.egress)}::jsonb,
            ${persistence}, 'opening',
            now() + make_interval(secs => ${this.options.leaseSeconds}))`;
      });
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === 'sandbox_session_attempt_idx')
        throw new SandboxRefusal('session_exists', 'this attempt already has a live sandbox');
      throw error;
    }
    let handle: SandboxHandle;
    try {
      handle = await provider.create(spec, signal);
    } catch (error) {
      // The provider may have created a sandbox before the answer was lost. It
      // carries this session's label, and a closed row is not live, so the
      // reconciler removes it.
      await this.sql`update sandbox_session set status = 'closed', closed_at = now(),
          seconds_charged = 0, last_error = ${message(error)}
        where id = ${id} and status = 'opening'`;
      throw error;
    }
    try {
      const [row] = await this.sql`update sandbox_session
        set provider_sandbox_id = ${handle.providerSandboxId}, image_digest = ${handle.imageDigest},
          region = ${handle.region}, status = 'ready'
        where id = ${id} and status = 'opening'
        returning *`;
      if (!row) throw new Error('the session ended while its sandbox was being created');
      return toRow(row);
    } catch (error) {
      await provider.destroy(handle, AbortSignal.timeout(30_000)).catch(() => {});
      await this.sql`update sandbox_session set status = 'closed', closed_at = now(),
          seconds_charged = extract(epoch from now() - opened_at), last_error = ${message(error)}
        where id = ${id} and status = 'opening'`;
      if (uniqueViolation(error) === 'sandbox_workspace_idx')
        throw new SandboxRefusal(
          'workspace_exists',
          'this agent already has a live workspace in this space',
        );
      throw error;
    }
  }

  /** Extend the lease and meter the time so far. Time used never refuses a renewal. */
  async renew(id: string): Promise<SessionRow | null> {
    const [row] = await this.sql`update sandbox_session
      set lease_expires_at = now() + make_interval(secs => ${this.options.leaseSeconds}),
        seconds_charged = extract(epoch from now() - opened_at)
      where id = ${id} and status in ('opening', 'ready')
      returning *`;
    return row ? toRow(row) : null;
  }

  async close(id: string, provider: SandboxProvider, signal: AbortSignal): Promise<SessionRow> {
    const [claimed] = await this.sql`update sandbox_session set status = 'closing'
      where id = ${id} and status in ('opening', 'ready', 'paused', 'closing')
      returning *`;
    if (!claimed) {
      const current = await this.get(id);
      if (!current) throw new Error('no such sandbox session');
      return current;
    }
    return this.finish(toRow(claimed), provider, signal);
  }

  private async finish(
    row: SessionRow,
    provider: SandboxProvider | undefined,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    if (!row.providerSandboxId.startsWith(PENDING_SANDBOX)) {
      if (!provider) {
        await this
          .sql`update sandbox_session set last_error = ${`no ${row.adapter} adapter is configured`}
          where id = ${row.id}`;
        return { ...row, lastError: `no ${row.adapter} adapter is configured` };
      }
      try {
        await provider.destroy(sessionHandle(row), signal);
      } catch (error) {
        await this
          .sql`update sandbox_session set last_error = ${message(error)} where id = ${row.id}`;
        throw error;
      }
    }
    const [closed] = await this.sql`update sandbox_session set status = 'closed', closed_at = now(),
        seconds_charged = extract(epoch from now() - opened_at)
      where id = ${row.id} and status = 'closing'
      returning *`;
    return closed ? toRow(closed) : row;
  }

  /** The provider no longer has the sandbox. Time is charged as last metered. */
  markLost(id: string, reason: string): Promise<boolean> {
    return markSessionLost(this.sql, id, reason);
  }

  /** Destroy the sandboxes of sessions whose lease has run out. */
  async sweep(
    providerFor: (adapter: string) => SandboxProvider | undefined,
    signal: AbortSignal,
  ): Promise<string[]> {
    const expired = await this.sql`select id, status from sandbox_session
      where status in ('opening', 'ready', 'closing') and lease_expires_at < now()
      order by lease_expires_at limit 100`;
    const swept: string[] = [];
    for (const candidate of expired) {
      const [claimed] = await this.sql`update sandbox_session set status = 'closing'
        where id = ${candidate.id as string} and status = ${candidate.status as string}
          and lease_expires_at < now()
        returning *`;
      if (!claimed) continue;
      const row = toRow(claimed);
      try {
        const finished = await this.finish(row, providerFor(row.adapter), signal);
        if (finished.status === 'closed') swept.push(row.id);
      } catch {
        // Recorded on the row; the next sweep tries again.
      }
    }
    return swept;
  }

  /**
   * Record that an action is being dispatched into a session. `again` means
   * it was dispatched before: the caller must reattach, never run.
   */
  async beginCommand(
    sessionId: string,
    actionId: string,
    marker: string,
  ): Promise<'first' | 'again'> {
    const inserted = await this.sql`insert into sandbox_command (action_id, session_id, marker)
      values (${actionId}, ${sessionId}, ${marker})
      on conflict (action_id) do nothing
      returning action_id`;
    if (inserted.length) return 'first';
    const [existing] = await this.sql`select session_id, marker from sandbox_command
      where action_id = ${actionId}`;
    if (existing?.session_id !== sessionId || existing?.marker !== marker)
      throw new Error('this action was dispatched into a different sandbox');
    return 'again';
  }

  async settleCommand(
    actionId: string,
    result: { outcome: string; exitCode: number | null; reattached: boolean },
  ): Promise<void> {
    await this.sql`update sandbox_command set outcome = ${result.outcome},
        exit_code = ${result.exitCode}, reattached = ${result.reattached}
      where action_id = ${actionId}`;
  }
}
