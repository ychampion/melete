/**
 * One display per chat on the agent's computer.
 *
 * A docker computer is one container with one `/work` and one browser
 * profile, and several screens: each chat, and each background run, gets a
 * display of its own there, with its own browser on it. What one chat opens is
 * on its display only, so another chat never sees its page, and a background
 * run holding the computer leaves every chat free to use it at once. Files and
 * the person's sign-ins stay the computer's: every display's browser starts
 * from the computer's profile.
 *
 * A display belongs to a chat or a run (its owner job: a run step's run, a
 * command's chat, or the job itself), so every turn comes back to the same
 * page. It is made on first use, with the lowest free number below the
 * operator's cap, and ended when its owner ends, when it has been unused for
 * `DISPLAY_IDLE_MS`, when its chat is stopped, or with its computer. Control
 * (taking over, the live view, a hand-off) is per display: display 0 keeps
 * the computer's own id as its control key, as before displays, and display n
 * uses `<computer>#n`.
 *
 * A computer's session row names one attempt. Another chat's attempt that
 * arrives while that one runs joins the computer instead of waiting: it gets a
 * display row naming it, and when the attempt on the session row ends, the
 * row passes to a joined attempt still running, so the computer is never
 * suspended under a chat that is using it.
 */
import type { Sql, TransactionSql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { SandboxRefusal } from './manifest.ts';

/** How many displays one computer runs at once unless the operator says otherwise. */
export const DEFAULT_MAX_DISPLAYS = 6;
/** The most displays the container's numbering allows. */
export const DISPLAY_LIMIT = 64;
/** A display nobody has used for this long is ended, and its number freed. */
export const DISPLAY_IDLE_MS = 30 * 60_000;

type Query = Sql | TransactionSql;

/** The control key of one display: the computer's id for display 0, `<id>#n` for the rest. */
export const displayKey = (sandbox: string, display: number): string =>
  display === 0 ? sandbox : `${sandbox}#${display}`;

export type DisplayRow = {
  id: string;
  spaceId: string;
  connectionId: string;
  adapter: string;
  providerSandboxId: string;
  display: number;
  ownerJobId: string;
  jobId: string | null;
  attemptId: string | null;
};

const toDisplay = (row: Record<string, unknown>): DisplayRow => ({
  id: String(row.id),
  spaceId: String(row.space_id),
  connectionId: String(row.connection_id),
  adapter: String(row.adapter),
  providerSandboxId: String(row.provider_sandbox_id),
  display: Number(row.display),
  ownerJobId: String(row.owner_job_id),
  jobId: (row.job_id as string | null) ?? null,
  attemptId: (row.attempt_id as string | null) ?? null,
});

/** What the model and the person are told when every display is taken. */
export const computerFull = (max: number) =>
  `the agent's computer already has ${max} ${max === 1 ? 'conversation' : 'conversations'} on it, which is the most it runs at once. Nothing ran. Tell the person, and try again once one of them has finished, or carry on without the computer`;

/** The chat or run a job's display belongs to: a run step's run, a command's chat, or the job. */
export async function ownerJobOf(sql: Query, jobId: string): Promise<string> {
  const [row] = await sql`select coalesce(
      (select parent_run_id from run_state where job_id = j.id), j.experience_parent_id, j.id) as owner
    from job j where j.id = ${jobId}`;
  return String(row?.owner ?? jobId);
}

/**
 * An attempt still running: not ended, with a lease that has not run out.
 * `column` is always one of the fixed column names below, never input.
 */
const liveAttempt = (sql: Query, column: 'd.attempt_id' | 's.attempt_id') =>
  sql`exists (select 1 from attempt la where la.id = ${sql.unsafe(column)}
    and la.ended_at is null and (la.lease_expires_at is null or la.lease_expires_at > now()))`;

/**
 * A condition on `sandbox_session` rows: a display of the computer is in use
 * by an attempt still running, other than the one on the row itself.
 */
export function displayInUse(sql: Query) {
  return sql`exists (select 1 from sandbox_display d
    where d.provider_sandbox_id = sandbox_session.provider_sandbox_id and d.ended_at is null
      and d.attempt_id is distinct from sandbox_session.attempt_id
      and ${liveAttempt(sql, 'd.attempt_id')})`;
}

/** A condition on a display `d`: a person holds it, under its control key (`displayKey`). */
const heldByPerson = (sql: Query) => sql`exists (select 1 from sandbox_control c
  where c.control = 'human' and c.provider_sandbox_id =
    case when d.display = 0 then d.provider_sandbox_id
      else d.provider_sandbox_id || '#' || d.display end)`;

export class SandboxDisplays {
  readonly maxDisplays: number;

  constructor(
    private readonly sql: Sql,
    options: { maxDisplays?: number; idleMs?: number } = {},
  ) {
    const max = options.maxDisplays ?? DEFAULT_MAX_DISPLAYS;
    if (!Number.isSafeInteger(max) || max < 1 || max > DISPLAY_LIMIT)
      throw new Error(`a computer runs 1 to ${DISPLAY_LIMIT} displays`);
    this.maxDisplays = max;
    this.idleMs = options.idleMs ?? DISPLAY_IDLE_MS;
  }

  private readonly idleMs: number;

  async get(id: string): Promise<DisplayRow | null> {
    const [row] = await this
      .sql`select * from sandbox_display where id = ${id} and ended_at is null`;
    return row ? toDisplay(row) : null;
  }

  /** The live displays of a chat or run, newest first. */
  async ofOwner(ownerJobId: string): Promise<DisplayRow[]> {
    const rows = await this.sql`select * from sandbox_display
      where owner_job_id = ${ownerJobId} and ended_at is null order by opened_at desc limit 16`;
    return rows.map(toDisplay);
  }

  /** The display an attempt joined a computer with, if it is still live. */
  async ofAttempt(attemptId: string, connectionId: string): Promise<DisplayRow | null> {
    const [row] = await this.sql`select * from sandbox_display
      where attempt_id = ${attemptId} and connection_id = ${connectionId} and ended_at is null
      order by used_at desc limit 1`;
    return row ? toDisplay(row) : null;
  }

  /** Whether any display of this computer has a live row; a computer without one predates displays. */
  async any(providerSandboxId: string): Promise<boolean> {
    const [row] = await this.sql`select 1 from sandbox_display
      where provider_sandbox_id = ${providerSandboxId} and ended_at is null limit 1`;
    return Boolean(row);
  }

  /**
   * The owner's display on this computer, made when it has none: the lowest
   * number below the cap that no live display holds and no person holds
   * either. Refused, in words the person can be told, when all are taken.
   * Inside the caller's transaction, under a lock on the computer's
   * numbering, so two chats never get one number.
   */
  async acquire(
    tx: TransactionSql,
    input: {
      spaceId: string;
      connectionId: string;
      adapter: string;
      providerSandboxId: string;
      ownerJobId: string;
      jobId: string;
      attemptId: string | null;
    },
  ): Promise<DisplayRow & { fresh: boolean }> {
    await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-display:${input.providerSandboxId}`}))`;
    const [mine] = await tx`update sandbox_display
      set job_id = ${input.jobId}, attempt_id = coalesce(${input.attemptId}, attempt_id), used_at = now()
      where provider_sandbox_id = ${input.providerSandboxId} and owner_job_id = ${input.ownerJobId}
        and ended_at is null
      returning *`;
    if (mine) return { ...toDisplay(mine), fresh: false };
    const taken = new Set(
      (
        await tx`select display from sandbox_display
          where provider_sandbox_id = ${input.providerSandboxId} and ended_at is null`
      ).map((row) => Number(row.display)),
    );
    const keys = Array.from({ length: this.maxDisplays }, (_, n) =>
      displayKey(input.providerSandboxId, n),
    );
    // A display a person still holds is theirs, even with no row for it.
    const held = new Set(
      (
        await tx`select provider_sandbox_id from sandbox_control
          where provider_sandbox_id in ${tx(keys)} and control = 'human'`
      ).map((row) => String(row.provider_sandbox_id)),
    );
    const free = keys.findIndex((key, n) => !taken.has(n) && !held.has(key));
    if (free < 0) throw new SandboxRefusal('computer_full', computerFull(this.maxDisplays));
    const [row] = await tx`insert into sandbox_display (id, space_id, connection_id, adapter,
        provider_sandbox_id, display, owner_job_id, job_id, attempt_id)
      values (${recordId('sbd')}, ${input.spaceId}, ${input.connectionId}, ${input.adapter},
        ${input.providerSandboxId}, ${free}, ${input.ownerJobId}, ${input.jobId}, ${input.attemptId})
      returning *`;
    // A new owner moves the display's epoch on, so nothing planned for the
    // one before it is taken for this one.
    const key = displayKey(input.providerSandboxId, free);
    await tx`insert into sandbox_control (provider_sandbox_id, control, epoch)
      values (${key}, 'agent', 0) on conflict (provider_sandbox_id) do nothing`;
    await tx`update sandbox_control set epoch = epoch + 1, changed_at = now()
      where provider_sandbox_id = ${key} and control = 'agent'`;
    return { ...toDisplay(row as Record<string, unknown>), fresh: true };
  }

  /** The attempt has ended: its displays stay with their chat, unused until the next turn. */
  async release(attemptId: string): Promise<void> {
    await this.sql`update sandbox_display set attempt_id = null, used_at = now()
      where attempt_id = ${attemptId} and ended_at is null`;
  }

  /** End every display of a computer that is gone. */
  static async endFor(q: Query, providerSandboxId: string, reason: string): Promise<void> {
    await q`update sandbox_display set ended_at = now(), end_reason = ${reason}
      where provider_sandbox_id = ${providerSandboxId} and ended_at is null
        and not exists (select 1 from sandbox_session s
          where s.provider_sandbox_id = sandbox_display.provider_sandbox_id
            and s.status in ('opening', 'ready', 'paused', 'closing'))`;
  }

  /**
   * Mark displays ended; returns those that were still live. A display a
   * person holds is left, read in the statement that ends it. With `reaping`,
   * so is one that is no longer reapable by the time the statement runs: a
   * chat that came back to it since it was listed keeps it.
   */
  async end(
    ids: string[],
    reason: string,
    options: { reaping?: boolean } = {},
  ): Promise<DisplayRow[]> {
    if (!ids.length) return [];
    const rows = await this.sql`update sandbox_display d
      set ended_at = now(), end_reason = ${reason}
      where d.id in ${this.sql(ids)} and d.ended_at is null and not ${heldByPerson(this.sql)}
        ${options.reaping ? this.sql`and ${this.unused()}` : this.sql``}
      returning d.*`;
    return rows.map(toDisplay);
  }

  /**
   * A condition on a live display `d`: no running attempt uses it, and its
   * chat or run has ended or nothing has used it for the idle period.
   */
  private unused() {
    return this.sql`not (d.attempt_id is not null and ${liveAttempt(this.sql, 'd.attempt_id')})
      and (not exists (select 1 from job o where o.id = d.owner_job_id
          and o.state not in ('completed', 'failed', 'cancelled'))
        or d.used_at < now() - make_interval(secs => ${this.idleMs / 1000}))`;
  }

  /**
   * Displays to end now: their chat or run has ended, or nothing has used them
   * for the idle period. None in use by a running attempt, and none a person
   * holds: those stay until they are handed back.
   */
  async reapable(limit = 100): Promise<Array<DisplayRow & { reason: string }>> {
    const rows = await this.sql`select d.*, case
          when o.id is null or o.state in ('completed', 'failed', 'cancelled')
            then 'its conversation or run ended'
          else 'unused for a while' end as reason
      from sandbox_display d left join job o on o.id = d.owner_job_id
      where d.ended_at is null and ${this.unused()} and not ${heldByPerson(this.sql)}
      order by d.used_at limit ${limit}`;
    return rows.map((row) => ({ ...toDisplay(row), reason: String(row.reason) }));
  }

  /** The live displays a stopped chat or run has, which the stop ends. */
  async ofStopped(jobId: string): Promise<DisplayRow[]> {
    const owner = await ownerJobOf(this.sql, jobId);
    return this.ofOwner(owner);
  }
}

/**
 * Hand a computer whose attempt has gone to a joined attempt still running,
 * so it is not suspended under a chat using it. With `sessionId`, only that
 * row; with `ended`, a row whose attempt is that one counts as gone too.
 * Returns the rows handed on.
 */
export async function passToJoiners(
  sql: Query,
  leaseSeconds: number,
  scope: { sessionId?: string; ended?: string } = {},
): Promise<string[]> {
  const rows = await sql`with candidate as (
      select distinct on (s.id) s.id as session_id, d.attempt_id, a.job_id
      from sandbox_session s
      join sandbox_display d on d.provider_sandbox_id = s.provider_sandbox_id
        and d.connection_id = s.connection_id and d.ended_at is null
      join attempt a on a.id = d.attempt_id and a.ended_at is null
        and (a.lease_expires_at is null or a.lease_expires_at > now())
      where s.status = 'ready' and s.held_by is distinct from 'processes'
        ${scope.sessionId ? sql`and s.id = ${scope.sessionId}` : sql``}
        and d.attempt_id is distinct from s.attempt_id
        and (s.attempt_id is null
          ${scope.ended ? sql`or s.attempt_id = ${scope.ended}` : sql``}
          or not ${liveAttempt(sql, 's.attempt_id')})
        and not exists (select 1 from sandbox_session o where o.attempt_id = d.attempt_id
          and o.status not in ('closed', 'lost'))
      order by s.id, d.used_at desc)
    update sandbox_session s set attempt_id = c.attempt_id, job_id = c.job_id, held_by = 'attempt',
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      seconds_charged = extract(epoch from now() - s.opened_at)
    from candidate c where s.id = c.session_id
    returning s.id`;
  return rows.map((row) => String(row.id));
}
