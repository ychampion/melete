/**
 * The lease on a remote sandbox, and the persistent workspace an agent keeps.
 *
 * A session is written before its sandbox is created, so the database decides
 * whether this attempt may have a sandbox at all, and a crash between the two
 * leaves a row the sweeper and the reconciler can finish. The sandbox is
 * labelled with the session id, so a sandbox whose row never became `ready`
 * is recognisable as this installation's orphan.
 *
 * A workspace belongs to one agent in one space and outlives the attempt that
 * used it. At the end of an attempt it is suspended — paused, or snapshotted
 * and stopped — and the next attempt for that agent resumes it on a new row.
 * One attempt holds a workspace at a time: a second attempt for the same agent
 * is refused with `workspace_busy`, never handed the live sandbox and never
 * left waiting. Waiting would hold a broker request open for as long as the
 * first attempt runs, which can be hours, and a refusal leaves the retry to
 * the scheduler that already owns retries. A workspace nobody resumes within
 * the retention period is destroyed by the sweep, snapshot included.
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
import {
  type EgressPolicy,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from './types.ts';

export const PENDING_SANDBOX = 'pending:';
/** A dispatch the provider refused before anything ran. */
export const NOT_STARTED = 'not_started';

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
  /**
   * Every session is opened for a job. The column empties only when that job
   * is removed, and a session whose job is gone is bounded by the sweep rather
   * than by any renewal.
   */
  jobId: string;
  attemptId: string | null;
  agentId: string | null;
  persistence?: SessionPersistence;
  /** The job's sandbox-time budget in seconds. Absent or null means no cap. */
  maxSandboxSeconds?: number | null;
  /**
   * How many sandboxes may be running when this one opens: this connection's
   * own allowance, and the whole installation's ceiling. Absent means neither
   * is enforced.
   */
  concurrency?: { perConnection: number; installation: number };
};

export type WorkspacePersistence = Exclude<SessionPersistence, 'ephemeral'>;

export type OpenWorkspace = Omit<OpenSession, 'agentId' | 'persistence'> & {
  agentId: string;
  persistence: WorkspacePersistence;
};

export type WorkspaceSession = SessionRow & { resumed: boolean };

export type SessionOptions = {
  leaseSeconds: number;
  /** How long a suspended workspace is kept without being resumed. */
  workspaceRetentionSeconds: number;
  /** Where session ids come from; replaced only by tests that replay recorded traffic. */
  ids?: () => string;
};

/**
 * The provider a row's sandbox belongs to. A connection holds the key, so the
 * connection decides: two spaces may use one provider with two accounts.
 */
type ProviderFor = (adapter: string, connectionId: string) => SandboxProvider | undefined;
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

const handleOf = (providerSandboxId: string): SandboxHandle => ({
  providerSandboxId,
  imageDigest: null,
  region: null,
});

const uniqueViolation = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && error.code === '23505'
    ? String((error as { constraint_name?: string }).constraint_name ?? '')
    : null;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every sandbox a session row recorded at its provider: its own, unless it
 * never got one, and the paused sandbox a pause workspace resumes from.
 */
function recordedSandboxes(row: Row): string[] {
  const own = row.provider_sandbox_id as string;
  const ids = own.startsWith(PENDING_SANDBOX) ? [] : [own];
  const paused = row.resume_ref as string | null;
  if (row.persistence === 'pause' && paused && paused !== own) ids.push(paused);
  return ids;
}

const egressKey = (policy: EgressPolicy) =>
  JSON.stringify([
    policy.kind,
    policy.kind === 'cidr_allowlist'
      ? [...policy.cidrs]
      : policy.kind === 'domain_allowlist'
        ? [...policy.domains]
        : [],
  ]);

