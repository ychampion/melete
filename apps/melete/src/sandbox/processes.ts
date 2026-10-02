/**
 * Background processes in an agent's computer, from the service's side.
 *
 * A process belongs to the computer, which is one agent in one space, and is
 * attributed to the job and action that started it. Its row is written before
 * anything starts, under a lock on the space, so the caps are decided by
 * Postgres: a computer runs at most a few processes, a space a few more, and
 * the processes of a space may keep its computers running for a set time each
 * day. The action is unique on the row, so one admitted start is one process
 * however often it is dispatched; the helper's own directory per process is
 * the guard inside the computer.
 *
 * The rows follow the computer, never the other way round. Whenever the
 * service talks to a computer it reconciles: a process the computer reports
 * ended is closed with its exit status, one recorded under an earlier boot is
 * lost, and one the service has already closed but the computer still runs
 * is killed. A periodic sweep does the same for computers nobody is using,
 * stops processes past their time limit, stops a space's processes once its
 * allowance for the day is used, and stops those whose starting job was
 * cancelled or deleted. A process outlives the job that started it when that
 * job completes; that is the point of it.
 */
import type { ProcessState } from '@melete/contracts';
import type { Sql } from 'postgres';
import { recordId } from '../broker/records.ts';
import {
  helperComputer,
  type ProcessComputer,
  type ProcessComputerFor,
  type ProcessFacts,
  ProcessHelperLost,
  ProcessHelperRefusal,
  ProcessHelperUnavailable,
} from './process-helper.ts';
import type { SandboxHandle, SandboxProvider } from './types.ts';

export type ProcessLimits = {
  maxPerComputer: number;
  maxPerSpace: number;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
  outputMaxBytes: number;
  awakeSecondsPerDay: number;
};

export const LIVE_STATES: readonly ProcessState[] = ['starting', 'running'];
const FINAL_STATES: readonly ProcessState[] = ['exited', 'stopped', 'expired', 'lost'];

export type ProcessRow = {
  id: string;
  spaceId: string;
  agentId: string;
  connectionId: string;
  sessionId: string | null;
  jobId: string | null;
  actionId: string | null;
  command: string;
  commandDigest: string;
  cwd: string;
  name: string;
  port: number | null;
  state: ProcessState;
  exitCode: number | null;
  signal: string | null;
  bootId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  expiresAt: Date;
  outputCursor: number;
  outputBytes: number;
  lastLine: string | null;
  lastOutputAt: Date | null;
  endReason: string | null;
  createdAt: Date;
};

function rowOf(raw: Record<string, unknown>): ProcessRow {
  const date = (value: unknown) => (value ? new Date(value as string) : null);
  return {
    id: String(raw.id),
    spaceId: String(raw.space_id),
    agentId: String(raw.agent_id),
    connectionId: String(raw.connection_id),
    sessionId: (raw.session_id as string | null) ?? null,
    jobId: (raw.job_id as string | null) ?? null,
    actionId: (raw.action_id as string | null) ?? null,
    command: String(raw.command_redacted),
    commandDigest: String(raw.command_digest),
    cwd: String(raw.cwd),
    name: String(raw.name),
    port: raw.port === null || raw.port === undefined ? null : Number(raw.port),
    state: raw.state as ProcessState,
    exitCode: raw.exit_code === null || raw.exit_code === undefined ? null : Number(raw.exit_code),
    signal: (raw.signal as string | null) ?? null,
    bootId: (raw.boot_id as string | null) ?? null,
    startedAt: date(raw.started_at),
    endedAt: date(raw.ended_at),
    expiresAt: new Date(raw.expires_at as string),
    outputCursor: Number(raw.output_cursor ?? 0),
    outputBytes: Number(raw.output_bytes ?? 0),
    lastLine: (raw.last_line as string | null) ?? null,
    lastOutputAt: date(raw.last_output_at),
    endReason: (raw.end_reason as string | null) ?? null,
    createdAt: new Date(raw.created_at as string),
  };
}

