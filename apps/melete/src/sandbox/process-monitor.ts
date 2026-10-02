/**
 * The process monitor: what wakes a job when something it asked about happens
 * in a background process, and nothing else.
 *
 * A job asks with a watch (`process.start` with `notify`, or `process.wait` with `later`):
 * on the process's end, on a line of output, or on a port it opens. The
 * monitor asks each computer whose processes are watched how they are, every
 * few seconds on Docker and every half minute on remote providers, in one
 * helper call per computer. What it finds is delivered on the computer's
 * sandbox connection through `TriggerService.deliver`, and the watch's own
 * predicate decides whether the job wakes. Nothing is delivered for silence:
 * a process that prints nothing the watch wants costs no attempt and no model
 * call. Output wakes a job at most once a minute per watch; lines that came
 * meanwhile are covered by that one wake.
 *
 * The monitor never opens, resumes or wakes a computer. It asks only a
 * computer that is running for an attempt or for its processes; one the
 * service is suspending is left alone, so a wake cannot reach a computer while
 * it pauses, and the job it wakes opens the computer the ordinary way, after
 * the suspend has finished.
 *
 * Once a watched process has ended, its exit watches are told, a watch for a
 * line or a port that never came wakes its job with how the process ended,
 * and the watches go (`TriggerService.processEnded`).
 *
 * It is background work for one instance at a time: `leads` says whether this
 * instance is the one.
 */