const BUSY =
  'another attempt is using this agent’s workspace; it is not shared, and this attempt is refused rather than kept waiting';

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
  private readonly ids: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly options: SessionOptions,
  ) {
    if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds <= 0)
      throw new Error('a sandbox lease needs a positive whole number of seconds');
    if (
      !Number.isSafeInteger(options.workspaceRetentionSeconds) ||
      options.workspaceRetentionSeconds <= 0
    )
      throw new Error('workspace retention needs a positive whole number of seconds');
    this.ids = options.ids ?? (() => recordId('sbx'));
  }

  async get(id: string): Promise<SessionRow | null> {
    const [row] = await this.sql`select * from sandbox_session where id = ${id}`;
    return row ? toRow(row) : null;
  }

  async usedSeconds(jobId: string): Promise<number> {
    return usedSeconds(this.sql, jobId);
  }

  /** Validate a request and mint the session id its sandbox will be labelled with. */
  private prepare(
    input: OpenSession,
    provider: SandboxProvider,
    specFor: (sessionId: string) => SandboxSpec,
    persistence: SessionPersistence,
  ) {
    const id = this.ids();
    const spec = specFor(id);
    checkSpec(provider.capabilities, spec, persistence);
    if (spec.labels[LABEL_SESSION] !== id)
      throw new Error('the sandbox labels must name the session that owns it');
    const cap = input.maxSandboxSeconds ?? null;
    if (cap !== null && (!Number.isFinite(cap) || cap < 0))
      throw new Error('a sandbox-time cap is a non-negative number of seconds');
    return { id, spec, cap };
  }

  /**
   * The connection must be active, and its row is held for share until the
   * session is written. This is the first lock an opening takes: a revocation
   * or a key switch holds the row for update while it tears the connection's
   * sandboxes down, so an opening waits for it here and then sees the result,
   * instead of holding advisory and session locks the teardown needs.
   */
  private async checkConnection(tx: TransactionSql, input: OpenSession) {
    const [held] = await tx`select status from connection
      where id = ${input.connectionId} for share`;
    if (held?.status !== 'active')
      throw new SandboxRefusal(
        'connection_inactive',
        'this sandbox connection is not active, so no sandbox is opened through it',
      );
  }

  private async checkCap(tx: TransactionSql, input: OpenSession, cap: number | null) {
    if (cap === null) return;
    await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-job:${input.jobId}`}))`;
    const used = await usedSeconds(tx, input.jobId);
    if (used >= cap)
      throw new SandboxRefusal(
        'sandbox_time_exhausted',
        `this job has used ${Math.floor(used)}s of its ${cap}s of sandbox time`,
      );
  }

  /**
   * Both allowances, counted inside the transaction that writes the row and
   * behind one lock, so concurrent opens queue rather than all reading the same
   * count and passing. The lock is the installation's, which is what the
   * ceiling belongs to; a connection's own allowance is counted under it too.
   */
  private async checkConcurrency(tx: TransactionSql, input: OpenSession) {
    const limit = input.concurrency;
    if (!limit || (!Number.isFinite(limit.perConnection) && !Number.isFinite(limit.installation)))
      return;
    await tx`select pg_advisory_xact_lock(hashtext('sandbox-open'))`;
    const [counted] = await tx`select count(*)::int as live,
        count(*) filter (where connection_id = ${input.connectionId})::int as own
      from sandbox_session where status in ('opening', 'ready')`;
    const live = Number(counted?.live ?? 0);
    const mine = Number(counted?.own ?? 0);
    // The connection's own first: it names the account that is full.
    if (mine >= limit.perConnection)
      throw new SandboxRefusal(
        'concurrency_exhausted',
        `this connection already has ${mine} running, which is its limit`,
      );
    if (live >= limit.installation)
      throw new SandboxRefusal(
        'concurrency_exhausted',
        `this installation already has ${live} running, which is its limit`,
      );
  }

  private insertOpening(
    tx: TransactionSql,
    id: string,
    input: OpenSession,
    provider: SandboxProvider,
    spec: SandboxSpec,
    persistence: SessionPersistence,
    resumeRef: string | null,
  ) {
    return tx`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id,
        agent_id, adapter, provider_sandbox_id, image_ref, region, egress_policy, persistence,
        resume_ref, status, lease_expires_at)
      values (${id}, ${input.connectionId}, ${input.spaceId}, ${input.jobId}, ${input.attemptId},
        ${input.agentId}, ${provider.capabilities.adapter}, ${`${PENDING_SANDBOX}${id}`},
        ${spec.image}, ${spec.region}, ${JSON.stringify(spec.egress)}::jsonb,
        ${persistence}, ${resumeRef}, 'opening',
        now() + make_interval(secs => ${this.options.leaseSeconds}))`;
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
    const persistence = input.persistence ?? 'ephemeral';
    const { id, spec, cap } = this.prepare(input, provider, specFor, persistence);
    try {
      await this.sql.begin(async (tx) => {
        await this.checkConnection(tx, input);
        await this.checkCap(tx, input, cap);
        await this.checkConcurrency(tx, input);
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
        await this.insertOpening(tx, id, input, provider, spec, persistence, null);
      });
    } catch (error) {
      throw this.refusalFor(error);
    }
    return this.create(id, provider, spec, signal);
  }

  private refusalFor(error: unknown): unknown {
    const constraint = uniqueViolation(error);
    if (constraint === 'sandbox_session_attempt_idx')
      return new SandboxRefusal('session_exists', 'this attempt already has a live sandbox');
    if (constraint === 'sandbox_workspace_idx') return new SandboxRefusal('workspace_busy', BUSY);
    return error;
  }

  private async create(
    id: string,
    provider: SandboxProvider,
    spec: SandboxSpec,
    signal: AbortSignal,
  ): Promise<SessionRow> {
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

  /**
   * Resume this agent's suspended workspace, or create one when it has none.
   * The suspended row is closed and its `resume_ref` carried onto this
   * attempt's row in one transaction, so exactly one row is ever live.
   */
  async openWorkspace(
    input: OpenWorkspace,
    provider: SandboxProvider,
    specFor: (sessionId: string) => SandboxSpec,
    signal: AbortSignal,
  ): Promise<WorkspaceSession> {
    const { id, spec, cap } = this.prepare(input, provider, specFor, input.persistence);
    let suspended: SessionRow | null = null;
    try {
      await this.sql.begin(async (tx) => {
        await this.checkConnection(tx, input);
        await this.checkCap(tx, input, cap);
        // Before the workspace lock, and in that order in both paths: two locks
        // taken in opposite orders by two openings would deadlock.
        await this.checkConcurrency(tx, input);
        await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-workspace:${input.spaceId}:${input.agentId}`}))`;
        const live = (
          await tx`select * from sandbox_session
            where space_id = ${input.spaceId} and agent_id = ${input.agentId}
              and status in ('opening', 'ready', 'paused')`
        ).map(toRow);
        if (live.some((row) => row.status !== 'paused'))
          throw new SandboxRefusal('workspace_busy', BUSY);
        const paused = live[0] ?? null;
        if (paused) {
          if (
            paused.adapter !== provider.capabilities.adapter ||
            paused.persistence !== input.persistence ||
            !paused.resumeRef
          )
            throw new SandboxRefusal(
              'workspace_incompatible',
              `this agent's workspace is a ${paused.persistence} workspace on ${paused.adapter}; destroy it to open another kind`,
            );
          if (egressKey(paused.egressPolicy) !== egressKey(spec.egress))
            throw new SandboxRefusal(
              'workspace_incompatible',
              "this agent's workspace was created under a different egress policy; destroy it to change the policy",
            );
          // Closed first: the attempt that suspended it may be the one resuming it.
          await tx`update sandbox_session set status = 'closed', closed_at = now()
            where id = ${paused.id} and status = 'paused'`;
          suspended = paused;
        }
        await this.insertOpening(
          tx,
          id,
          input,
          provider,
          spec,
          input.persistence,
          paused?.resumeRef ?? null,
        );
      });
    } catch (error) {
      throw this.refusalFor(error);
    }
    const from = suspended as SessionRow | null;
    if (!from) return { ...(await this.create(id, provider, spec, signal)), resumed: false };
    return { ...(await this.resume(id, from, provider, spec, signal)), resumed: true };
  }

  private async resume(
    id: string,
    from: SessionRow,
    provider: SandboxProvider,
    spec: SandboxSpec,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    const resumeRef = from.resumeRef as string;
    let handle: SandboxHandle;
    try {
      if (!provider.resume)
        throw new Error(`the ${provider.capabilities.adapter} adapter cannot resume a workspace`);
      handle = await provider.resume(resumeRef, spec, signal);
    } catch (error) {
      if (error instanceof SandboxGone) {
        await this.sql`update sandbox_session set status = 'lost', closed_at = now(),
            seconds_charged = 0,
            last_error = ${`the suspended workspace no longer exists: ${message(error)}`}
          where id = ${id} and status = 'opening'`;
        throw new SandboxRefusal(
          'workspace_lost',
          `this agent's suspended workspace no longer exists at ${provider.capabilities.adapter}; opening again creates a new one`,
        );
      }
      await this.keepSuspended(
        id,
        { ...from, suspendedAt: from.leaseExpiresAt },
        provider,
        `the workspace could not be resumed: ${message(error)}`,
      );
      throw error;
    }
    let row: Row | undefined;
    try {
      [row] = await this.sql`update sandbox_session
        set provider_sandbox_id = ${handle.providerSandboxId}, image_digest = ${handle.imageDigest},
          region = ${handle.region}, status = 'ready', last_error = null
        where id = ${id} and status = 'opening'
        returning *`;
    } catch (error) {
      await this.abandon(handle, from.persistence, provider);
      await this.keepSuspended(
        id,
        { ...from, suspendedAt: from.leaseExpiresAt },
        provider,
        `the resumed workspace could not be recorded: ${message(error)}`,
      );
      throw error;
    }
    if (!row) {
      const current = await this.get(id);
      if (current?.status === 'paused')
        // The sweep gave up on this resume and put the workspace back: so is what came back.
        await this.abandon(handle, from.persistence, provider);
      // Otherwise the row is being destroyed, and what was resumed goes with it.
      else await provider.destroy(handle, AbortSignal.timeout(30_000)).catch(() => {});
      throw new Error('the session ended while its workspace was being resumed');
    }
    return toRow(row);
  }

  /** Put a resumed sandbox back the way a suspended workspace keeps it, as far as possible. */
  private async abandon(
    handle: SandboxHandle,
    persistence: SessionPersistence,
    provider: SandboxProvider,
  ) {
    const signal = AbortSignal.timeout(60_000);
    if (persistence === 'snapshot') await provider.destroy(handle, signal).catch(() => {});
    else await provider.pause?.(handle, signal).catch(() => {});
  }

  /**
   * A resume that did not settle leaves the workspace suspended on this row,
   * with its sandbox, reference and retention clock. A paused sandbox that did
   * come back is paused again, so it is not left running unrecorded.
   */
  private async keepSuspended(
    id: string,
    from: Pick<SessionRow, 'providerSandboxId' | 'resumeRef' | 'persistence'> & {
      suspendedAt: Date;
    },
    provider: SandboxProvider | undefined,
    reason: string,
  ) {
    await this.sql`update sandbox_session set status = 'paused',
        provider_sandbox_id = ${from.providerSandboxId}, resume_ref = ${from.resumeRef},
        lease_expires_at = ${from.suspendedAt}, seconds_charged = 0, last_error = ${reason}
      where id = ${id} and status = 'opening'`;
    if (from.persistence !== 'pause' || !provider) return;
    const signal = AbortSignal.timeout(60_000);
    const handle = handleOf(from.providerSandboxId);
    const state = await provider.inspect(handle, signal).catch(() => null);
    if (state === 'running') await provider.pause?.(handle, signal).catch(() => {});
  }

  /**
   * Suspend a ready workspace: pause it, or snapshot it and stop the sandbox.
   * A suspension that fails leaves the row `ready`, the sandbox running and
   * the reason on the row, and throws `suspend_failed`.
   */
  async suspendWorkspace(
    id: string,
    provider: SandboxProvider,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    // The lease is renewed first, so the sweep does not take the row meanwhile.
    const [claimed] = await this.sql`update sandbox_session
      set lease_expires_at = now() + make_interval(secs => ${this.options.leaseSeconds})
      where id = ${id} and status = 'ready' and agent_id is not null
        and persistence in ('pause', 'snapshot')
      returning *`;
    if (!claimed)
      throw new SandboxRefusal('workspace_not_live', 'only a ready workspace can be suspended');
    const row = toRow(claimed);
    const handle = sessionHandle(row);
    const failed = async (error: unknown) => {
      const reason = `the workspace could not be suspended and is still running: ${message(error)}`;
      await this.sql`update sandbox_session set last_error = ${reason} where id = ${id}`;
      return new SandboxRefusal('suspend_failed', reason);
    };
    if (row.persistence === 'pause') {
      let resumeRef: string;
      try {
        if (!provider.pause) throw new Error(`the ${row.adapter} adapter cannot pause`);
        ({ resumeRef } = await provider.pause(handle, signal));
      } catch (error) {
        throw await failed(error);
      }
      return this.markSuspended(id, resumeRef, null);
    }
    let snapshotRef: string;
    try {
      if (!provider.snapshot) throw new Error(`the ${row.adapter} adapter cannot snapshot`);
      ({ snapshotRef } = await provider.snapshot(handle, signal));
    } catch (error) {
      throw await failed(error);
    }
    // Recorded before the sandbox stops, so nothing after this can lose the snapshot.
    await this.sql`update sandbox_session set resume_ref = ${snapshotRef} where id = ${id}`;
    let note: string | null = null;
    try {
      await provider.destroy(handle, signal);
    } catch (error) {
      note = `the sandbox could not be stopped after its snapshot and is left to reconciliation: ${message(error)}`;
    }
    const suspended = await this.markSuspended(id, snapshotRef, note);
    const superseded = row.resumeRef;
    if (!superseded || superseded === snapshotRef) return suspended;
    try {
      if (provider.deleteSnapshot) {
        await provider.deleteSnapshot(superseded, signal);
        await this.snapshotDeleted(superseded);
      }
      return suspended;
    } catch (error) {
      const reason = `the superseded snapshot could not be deleted and is left to expire: ${message(error)}`;
      const [noted] = await this.sql`update sandbox_session set last_error = ${reason}
        where id = ${id} returning *`;
      return noted ? toRow(noted) : suspended;
    }
  }

  private async markSuspended(id: string, resumeRef: string, note: string | null) {
    const [row] = await this.sql`update sandbox_session set status = 'paused',
        resume_ref = ${resumeRef}, seconds_charged = extract(epoch from now() - opened_at),
        lease_expires_at = now(), last_error = ${note}
      where id = ${id} and status = 'ready'
      returning *`;
    if (row) return toRow(row);
    // The row was taken while the provider suspended the sandbox; say so on it.
    await this.sql`update sandbox_session
      set last_error = ${`suspended as ${resumeRef} after the session had already moved on`}
      where id = ${id}`;
    throw new Error('the workspace session ended while it was being suspended');
  }

  /**
   * Extend the lease and meter the time so far. Time used never refuses a
   * renewal; a job that is gone does, since nothing is left to charge the time
   * to or to end the session when it finishes.
   */
  async renew(id: string): Promise<SessionRow | null> {
    const [row] = await this.sql`update sandbox_session
      set lease_expires_at = now() + make_interval(secs => ${this.options.leaseSeconds}),
        seconds_charged = extract(epoch from now() - opened_at)
      where id = ${id} and status in ('opening', 'ready') and job_id is not null
      returning *`;
    return row ? toRow(row) : null;
  }

  /** Take a row for destruction, remembering the status it was taken from. */
  private async claim(
    id: string,
    statuses: readonly SessionStatus[],
  ): Promise<{ row: SessionRow; from: SessionStatus } | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.get(id);
      if (!current || !statuses.includes(current.status)) return null;
      const [claimed] = await this.sql`update sandbox_session set status = 'closing'
        where id = ${id} and status = ${current.status}
        returning *`;
      if (claimed) return { row: toRow(claimed), from: current.status };
    }
    return null;
  }

  async close(id: string, provider: SandboxProvider, signal: AbortSignal): Promise<SessionRow> {
    const claimed = await this.claim(id, ['opening', 'ready', 'paused', 'closing']);
    if (!claimed) {
      const current = await this.get(id);
      if (!current) throw new Error('no such sandbox session');
      return current;
    }
    return this.finish(claimed.row, claimed.from, provider, signal);
  }

  /** Destroy a workspace for good: its sandbox, and its snapshot if it has one. */
  destroyWorkspace(
    id: string,
    provider: SandboxProvider,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    return this.close(id, provider, signal);
  }

  private async finish(
    row: SessionRow,
    from: SessionStatus,
    provider: SandboxProvider | undefined,
    signal: AbortSignal,
  ): Promise<SessionRow> {
    if (!provider) {
      // Nothing here can reach this sandbox now, so nothing here can close it.
      // The row goes back to what it was, with the reason, rather than being
      // left `closing` for the sweep to take back on every cycle.
      const reason = `no ${row.adapter} provider is available for this session's connection`;
      await this.sql`update sandbox_session set status = ${from}, last_error = ${reason}
        where id = ${row.id} and status = 'closing'`;
      throw new Error(reason);
    }
    try {
      // A snapshotted workspace's sandbox was stopped when it was suspended.
      const stopped = from === 'paused' && row.persistence === 'snapshot';
      if (!row.providerSandboxId.startsWith(PENDING_SANDBOX) && !stopped)
        await provider.destroy(sessionHandle(row), signal);
      if (row.resumeRef && row.persistence === 'pause' && row.resumeRef !== row.providerSandboxId)
        // A paused sandbox that a resume in flight had not yet claimed.
        await provider.destroy(handleOf(row.resumeRef), signal);
      if (row.resumeRef && row.persistence === 'snapshot') {
        if (!provider.deleteSnapshot)
          throw new Error(`the ${row.adapter} adapter cannot delete a snapshot`);
        await provider.deleteSnapshot(row.resumeRef, signal);
      }
    } catch (error) {
      await this
        .sql`update sandbox_session set last_error = ${message(error)} where id = ${row.id}`;
      throw error;
    }
    const [closed] = await this.sql`update sandbox_session set status = 'closed', closed_at = now(),
        seconds_charged = case when ${from} = 'paused' then seconds_charged
          else extract(epoch from now() - opened_at) end
      where id = ${row.id} and status = 'closing'
      returning *`;
    if (!closed) return row;
    // A snapshot workspace's snapshot was deleted above, so the row, closed
    // now, keeps no reference to it: nothing is left to ask a provider about.
    if (row.resumeRef && row.persistence === 'snapshot') {
      await this.snapshotDeleted(row.resumeRef);
      return (await this.get(row.id)) ?? toRow(closed);
    }
    return toRow(closed);
  }

  /**
   * The provider a row's sandbox belongs to, undefined when its connection has
   * none, or null when resolving it failed. A failure is recorded on the row
   * and leaves it as it was, so one misconfigured connection neither stops the
   * sweep nor gets a sandbox destroyed through the wrong provider.
   */
  private async providerOf(
    row: Pick<SessionRow, 'id' | 'adapter' | 'connectionId'>,
    providerFor: ProviderFor,
  ): Promise<SandboxProvider | undefined | null> {
    try {
      return providerFor(row.adapter, row.connectionId);
    } catch (error) {
      await this
        .sql`update sandbox_session set last_error = ${message(error)} where id = ${row.id}`;
      return null;
    }
  }

  /**
   * The provider to settle a row through, or null when there is none now.
   *
   * Only a connection that was revoked, or that now holds another adapter, can
   * never reach the sandbox again: the row is recorded lost, once, and a
   * sandbox still running is left to reconciliation. A connection that stands
   * but has no provider in this process, such as a connector that failed to
   * build at boot, is a passing state. The reason goes on the row and the row
   * is otherwise left exactly as it was, so a person's workspace is never
   * given up because of it, and reconciliation still counts it as live.
   */
  private async reachable(
    row: Pick<SessionRow, 'id' | 'adapter' | 'connectionId' | 'status'>,
    providerFor: ProviderFor,
  ): Promise<SandboxProvider | null> {
    const [held] = await this.sql`select status, configuration from connection
      where id = ${row.connectionId}`;
    const adapter = (held?.configuration as { sandbox?: { adapter?: unknown } } | null)?.sandbox
      ?.adapter;
    const gone =
      !held || held.status === 'revoked'
        ? 'its connection was revoked'
        : typeof adapter === 'string' && adapter !== row.adapter
          ? `its connection now holds the ${adapter} adapter`
          : null;
    if (gone) {
      await markSessionLost(
        this.sql,
        row.id,
        `${gone}, so nothing here can reach its ${row.adapter} sandbox again`,
        row.status,
      );
      return null;
    }
    const provider = await this.providerOf(row, providerFor);
    if (provider === undefined)
      await this.sql`update sandbox_session
        set last_error = ${`no ${row.adapter} provider is available for this session's connection right now, so the session is left as it is until one is`}
        where id = ${row.id}`;
    return provider ?? null;
  }

  /**
   * A snapshot the provider has deleted is no longer referred to by any
   * finished session. Recorded this way, the removal check stops asking about
   * it, which it could not do anyway once the connection's key is gone.
   */
  private async snapshotDeleted(ref: string): Promise<void> {
    await this.sql`update sandbox_session set resume_ref = null
      where resume_ref = ${ref} and persistence = 'snapshot' and status in ('closed', 'lost')`;
  }

  /** The provider no longer has the sandbox. Time is charged as last metered. */
  markLost(id: string, reason: string): Promise<boolean> {
    return markSessionLost(this.sql, id, reason);
  }

  /**
   * Destroy the sandboxes of sessions whose lease has run out, suspend
   * workspaces whose attempt stopped renewing them, and destroy workspaces
   * suspended for longer than the retention period. Returns the sessions it
   * closed.
   */
  async sweep(providerFor: ProviderFor, signal: AbortSignal): Promise<string[]> {
    const swept: string[] = [];
    // A session whose job was removed is taken now rather than when its lease
    // runs out: no attempt is left to use it, and its time counts against no
    // job's cap.
    const expired = (
      await this.sql`select * from sandbox_session
        where status in ('opening', 'ready', 'closing')
          and (lease_expires_at < now() or job_id is null)
        order by lease_expires_at limit 100`
    ).map(toRow);
    for (const candidate of expired) {
      const provider = await this.reachable(candidate, providerFor);
      if (!provider) continue;
      const workspace = candidate.agentId !== null && candidate.persistence !== 'ephemeral';
      if (workspace && candidate.status === 'ready') {
        // A workspace outlives its attempt: it is suspended, not destroyed.
        await this.suspendWorkspace(candidate.id, provider, signal).catch(() => {
          // Recorded on the row, which keeps running; the next sweep tries again.
        });
        continue;
      }
      if (workspace && candidate.status === 'opening' && candidate.resumeRef) {
        // A resume that never finished: the workspace goes back to suspended.
        await this.keepSuspended(
          candidate.id,
          {
            providerSandboxId:
              candidate.persistence === 'pause'
                ? candidate.resumeRef
                : `${PENDING_SANDBOX}${candidate.id}`,
            resumeRef: candidate.resumeRef,
            persistence: candidate.persistence,
            suspendedAt: candidate.openedAt,
          },
          provider,
          'the resume did not finish within its lease',
        );
        continue;
      }
      const [claimed] = await this.sql`update sandbox_session set status = 'closing'
        where id = ${candidate.id as string} and status = ${candidate.status as string}
          and (lease_expires_at < now() or job_id is null)
        returning *`;
      if (!claimed) continue;
      const row = toRow(claimed);
      try {
        const finished = await this.finish(
          row,
          candidate.status as SessionStatus,
          provider,
          signal,
        );
        if (finished.status === 'closed') swept.push(row.id);
      } catch {
        // Recorded on the row; the next sweep tries again.
      }
    }
    const stale = await this.sql`select id, adapter, connection_id, status from sandbox_session
      where status = 'paused'
        and lease_expires_at < now() - make_interval(secs => ${this.options.workspaceRetentionSeconds})
      order by lease_expires_at limit 100`;
    for (const candidate of stale) {
      const provider = await this.reachable(
        {
          id: candidate.id as string,
          adapter: candidate.adapter as string,
          connectionId: candidate.connection_id as string,
          status: candidate.status as SessionStatus,
        },
        providerFor,
      );
      if (!provider) continue;
      const [claimed] = await this.sql`update sandbox_session set status = 'closing'
        where id = ${candidate.id as string} and status = 'paused'
          and lease_expires_at < now() - make_interval(secs => ${this.options.workspaceRetentionSeconds})
        returning *`;
      if (!claimed) continue;
      const row = toRow(claimed);
      try {
        const finished = await this.finish(row, 'paused', provider, signal);
        if (finished.status === 'closed') swept.push(row.id);
      } catch {
        // Recorded on the row, which is now `closing`; the next sweep retries it.
      }
    }
    return swept;
  }

  /**
   * Destroy everything a space holds at its providers — every live sandbox,
   * every suspended workspace and every snapshot any of its sessions recorded
   * — before the space itself is deleted, since deleting the space deletes
   * these rows and with them the only record of what to destroy. Throws after
   * trying everything if anything could not be destroyed, so the caller does
   * not delete the space over a sandbox that is still there.
   */
  destroyWorkspacesForSpace(
    spaceId: string,
    providerFor: ProviderFor,
    signal: AbortSignal,
  ): Promise<{ closed: string[]; snapshotsDeleted: string[] }> {
    return this.destroyAll({ spaceId }, providerFor, signal);
  }

  /**
   * The same for one connection, before its key is dropped: the key is what
   * reaches its account, so once a connection is revoked nothing here can
   * destroy what it left behind.
   */
  destroyWorkspacesForConnection(
    connectionId: string,
    providerFor: ProviderFor,
    signal: AbortSignal,
  ): Promise<{ closed: string[]; snapshotsDeleted: string[] }> {
    return this.destroyAll({ connectionId }, providerFor, signal);
  }

  /**
   * Whether a provider lent another key sees what this connection holds:
   * asked about one of its live sandboxes, or failing that one of its
   * snapshots. False when it sees neither, when there is nothing to ask
   * about, and when it cannot answer.
   */
  async visibleWith(
    connectionId: string,
    open: (adapter: string) => { provider: SandboxProvider; close(): Promise<void> },
    signal: AbortSignal,
  ): Promise<boolean> {
    const rows = await this.sql`select adapter, provider_sandbox_id, persistence, resume_ref
      from sandbox_session
      where connection_id = ${connectionId} and status in ('opening', 'ready', 'paused', 'closing')
      order by opened_at desc`;
    for (const row of rows) {
      const [sandboxId] = recordedSandboxes(row);
      const snapshot = row.persistence === 'snapshot' ? (row.resume_ref as string | null) : null;
      if (!sandboxId && !snapshot) continue;
      const opened = open(row.adapter as string);
      try {
        if (sandboxId)
          return (await opened.provider.inspect(handleOf(sandboxId), signal)) !== 'gone';
        return snapshot && opened.provider.snapshotHeld
          ? await opened.provider.snapshotHeld(snapshot, signal)
          : false;
      } catch {
        return false;
      } finally {
        await opened.close();
      }
    }
    return false;
  }

  /**
   * Record, as lost and with the reason, every session of a connection that
   * still holds something. Used when a connection is revoked with its
   * sandboxes not all destroyed, so what is left is stated on its rows and
   * reported by `listWorkspacesForSpace`, never left to look live.
   */
  async recordLeftBehind(connectionId: string, reason: string): Promise<string[]> {
    const rows = await this.sql`update sandbox_session set status = 'lost', closed_at = now(),
        seconds_charged = coalesce(seconds_charged, extract(epoch from now() - opened_at)),
        last_error = ${reason}
      where connection_id = ${connectionId} and status in ('opening', 'ready', 'paused', 'closing')
      returning id`;
    return rows.map((row) => row.id as string);
  }

  private async destroyAll(
    scope: { spaceId: string } | { connectionId: string },
    providerFor: ProviderFor,
    signal: AbortSignal,
  ): Promise<{ closed: string[]; snapshotsDeleted: string[] }> {
    const within =
      'spaceId' in scope
        ? this.sql`space_id = ${scope.spaceId}`
        : this.sql`connection_id = ${scope.connectionId}`;
    const failures: string[] = [];
    const closed: string[] = [];
    const snapshotsDeleted: string[] = [];
    const live = await this.sql`select id, adapter, connection_id from sandbox_session
      where ${within} and status in ('opening', 'ready', 'paused', 'closing')`;
    for (const candidate of live) {
      // Resolved before the row is taken, so a provider that cannot be had
      // leaves the row as it was rather than `closing`.
      let provider: SandboxProvider | undefined;
      try {
        provider = providerFor(candidate.adapter as string, candidate.connection_id as string);
      } catch (error) {
        failures.push(`${candidate.id as string}: ${message(error)}`);
        continue;
      }
      const claimed = await this.claim(candidate.id as string, [
        'opening',
        'ready',
        'paused',
        'closing',
      ]);
      if (!claimed) continue;
      try {
        const finished = await this.finish(claimed.row, claimed.from, provider, signal);
        if (finished.status !== 'closed') {
          failures.push(`${finished.id}: ${finished.lastError ?? 'not closed'}`);
          continue;
        }
        closed.push(finished.id);
        // Closing a snapshot workspace deleted its snapshot.
        if (claimed.row.persistence === 'snapshot' && claimed.row.resumeRef)
          snapshotsDeleted.push(claimed.row.resumeRef);
      } catch (error) {
        failures.push(`${claimed.row.id}: ${message(error)}`);
      }
    }
    // A lost row can still have a sandbox at its provider: one whose
    // connection was revoked, for example. Destroying is idempotent, so each
    // is asked for once more.
    const lost = await this.sql`select id, adapter, connection_id, provider_sandbox_id,
        persistence, resume_ref
      from sandbox_session where ${within} and status = 'lost'`;
    for (const row of lost) {
      try {
        const provider = providerFor(row.adapter as string, row.connection_id as string);
        if (!provider) throw new Error(`no ${row.adapter as string} provider is available`);
        for (const sandboxId of recordedSandboxes(row))
          await provider.destroy(handleOf(sandboxId), signal);
      } catch (error) {
        failures.push(`${row.id as string}: ${message(error)}`);
      }
    }
    // A snapshot can outlive its row's lease: a superseded one whose deletion
    // failed, or one left on a row that was lost.
    const snapshots = await this.sql`select distinct adapter, connection_id, resume_ref
      from sandbox_session
      where ${within} and persistence = 'snapshot' and resume_ref is not null`;
    for (const snapshot of snapshots) {
      const ref = snapshot.resume_ref as string;
      try {
        const provider = providerFor(snapshot.adapter as string, snapshot.connection_id as string);
        if (!provider?.deleteSnapshot)
          throw new Error(`no ${snapshot.adapter as string} adapter can delete snapshots`);
        await provider.deleteSnapshot(ref, signal);
        await this.snapshotDeleted(ref);
        snapshotsDeleted.push(ref);
      } catch (error) {
        failures.push(`snapshot ${ref}: ${message(error)}`);
      }
    }
    if (failures.length)
      throw new Error(`the sandboxes were not all destroyed: ${failures.join('; ')}`);
    return { closed, snapshotsDeleted };
  }

  /**
   * What the providers still hold for a space, asked of them rather than read
   * from these rows: the sandbox of every session not closed, and every
   * snapshot any of the space's sessions recorded. A removal finishes
   * on this answer, never on what `destroyWorkspacesForSpace` reports it did.
   * Anything no provider answers for is counted as still held.
   */
  async listWorkspacesForSpace(
    spaceId: string,
    providerFor: ProviderFor,
    signal: AbortSignal = AbortSignal.timeout(120_000),
  ): Promise<{ sessions: string[]; snapshots: string[] }> {
    const rows = await this.sql`select id, adapter, connection_id, provider_sandbox_id,
        persistence, resume_ref, status
      from sandbox_session where space_id = ${spaceId} order by id`;
    const sessions = new Set<string>();
    const snapshots = new Set<string>();
    // A paused sandbox moves from one row to the next, so each is asked about once.
    const asked = new Map<string, boolean>();
    for (const row of rows) {
      let provider: SandboxProvider | undefined;
      try {
        provider = providerFor(row.adapter as string, row.connection_id as string);
      } catch {
        provider = undefined;
      }
      // A row is closed only once its sandbox was destroyed, so it is not
      // asked about again: after a revocation it could not be, and would
      // read as held forever. A lost row may still have one, so it is asked.
      for (const sandboxId of row.status === 'closed' ? [] : recordedSandboxes(row)) {
        const key = `${row.connection_id as string}:${sandboxId}`;
        let held = asked.get(key);
        if (held === undefined) {
          held = provider
            ? (await provider.inspect(handleOf(sandboxId), signal).catch(() => null)) !== 'gone'
            : true;
          asked.set(key, held);
        }
        if (held) sessions.add(row.id as string);
      }
      const ref = row.resume_ref as string | null;
      if (row.persistence === 'snapshot' && ref) {
        const held = provider?.snapshotHeld
          ? await provider.snapshotHeld(ref, signal).catch(() => true)
          : true;
        if (held) snapshots.add(ref);
      }
    }
    return { sessions: [...sessions], snapshots: [...snapshots] };
  }

  /**
   * Record that an action is being dispatched into a session. `again` means
   * it was dispatched before: the caller must reattach, never run. The one
   * exception is a dispatch settled as `not_started`, which the provider
   * refused before anything ran; that action may be sent as a first run again.
   */
  async beginCommand(
    sessionId: string,
    actionId: string,
    marker: string,
  ): Promise<'first' | 'again'> {
    const inserted = await this.sql`insert into sandbox_command (action_id, session_id, marker)
      values (${actionId}, ${sessionId}, ${marker})
      on conflict (action_id) do update set session_id = excluded.session_id,
        marker = excluded.marker, started_at = now(), outcome = null, exit_code = null,
        reattached = false
      where sandbox_command.outcome = ${NOT_STARTED}
      returning action_id`;
    if (inserted.length) return 'first';
    const [existing] = await this.sql`select session_id, marker from sandbox_command
      where action_id = ${actionId}`;
    if (existing?.session_id !== sessionId || existing?.marker !== marker)
      throw new Error('this action was dispatched into a different sandbox');
    return 'again';
  }

  /** Settle a dispatch; a `failed` result with `retryable: true` is settled as `not_started`. */
  async settleCommand(
    actionId: string,
    result: { outcome: string; exitCode: number | null; reattached: boolean },
  ): Promise<void> {
    await this.sql`update sandbox_command set outcome = ${result.outcome},
        exit_code = ${result.exitCode}, reattached = ${result.reattached}
      where action_id = ${actionId}`;
  }
}