/** A start the caps refuse; nothing was recorded and nothing ran. */
export class ProcessRefusal extends Error {
  override readonly name = 'ProcessRefusal';
  constructor(
    readonly code:
      | 'computer_full'
      | 'space_full'
      | 'awake_allowance_used'
      | 'no_computer'
      | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

/** Why a process was ended by the service, in words the person can be told. */
export const END_REASONS = {
  expired: 'its time limit passed',
  allowance: "the space's awake time for today was used up",
  job: 'the job that started it was cancelled or deleted',
  connection: "the computer's connection was revoked or removed",
  computer_gone: 'the computer it ran in no longer exists',
  restarted: 'the computer restarted, which ends every process in it',
  vanished: 'its record in the computer is gone',
  stopped: 'it was stopped',
} as const;

export type AdmitRequest = {
  actionId: string;
  spaceId: string;
  agentId: string;
  connectionId: string;
  sessionId: string;
  jobId: string;
  command: string;
  commandDigest: string;
  cwd: string;
  name: string;
  port: number | null;
  ttlMinutes: number | null;
};

const DAY_MS = 86_400_000;
/** How long a start may take to reach the computer before its missing directory means it never did. */
const STARTING_GRACE_MS = 120_000;
/** A time as Postgres reads it; the driver is given text, never a Date. */
const iso = (ms: number) => new Date(ms).toISOString();

/** The time the union of these intervals covers, in seconds. */
export function coveredSeconds(intervals: readonly [number, number][]): number {
  const sorted = intervals.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = Number.NEGATIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const [from, to] of sorted) {
    if (from > end) {
      if (end > start) total += end - start;
      start = from;
      end = to;
    } else if (to > end) end = to;
  }
  if (end > start) total += end - start;
  return total / 1000;
}

export type SandboxProcessesOptions = {
  limits: ProcessLimits;
  /** How the service reaches one computer's processes; the helper unless a test says otherwise. */
  computerFor?: ProcessComputerFor;
  now?: () => Date;
  log?: (line: string) => void;
};

export type ProcessProviders = () => ReadonlyMap<
  string,
  { adapter: string; provider: SandboxProvider }
>;

export class SandboxProcesses {
  readonly limits: ProcessLimits;
  private readonly computerFor: ProcessComputerFor;
  private readonly now: () => Date;
  private readonly say: (line: string) => void;