import {
  compileWatchPattern,
  isTerminal,
  type JsonObject,
  jobState,
  PROCESS_LIMITS,
  type ProcessWatchKind,
  WATCH_MAX_SCAN,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { terminalText } from '../experience/computer.ts';
import {
  type EventDelivery,
  PROCESS_EVENTS,
  PROCESS_WATCH_SQL,
  watchedProcess,
} from '../jobs/triggers.ts';
import type { ComputerStatus, ProcessComputer } from './process-helper.ts';
import {
  LIVE_STATES,
  type ProcessProviders,
  type ProcessRow,
  rowOf,
  type SandboxProcesses,
} from './processes.ts';
import type { SandboxHandle } from './types.ts';

/** How often a computer is asked: Docker is local and cheap, remote providers bill per call. */
export const MONITOR_DOCKER_MS = 5_000;
export const MONITOR_REMOTE_MS = 30_000;
/** How long one computer may take to answer before the pass moves on. */
const COMPUTER_BUDGET_MS = 20_000;
/** How much one read of a watch's output takes. */
const SCAN_BYTES = 64 * 1024;
/** The most output one pass reads for one watch; a process further ahead has its older output skipped. */
const PASS_BYTES = 1024 * 1024;

export type ProcessWakes = {
  deliver(input: EventDelivery): Promise<unknown>;
  processEnded(processId: string, observation: JsonObject): Promise<number>;
};

export type ProcessMonitorOptions = {
  sql: Sql;
  processes: SandboxProcesses;
  providers: ProcessProviders;
  wakes: ProcessWakes;
  /** Whether this instance runs the monitor now; one instance at a time does. */
  leads?: () => boolean | Promise<boolean>;
  dockerMs?: number;
  remoteMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

type Watch = {
  id: string;
  jobId: string;
  enabled: boolean;
  /** Its job has finished: nothing can wake it, so the watch goes. */
  finished: boolean;
  kind: ProcessWatchKind;
  pattern: string | null;
};
type Watched = { row: ProcessRow; notify: NotifyState; watches: Watch[] };
type OutputState = { scanned: number; delivered_at: string | null };
type NotifyState = {
  watches?: Record<string, OutputState>;
  listening?: Record<string, boolean>;
};

/** A line as a watch reads it: no terminal escapes or control characters, and no longer than a watch scans. */
export function lineOf(bytes: Uint8Array): string {
  return (
    new TextDecoder()
      .decode(bytes)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are removed on purpose
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\p{Cc}/gu, '')
      .slice(0, WATCH_MAX_SCAN)
  );
}

export class ProcessMonitor {
  private readonly polled = new Map<string, number>();
  private readonly now: () => Date;
  private readonly say: (line: string) => void;

  constructor(private readonly options: ProcessMonitorOptions) {
    this.now = options.now ?? (() => new Date());
    this.say = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** Every watched process, with its watches, as the database has them now. */
  private async watched(): Promise<Map<string, Watched>> {
    const { sql } = this.options;
    // A partial index on the watched process id (migration 0085) keeps this to
    // the process watches, however many other triggers there are.
    const raw = await sql`select t.id as watch_id, t.job_id as watch_job_id,
        t.enabled as watch_enabled, t.spec as watch_spec, j.state as watch_job_state, p.*
      from trigger t
      join sandbox_process p on p.id = t.spec #>> '{predicate,all,0,value}'
      left join job j on j.id = t.job_id
      where ${sql.unsafe(PROCESS_WATCH_SQL('t'))}
      order by p.id, t.id`;
    const out = new Map<string, Watched>();
    for (const each of raw) {
      const watch = watchedProcess(each.watch_spec);
      if (!watch) continue;
      const id = String(each.id);
      const found = out.get(id) ?? {
        row: rowOf(each),
        notify: (each.notify ?? {}) as NotifyState,
        watches: [],
      };
      found.watches.push({
        id: String(each.watch_id),
        jobId: String(each.watch_job_id),
        enabled: each.watch_enabled === true,
        finished: !jobState.safeParse(each.watch_job_state).success
          ? true
          : isTerminal(jobState.parse(each.watch_job_state)),
        kind: watch.kind,
        pattern: watch.pattern,
      });
      out.set(id, found);
    }
    return out;
  }

  /**
   * The computer's helper, when the computer is running for an attempt or
   * for its processes. Null for a computer that is paused, being opened, or
   * being suspended (ready, with neither an attempt nor its processes holding
   * it), and for one whose provider this instance does not have.
   */
  private async reach(
    row: ProcessRow,
  ): Promise<{ computer: ProcessComputer; adapter: string } | null> {
    const held = this.options.providers().get(row.connectionId);
    if (!held) return null;
    const [session] = await this.options.sql`select * from sandbox_session
      where space_id = ${row.spaceId} and agent_id = ${row.agentId}
        and connection_id = ${row.connectionId} and status = 'ready'
      order by opened_at desc limit 1`;
    if (!session) return null;
    if (session.attempt_id === null && session.held_by !== 'processes') return null;
    const handle: SandboxHandle = {
      providerSandboxId: String(session.provider_sandbox_id),
      imageDigest: (session.image_digest as string | null) ?? null,
      region: (session.region as string | null) ?? null,
    };
    return {
      computer: this.options.processes.computer(held.provider, handle),
      adapter: held.adapter,
    };
  }

  private async remember(id: string, path: [string, string], value: unknown): Promise<void> {
    await this.options.sql`update sandbox_process set notify = jsonb_set(
        coalesce(notify, '{}'::jsonb) || jsonb_build_object(${path[0]}::text,
          coalesce(notify->${path[0]}, '{}'::jsonb)),
        ${path}::text[], ${JSON.stringify(value)}::jsonb)
      where id = ${id}`;
  }

  private deliver(row: ProcessRow, kind: ProcessWatchKind, key: string, payload: JsonObject) {
    return this.options.wakes.deliver({
      connection_id: row.connectionId,
      event_name: PROCESS_EVENTS[kind],
      cursor: `process:${row.id}:${key}`,
      dedup_key: `process:${row.id}:${key}`,
      payload,
    });
  }

  /** One pass: ask the computers that are due, then settle the watches of processes that ended. */
  async pass(signal: AbortSignal): Promise<void> {
    if (!(await (this.options.leads?.() ?? true))) return;
    const found = await this.watched();
    // Nothing is watched: nothing to ask and nothing to settle.
    if (found.size === 0) return;
    // A finished job can no longer be woken, so its watches go now rather than
    // keeping its computer asked and its events delivered until the process ends.
    const finished = [...found.values()].flatMap((each) =>
      each.watches.filter((watch) => watch.finished).map((watch) => watch.id),
    );
    if (finished.length)
      await this.options.sql`delete from trigger where id in ${this.options.sql(finished)}`;
    const computers = new Map<string, Watched[]>();
    for (const each of found.values()) {
      each.watches = each.watches.filter((watch) => !watch.finished);
      if (!LIVE_STATES.includes(each.row.state) || !each.watches.some((watch) => watch.enabled))
        continue;
      const key = `${each.row.spaceId}\u0000${each.row.agentId}\u0000${each.row.connectionId}`;
      computers.set(key, [...(computers.get(key) ?? []), each]);
    }
    const now = this.now().getTime();
    for (const [key, members] of computers) {
      if (signal.aborted) return;
      const first = members[0];
      if (!first) continue;
      const adapter = this.options.providers().get(first.row.connectionId)?.adapter;
      const every =
        adapter === 'docker'
          ? (this.options.dockerMs ?? MONITOR_DOCKER_MS)
          : (this.options.remoteMs ?? MONITOR_REMOTE_MS);
      if (now - (this.polled.get(key) ?? 0) < every) continue;
      this.polled.set(key, now);
      try {
        await this.poll(members, signal);
      } catch (error) {
        this.say(`the processes of ${first.row.agentId} could not be watched: ${String(error)}`);
      }
    }
    for (const each of (await this.watched()).values()) {
      if (signal.aborted) return;
      if (LIVE_STATES.includes(each.row.state)) continue;
      try {
        await this.ended(each, signal);
      } catch (error) {
        this.say(`the watches on process ${each.row.id} were not settled: ${String(error)}`);
      }
    }
  }

  private async poll(members: Watched[], signal: AbortSignal): Promise<void> {
    const first = members[0];
    if (!first) return;
    const reached = await this.reach(first.row);
    if (!reached) return;
    const budget = AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_BUDGET_MS)]);
    const status: ComputerStatus = await reached.computer.status('all', budget);
    // The rows follow the computer first: an exit is recorded before it is told.
    const rows = await this.options.processes.reconcileWith(
      first.row.spaceId,
      first.row.agentId,
      reached.computer,
      status,
      budget,
    );
    for (const each of members) {
      const row = rows.find((candidate) => candidate.id === each.row.id) ?? each.row;
      const facts = status.processes.find((candidate) => candidate.id === row.id);
      if (!facts) continue;
      // A process that ended since the last pass still has its last lines read.
      const live = LIVE_STATES.includes(row.state);
      for (const watch of each.watches) {
        if (!watch.enabled) continue;
        if (watch.kind === 'listening' && live) {
          if (each.notify.listening?.[watch.id]) continue;
          const open = row.port === null ? facts.ports.length > 0 : facts.ports.includes(row.port);
          if (!open) continue;
          await this.deliver(row, 'listening', `listening:${watch.id}`, {
            process_id: row.id,
            watch: watch.id,
            port: row.port ?? facts.ports[0] ?? null,
            ports: facts.ports,
          });
          await this.remember(row.id, ['listening', watch.id], true);
        } else if (watch.kind === 'output') {
          await this.scan(reached.computer, row, facts.cursor, watch, each.notify, budget, !live);
        }
      }
    }
  }

  /**
   * New output for one output watch: the first line it wants since the last
   * wake is delivered, at most once a minute, and the lines read with it are
   * covered by that delivery. A pass reads until it has caught up with the
   * process, at most `PASS_BYTES`; a process further ahead than that has its
   * older output skipped, so a wake is never late by more than one pass. Only
   * whole lines are read until the process ends. Once it has ended (`final`),
   * its last `PASS_BYTES` are read to the end and the line found delivered
   * whatever the minute says: it is the last the watch will see.
   */
  private async scan(
    computer: ProcessComputer,
    row: ProcessRow,
    cursor: number,
    watch: Watch,
    notify: NotifyState,
    signal: AbortSignal,
    final = false,
  ): Promise<void> {
    let own = notify.watches?.[watch.id] ?? { scanned: 0, delivered_at: null };
    if (cursor <= own.scanned) return;
    const now = this.now();
    if (
      !final &&
      own.delivered_at &&
      now.getTime() - Date.parse(own.delivered_at) < PROCESS_LIMITS.output_wake_seconds * 1000
    )
      return;
    const pattern = watch.pattern === null ? null : compileWatchPattern(watch.pattern);
    let position = own.scanned;
    // Bytes from a jump start mid-line: the first whole line is the first read.
    let partial = false;
    let total = cursor < Number.MAX_SAFE_INTEGER ? cursor : null;
    let match: { line: string; at: number } | null = null;
    let tail: Uint8Array = new Uint8Array(0);
    for (let reads = 0; reads <= PASS_BYTES / SCAN_BYTES + 1; reads++) {
      if (total !== null && total - position > PASS_BYTES) {
        position = total - PASS_BYTES;
        partial = true;
      }
      const answer = await computer.read(row.id, position, SCAN_BYTES, 0, signal);
      if (total === null || answer.read.total > total) {
        total = answer.read.total;
        if (total - position > PASS_BYTES) continue;
      }
      const bytes = answer.data;
      const from = answer.read.from;
      if (from > position) partial = true;
      let begin = 0;
      if (partial) {
        begin = bytes.indexOf(0x0a) + 1;
        if (begin === 0) {
          position = from + bytes.byteLength;
          if (bytes.byteLength === 0) break;
          continue;
        }
        partial = false;
      }
      const ended = answer.process.state !== 'running' && answer.process.state !== 'starting';
      const reachedEnd = answer.read.next >= answer.read.total;
      let end = bytes.lastIndexOf(0x0a) + 1;
      // A process that ended has no more of its last line to come, and a line
      // longer than one read is taken in pieces.
      if ((ended && reachedEnd) || (end <= begin && bytes.byteLength >= SCAN_BYTES))
        end = bytes.byteLength;
      if (end <= begin) {
        position = from + Math.max(begin, end);
        break;
      }
      for (let offset = begin; offset < end; ) {
        const newline = bytes.indexOf(0x0a, offset);
        const stop = newline === -1 || newline >= end ? end : newline;
        const line = lineOf(bytes.subarray(offset, stop));
        if (pattern ? pattern.matcher(line).find() : line.trim() !== '') {
          match = { line, at: from + offset };
          break;
        }
        offset = stop + 1;
      }
      tail = bytes.subarray(Math.max(begin, end - PROCESS_LIMITS.wake_tail_bytes), end);
      position = from + end;
      if (match || position >= answer.read.total) break;
    }
    if (match)
      await this.deliver(row, 'output', `output:${watch.id}:${match.at}`, {
        process_id: row.id,
        watch: watch.id,
        line: match.line,
        cursor: match.at,
        tail: terminalText(new TextDecoder().decode(tail), PROCESS_LIMITS.wake_tail_bytes, 'last'),
      });
    // The lines read with a match are covered by its wake.
    own = { scanned: position, delivered_at: match ? now.toISOString() : own.delivered_at };
    await this.remember(row.id, ['watches', watch.id], own);
  }

  /** A watched process ended: tell its exit watches, then let `processEnded` settle every watch on it. */
  private async ended(each: Watched, signal: AbortSignal): Promise<void> {
    const { row } = each;
    const pending: Watch[] = [];
    for (const watch of each.watches) {
      if (!watch.enabled || watch.kind !== 'exit') continue;
      const [told] = await this.options.sql`select 1 from event
        where dedup_key = ${`connector:${row.connectionId}:process:${row.id}:exited:${watch.id}`}`;
      if (!told) pending.push(watch);
    }
    // Lines printed just before the end still reach the output watches waiting for them.
    const outputs = each.watches.filter((watch) => watch.enabled && watch.kind === 'output');
    if (outputs.length) {
      const reached = await this.reach(row).catch(() => null);
      const budget = AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_BUDGET_MS)]);
      for (const watch of outputs) {
        if (!reached) break;
        await this.scan(
          reached.computer,
          row,
          Number.MAX_SAFE_INTEGER,
          watch,
          each.notify,
          budget,
          true,
        ).catch((error) => {
          this.say(`the last output of process ${row.id} was not read: ${String(error)}`);
        });
      }
    }
    const tail = pending.length ? await this.tail(row, signal) : null;
    const observation: JsonObject = {
      process_id: row.id,
      state: row.state,
      exit_code: row.exitCode,
      ended_because: row.endReason,
      tail: tail ?? terminalText(row.lastLine, PROCESS_LIMITS.wake_tail_bytes, 'last'),
    };
    for (const watch of pending)
      await this.deliver(row, 'exit', `exited:${watch.id}`, { ...observation, watch: watch.id });
    await this.options.wakes.processEnded(row.id, observation);
  }

  /** The end of what a process printed, when its computer is up to be asked. */
  private async tail(row: ProcessRow, signal: AbortSignal): Promise<string | null> {
    try {
      const reached = await this.reach(row);
      if (!reached) return null;
      const answer = await reached.computer.read(
        row.id,
        -1,
        PROCESS_LIMITS.wake_tail_bytes,
        0,
        AbortSignal.any([signal, AbortSignal.timeout(COMPUTER_BUDGET_MS)]),
      );
      return terminalText(
        new TextDecoder().decode(answer.data),
        PROCESS_LIMITS.wake_tail_bytes,
        'last',
      );
    } catch {
      return null;
    }
  }

  /** Run a pass every few seconds until stopped. */
  start(everyMs = Math.min(this.options.dockerMs ?? MONITOR_DOCKER_MS, MONITOR_DOCKER_MS)): {
    stop(): void;
  } {
    let running = false;
    const stopping = new AbortController();
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.pass(stopping.signal)
        .catch((error) => this.say(`process monitor pass failed: ${String(error)}`))
        .finally(() => {
          running = false;
        });
    }, everyMs);
    timer.unref?.();
    return {
      stop: () => {
        clearInterval(timer);
        stopping.abort();
      },
    };
  }
}

/**
 * The process monitor for an installation that keeps background processes, or
 * nothing when it keeps none. Its providers are the connector factory's, as
 * the process sweep's are.
 */
export function startProcessMonitor(
  factory: {
    options: { sandbox?: { processes?: SandboxProcesses } };
    sandboxProviders: ProcessProviders extends () => infer T ? T : never;
  },
  sql: Sql,
  wakes: ProcessWakes,
  leads?: () => boolean | Promise<boolean>,
): { stop(): void } | undefined {
  const processes = factory.options.sandbox?.processes;
  if (!processes) return undefined;
  return new ProcessMonitor({
    sql,
    processes,
    providers: () => factory.sandboxProviders,
    wakes,
    ...(leads ? { leads } : {}),
  }).start();
}