  constructor(
    private readonly sql: Sql,
    options: SandboxProcessesOptions,
  ) {
    this.limits = options.limits;
    this.computerFor = options.computerFor ?? helperComputer;
    this.now = options.now ?? (() => new Date());
    this.say = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  computer(provider: SandboxProvider, handle: SandboxHandle): ProcessComputer {
    return this.computerFor(provider, handle);
  }

  /** The time limit a start asks for, held to the longest allowed. */
  ttlMinutes(requested: number | null): number {
    return Math.min(requested ?? this.limits.defaultTtlMinutes, this.limits.maxTtlMinutes);
  }

  async get(id: string): Promise<ProcessRow | null> {
    const [row] = await this.sql`select * from sandbox_process where id = ${id}`;
    return row ? rowOf(row) : null;
  }

  async byAction(actionId: string): Promise<ProcessRow | null> {
    const [row] = await this.sql`select * from sandbox_process where action_id = ${actionId}`;
    return row ? rowOf(row) : null;
  }

  /** One computer's processes: every live one, then the most recent ended ones. */
  async forComputer(spaceId: string, agentId: string, ended = 20): Promise<ProcessRow[]> {
    const rows = await this.sql`(select * from sandbox_process
        where space_id = ${spaceId} and agent_id = ${agentId}
          and state in ('starting', 'running'))
      union all
      (select * from sandbox_process
        where space_id = ${spaceId} and agent_id = ${agentId}
          and state not in ('starting', 'running')
        order by created_at desc limit ${ended})
      order by created_at desc`;
    return rows.map(rowOf);
  }

  /** How long the space's processes have kept its computers running today (UTC), in seconds. */
  async awakeSecondsToday(spaceId: string, sql: Sql = this.sql): Promise<number> {
    const now = this.now().getTime();
    const dayStart = now - (now % DAY_MS);
    const rows = await sql`select coalesce(started_at, created_at) as began, ended_at
      from sandbox_process
      where space_id = ${spaceId}
        and (ended_at is null or ended_at > ${iso(dayStart)}::timestamptz)
        and created_at < ${iso(now)}::timestamptz`;
    return coveredSeconds(
      rows.map((row) => [
        Math.max(new Date(row.began as string).getTime(), dayStart),
        Math.min(row.ended_at ? new Date(row.ended_at as string).getTime() : now, now),
      ]),
    );
  }

  /**
   * Record a start before anything runs, within the caps; or hand back the row
   * an earlier dispatch of the same action wrote. Counting and inserting
   * happen under one lock per space, so two starts cannot both take the last
   * place.
   */
  async admit(request: AdmitRequest): Promise<{ row: ProcessRow; repeated: boolean }> {
    return (await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`sandbox-process:${request.spaceId}`}))`;
      const [prior] = await tx`select * from sandbox_process where action_id = ${request.actionId}`;
      if (prior) return { row: rowOf(prior), repeated: true };
      const [counts] = await tx`select
          count(*) filter (where agent_id = ${request.agentId})::int as computer,
          count(*)::int as space
        from sandbox_process
        where space_id = ${request.spaceId} and state in ('starting', 'running')`;
      if (Number(counts?.computer ?? 0) >= this.limits.maxPerComputer)
        throw new ProcessRefusal(
          'computer_full',
          `This computer is already running ${this.limits.maxPerComputer} processes. Nothing was started. Stop one first, or tell the person`,
        );
      if (Number(counts?.space ?? 0) >= this.limits.maxPerSpace)
        throw new ProcessRefusal(
          'space_full',
          `This space is already running ${this.limits.maxPerSpace} processes across its computers. Nothing was started. Stop one first, or tell the person`,
        );
      const used = await this.awakeSecondsToday(request.spaceId, tx as unknown as Sql);
      if (used >= this.limits.awakeSecondsPerDay)
        throw new ProcessRefusal(
          'awake_allowance_used',
          `This space's awake time for today is used up (${hours(this.limits.awakeSecondsPerDay)} of ${hours(this.limits.awakeSecondsPerDay)}). Nothing was started. It resets at midnight UTC; tell the person`,
        );
      const ttl = this.ttlMinutes(request.ttlMinutes);
      const [row] = await tx`insert into sandbox_process
          (id, space_id, agent_id, connection_id, session_id, job_id, action_id,
           command_redacted, command_digest, cwd, name, port, state, expires_at)
        values (${recordId('prc')}, ${request.spaceId}, ${request.agentId},
          ${request.connectionId}, ${request.sessionId}, ${request.jobId}, ${request.actionId},
          ${request.command}, ${request.commandDigest}, ${request.cwd}, ${request.name},
          ${request.port}, 'starting',
          ${iso(this.now().getTime() + ttl * 60_000)}::timestamptz)
        returning *`;
      if (!row) throw new Error('the process row was not written');
      return { row: rowOf(row), repeated: false };
    })) as { row: ProcessRow; repeated: boolean };
  }

  /** A start the helper refused or could not reach: the row is closed, since nothing runs. */
  async abandon(id: string, reason: string): Promise<void> {
    await this.sql`update sandbox_process
      set state = 'lost', ended_at = coalesce(ended_at, now()), end_reason = ${reason.slice(0, 500)}
      where id = ${id} and state = 'starting'`;
  }

  /** Bring one row up to what the computer says about its process. */
  async apply(row: ProcessRow, facts: ProcessFacts, boot: string): Promise<ProcessRow> {
    const recordedBoot = row.bootId ?? boot;
    let state: ProcessState = row.state;
    let endReason: string | null = row.endReason;
    let exitCode = row.exitCode;
    if (LIVE_STATES.includes(row.state)) {
      if (recordedBoot !== boot || facts.state === 'lost') {
        state = 'lost';
        endReason = END_REASONS.restarted;
      } else if (facts.state === 'exited') {
        state = 'exited';
        exitCode = facts.exit_code;
      } else if (facts.state === 'running') state = 'running';
    }
    const grew = facts.cursor > row.outputCursor;
    const [updated] = await this.sql`update sandbox_process set
        state = ${state},
        exit_code = ${exitCode},
        end_reason = ${endReason},
        boot_id = coalesce(boot_id, ${boot}),
        started_at = coalesce(started_at, ${facts.started ? iso(facts.started) : null}::timestamptz),
        ended_at = case when ${state} in ('starting', 'running') then null
          else coalesce(ended_at, now()) end,
        output_cursor = greatest(output_cursor, ${facts.cursor}),
        last_line = coalesce(${facts.last_line}, last_line),
        last_output_at = case when ${grew} then now() else last_output_at end
      where id = ${row.id}
      returning *`;
    return updated ? rowOf(updated) : row;
  }

  /** Close a row the service ended, with the reason it ended. */
  async close(
    id: string,
    state: Extract<ProcessState, 'stopped' | 'expired' | 'lost' | 'exited'>,
    reason: string | null,
    facts?: ProcessFacts,
  ): Promise<ProcessRow | null> {
    const [row] = await this.sql`update sandbox_process set
        state = ${state},
        exit_code = coalesce(${facts?.state === 'exited' ? facts.exit_code : null}, exit_code),
        end_reason = coalesce(end_reason, ${reason}),
        ended_at = coalesce(ended_at, now()),
        output_cursor = greatest(output_cursor, ${facts?.cursor ?? 0}),
        last_line = coalesce(${facts?.last_line ?? null}, last_line)
      where id = ${id} and state in ('starting', 'running')
      returning *`;
    // A row that ended meanwhile keeps the end it was given first.
    return row ? rowOf(row) : this.get(id);
  }

  /** A later time limit, never past the longest from its start. */
  async extend(id: string, ttlMinutes: number): Promise<ProcessRow | null> {
    const minutes = Math.min(ttlMinutes, this.limits.maxTtlMinutes);
    const [row] = await this.sql`update sandbox_process set
        expires_at = least(
          ${iso(this.now().getTime() + minutes * 60_000)}::timestamptz,
          coalesce(started_at, created_at) + make_interval(mins => ${this.limits.maxTtlMinutes}))
      where id = ${id} and state in ('starting', 'running')
      returning *`;
    return row ? rowOf(row) : null;
  }

  /**
   * Reconcile one computer's rows with what its helper reports, and end what
   * the service has decided must end. Returns the rows as they now stand.
   */
  async reconcile(
    spaceId: string,
    agentId: string,
    computer: ProcessComputer,
    signal: AbortSignal,
  ): Promise<ProcessRow[]> {
    const status = await computer.status('all', signal);
    const found = new Map(status.processes.map((facts) => [facts.id, facts]));
    const rows = await this.forComputer(spaceId, agentId);
    const out: ProcessRow[] = [];
    for (const row of rows) {
      const facts = found.get(row.id);
      if (LIVE_STATES.includes(row.state)) {
        if (!facts) {
          // A start still on its way to the computer has not made its directory yet.
          if (
            row.state === 'starting' &&
            this.now().getTime() - row.createdAt.getTime() < STARTING_GRACE_MS
          ) {
            out.push(row);
            continue;
          }
          // A start whose helper never made the directory left nothing to find.
          out.push(
            (await this.close(row.id, 'lost', END_REASONS.vanished)) ?? { ...row, state: 'lost' },
          );
          continue;
        }
        out.push(await this.apply(row, facts, status.boot));
        continue;
      }
      // Ended here and still running there: the service's decision stands.
      if (facts && facts.state === 'running' && (row.bootId ?? status.boot) === status.boot) {
        await computer.stop(row.id, 0, signal).catch((error) => {
          this.say(`process ${row.id} could not be killed: ${String(error)}`);
        });
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Stop one live process and close its row with the reason. Whatever the
   * computer answers, the row ends: a computer that cannot be reached kills
   * nothing, and the next contact with it does.
   */
  async end(
    row: ProcessRow,
    computer: ProcessComputer | null,
    state: 'stopped' | 'expired',
    reason: string,
    signal: AbortSignal,
    graceMs = 10_000,
  ): Promise<ProcessRow> {
    let facts: ProcessFacts | undefined;
    if (computer) {
      try {
        facts = (await computer.stop(row.id, graceMs, signal)).process;
      } catch (error) {
        this.say(`process ${row.id} was not stopped in its computer: ${String(error)}`);
      }
    }
    return (await this.close(row.id, state, reason, facts)) ?? row;
  }

  /** Close every live row of a connection whose computers were destroyed with it. */
  async closeForConnection(connectionId: string, reason: string = END_REASONS.connection) {
    const rows = await this.sql`update sandbox_process
      set state = 'stopped', ended_at = coalesce(ended_at, now()),
        end_reason = coalesce(end_reason, ${reason})
      where connection_id = ${connectionId} and state in ('starting', 'running')
      returning id`;
    return rows.map((row) => String(row.id));
  }

  /**
   * The periodic pass: end what must end, and bring rows of computers nobody
   * is using up to date. Each computer is asked once.
   */
  async sweep(providers: ProcessProviders, signal: AbortSignal): Promise<{ ended: string[] }> {
    const ended: string[] = [];
    const live = (
      await this.sql`select p.*, c.status as connection_status,
          j.state as job_state
        from sandbox_process p
        join connection c on c.id = p.connection_id
        left join job j on j.id = p.job_id
        where p.state in ('starting', 'running')
        order by p.space_id, p.agent_id`
    ).map((raw) => ({
      row: rowOf(raw),
      connectionActive: raw.connection_status === 'active',
      jobGone: raw.job_id === null || raw.job_state === 'cancelled',
    }));
    const computers = new Map<string, typeof live>();
    for (const each of live) {
      const key = `${each.row.spaceId}\u0000${each.row.agentId}\u0000${each.row.connectionId}`;
      computers.set(key, [...(computers.get(key) ?? []), each]);
    }
    const overAllowance = new Set<string>();
    for (const spaceId of new Set(live.map((each) => each.row.spaceId)))
      if ((await this.awakeSecondsToday(spaceId)) >= this.limits.awakeSecondsPerDay)
        overAllowance.add(spaceId);

    for (const members of computers.values()) {
      const first = members[0];
      if (!first) continue;
      const { spaceId, agentId, connectionId } = first.row;
      if (!first.connectionActive) {
        ended.push(...(await this.closeForConnection(connectionId)));
        continue;
      }
      const held = providers().get(connectionId);
      const [session] = await this.sql`select * from sandbox_session
        where space_id = ${spaceId} and agent_id = ${agentId} and connection_id = ${connectionId}
          and status in ('opening', 'ready', 'paused')
        order by opened_at desc limit 1`;
      if (!session) {
        for (const { row } of members) {
          await this.close(row.id, 'lost', END_REASONS.computer_gone);
          ended.push(row.id);
        }
        continue;
      }
      if (!held) continue;
      const handle: SandboxHandle = {
        providerSandboxId: String(session.provider_sandbox_id),
        imageDigest: (session.image_digest as string | null) ?? null,
        region: (session.region as string | null) ?? null,
      };
      let reachable = false;
      try {
        const where = await held.provider.inspect(handle, signal);
        if (where === 'gone') {
          for (const { row } of members) {
            await this.close(row.id, 'lost', END_REASONS.computer_gone);
            ended.push(row.id);
          }
          continue;
        }
        // A computer that is not running is not woken for this: what must end
        // is closed here, and killed the next time the computer is used.
        reachable = where === 'running' && session.status !== 'opening';
      } catch (error) {
        this.say(`the computer of ${agentId} could not be inspected: ${String(error)}`);
        continue;
      }
      const computer = reachable ? this.computer(held.provider, handle) : null;
      let current = members.map((each) => each.row);
      if (computer) {
        try {
          current = (await this.reconcile(spaceId, agentId, computer, signal)).filter((row) =>
            LIVE_STATES.includes(row.state),
          );
        } catch (error) {
          if (
            !(error instanceof ProcessHelperLost) &&
            !(error instanceof ProcessHelperRefusal) &&
            !(error instanceof ProcessHelperUnavailable)
          )
            throw error;
          this.say(`the processes of ${agentId} could not be read: ${String(error)}`);
        }
      }
      const now = this.now().getTime();
      for (const row of current) {
        const member = members.find((each) => each.row.id === row.id);
        let ending: { state: 'stopped' | 'expired'; reason: string } | null = null;
        if (row.expiresAt.getTime() <= now)
          ending = { state: 'expired', reason: END_REASONS.expired };
        else if (overAllowance.has(spaceId))
          ending = { state: 'stopped', reason: END_REASONS.allowance };
        else if (member?.jobGone) ending = { state: 'stopped', reason: END_REASONS.job };
        if (!ending) continue;
        await this.end(row, computer, ending.state, ending.reason, signal);
        ended.push(row.id);
      }
    }
    return { ended };
  }

  /** Run the sweep on a timer. */
  start(providers: ProcessProviders, everyMs = 60_000): { stop(): void } {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.sweep(providers, AbortSignal.timeout(Math.max(everyMs * 2, 120_000)))
        .catch((error) => this.say(`process sweep failed: ${String(error)}`))
        .finally(() => {
          running = false;
        });
    }, everyMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }
}

const hours = (seconds: number) => {
  const value = seconds / 3600;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} hours`;
};

export { FINAL_STATES };

/**
 * The process sweep for an installation that owns sandboxes, or nothing when
 * it owns none. Its providers are the connector factory's, so a connection's
 * key stays with the connection.
 */
export function startProcesses(factory: {
  options: { sandbox?: { processes?: SandboxProcesses } };
  sandboxProviders: ReadonlyMap<string, { adapter: string; provider: SandboxProvider }>;
}): { stop(): void } | undefined {
  const processes = factory.options.sandbox?.processes;
  if (!processes) return undefined;
  return processes.start(() => factory.sandboxProviders);
}
