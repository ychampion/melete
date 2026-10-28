/**
 * A terminal command that gives way instead of holding the turn.
 *
 * Where the agent's computer can keep background processes, `terminal.run`
 * starts its command the way `process.start` does: a process row that owns
 * it, its output in the computer's ring, and the marker wrapper around it as
 * for any command, keyed by the action. The service then waits a bounded time.
 * A command that ends in that time is settled from its marker exactly as one
 * run through the provider's own exec is, and its row goes, since nothing of
 * it outlives the step. One still running then moves to the background: the
 * action settles with the process's id, how long it has run, what it has
 * printed so far and why it moved, and an exit watch wakes the conversation
 * when it ends, with its exit code and last lines.
 *
 * The person speaking during the command moves it at once (`CommandYields`),
 * so the step ends and their words reach the model at its end. On a computer
 * whose processes end when it is suspended, nothing moves for time alone: the
 * command holds the turn as before and is stopped at its timeout, and only the
 * person's words move it, with a note that it stops when the turn ends.
 *
 * A command is never run twice. The marker is the action id, the row is
 * unique on it, and a second dispatch of the same action reads the process
 * back: still running, or settled from its marker once it has ended.
 */
import {
  EXEC_LIMITS,
  type JsonValue,
  PROCESS_LIMITS,
  type SandboxConnectionConfig,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { terminalText } from '../experience/computer.ts';
import { createProcessWatch, ProcessWatchRefusal } from '../jobs/triggers.ts';
import {
  type CommandResult,
  envFileBody,
  keptFor,
  launchScript,
  REENTERED_EXIT,
  type RunOptions,
  runCommand,
  settleOutcome,
} from '../sandbox/marker.ts';
import {
  type ProcessComputer,
  ProcessHelperRefusal,
  ProcessHelperUnavailable,
} from '../sandbox/process-helper.ts';
import {
  END_REASONS,
  LIVE_STATES,
  ProcessRefusal,
  type ProcessRow,
  type SandboxProcesses,
} from '../sandbox/processes.ts';
import { type SessionRow, sessionHandle } from '../sandbox/sessions.ts';
import type { ExecOutcome, SandboxProvider } from '../sandbox/types.ts';
import type { ConnectorContext } from './types.ts';

/**
 * The running commands of each attempt that the person's words may move to
 * the background. One per process; a steer moves every command its attempt
 * is waiting on.
 */
export class CommandYields {
  private readonly held = new Map<string, Set<() => void>>();

  /** Wait on a command for this attempt; the returned function lets it go. */
  hold(attemptId: string, promote: () => void): () => void {
    let waiting = this.held.get(attemptId);
    if (!waiting) {
      waiting = new Set();
      this.held.set(attemptId, waiting);
    }
    waiting.add(promote);
    return () => {
      waiting.delete(promote);
      if (!waiting.size) this.held.delete(attemptId);
    };
  }

  /** The person spoke: every command this attempt waits on moves now. How many did. */
  promote(attemptId: string): number {
    const waiting = [...(this.held.get(attemptId) ?? [])];
    for (const promote of waiting) promote();
    return waiting.length;
  }
}

/** The one this service runs: the runner moves commands in it when the person speaks. */
export const commandYields = new CommandYields();

/** Why a command moved to the background. */
export type MovedBecause = 'still_running' | 'person_spoke';

export type YieldingRun = {
  provider: SandboxProvider;
  processes: SandboxProcesses;
  sql: Sql;
  config: SandboxConnectionConfig;
  connectionId: string;
  session: SessionRow;
  ctx: ConnectorContext;
  actionId: string;
  attemptId: string;
  agentId: string;
  command: string;
  /** Relative to `/work`, as the receipt says it. */
  cwd: string;
  /** Inside the computer. */
  cwdPath: string;
  timeoutMs: number;
  /** How long the command holds the step before it moves; Infinity to move only for the person. */
  yieldAfterMs: number;
  env: Readonly<Record<string, string>>;
  forget: readonly string[];
  dispatch: 'first' | 'again';
  workRoot: string;
  signal: AbortSignal;
  yields?: CommandYields;
  limits?: RunOptions['limits'];
};

/**
 * What came of it: settled from the marker like any command, moved to the
 * background with what to say about it, or not started here at all, so the
 * caller runs it through the provider's exec as before.
 */
export type YieldOutcome =
  | { kind: 'settled'; result: CommandResult }
  | { kind: 'moved'; row: ProcessRow; detail: Record<string, JsonValue> }
  | { kind: 'not_started' };

/** Computers found with no way to keep a process, so later commands do not ask again. */
const NO_HELPER = new Set<string>();
const remember = (sandbox: string) => {
  if (NO_HELPER.size > 4096) NO_HELPER.clear();
  NO_HELPER.add(sandbox);
};

/** Whether a command in this computer can be started as a process at all. */
export const canKeepProcesses = (session: SessionRow): boolean =>
  !NO_HELPER.has(`${session.adapter}:${session.providerSandboxId}`);

/** How long the start itself waits: long enough that a quick command ends in it. */
const START_WAIT_MS = 1_000;

/** How often the wait asks the computer: soon at first, then every two seconds. */
const POLL_MS = [100, 250, 500, 1_000, 1_000, 2_000];

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function runYielding(input: YieldingRun): Promise<YieldOutcome> {
  const { processes, provider, session, signal } = input;
  const handle = sessionHandle(session);
  const computer = processes.computer(provider, handle);
  const runOptions: RunOptions = {
    provider,
    handle,
    request: {
      marker: input.actionId,
      argv: ['sh', '-c', input.command],
      cwd: input.cwdPath,
      timeoutMs: input.timeoutMs,
      dispatch: input.dispatch,
    },
    workRoot: input.workRoot,
    jobId: input.ctx.job_id,
    signal,
    ...(input.limits ? { limits: input.limits } : {}),
  };

  const existing = await processes.byAction(input.actionId);
  if (existing) return readBack(input, computer, runOptions, existing);
  // Dispatched before, and its row is gone: it ended in time, so the marker says the rest.
  if (input.dispatch === 'again') return { kind: 'settled', result: await runCommand(runOptions) };

  // Ended processes free their places before the caps are counted. A computer
  // that cannot say runs the command the way it always did.
  try {
    await processes.reconcile(input.ctx.space_id, input.agentId, computer, signal);
  } catch (error) {
    if (error instanceof ProcessHelperUnavailable)
      remember(`${session.adapter}:${session.providerSandboxId}`);
    return { kind: 'not_started' };
  }
  let row: ProcessRow;
  try {
    row = (
      await processes.admit({
        actionId: input.actionId,
        spaceId: input.ctx.space_id,
        agentId: input.agentId,
        connectionId: input.connectionId,
        sessionId: session.id,
        jobId: input.ctx.job_id,
        command: terminalText(input.command, 2000, 'first') || '[hidden]',
        commandDigest: new Bun.CryptoHasher('sha256').update(input.command).digest('hex'),
        cwd: input.cwd,
        name:
          input.command
            .replace(/\p{Cc}/gu, ' ')
            .trim()
            .slice(0, 80) || 'command',
        port: null,
        ttlMinutes: null,
      })
    ).row;
  } catch (error) {
    // A full computer still runs the command, the way it always did.
    if (error instanceof ProcessRefusal) return { kind: 'not_started' };
    throw error;
  }

  // Beside the markers, where every provider takes an upload; read and removed before the command.
  const envFile = Object.keys(input.env).length
    ? `${provider.capabilities.markerRoot}/${input.actionId}.env`
    : null;
  const notStarted = async (reason: string) => {
    await processes.abandon(row.id, reason);
    // Nothing of it ran, so its row goes and the command runs the old way. An
    // env file left unread holds a token that ends when the command settles.
    await processes.forget(row.id);
    return { kind: 'not_started' } as const;
  };
  try {
    if (envFile)
      await provider.putFiles(
        handle,
        (async function* () {
          yield { path: envFile, bytes: envFileBody(input.env), mode: 0o600 };
        })(),
        signal,
      );
  } catch (error) {
    return notStarted(`the command's settings could not be sent: ${(error as Error).message}`);
  }

  const began = Date.now();
  const held = holdFor(input);
  try {
    return await startAndFollow(input, computer, runOptions, row, envFile, began, held, notStarted);
  } finally {
    held.release();
  }
}

/** Whether the person spoke while the command ran, and a way to be woken when they do. */
type Held = { moved: MovedBecause | null; wake: () => void; release: () => void };

function holdFor(input: YieldingRun): Held {
  const held: Held = { moved: null, wake: () => {}, release: () => {} };
  held.release = (input.yields ?? commandYields).hold(input.attemptId, () => {
    held.moved ??= 'person_spoke';
    held.wake();
  });
  return held;
}

async function startAndFollow(
  input: YieldingRun,
  computer: ProcessComputer,
  runOptions: RunOptions,
  admitted: ProcessRow,
  envFile: string | null,
  began: number,
  held: Held,
  notStarted: (reason: string) => Promise<YieldOutcome>,
): Promise<YieldOutcome> {
  const { processes, provider, session, signal } = input;
  let row = admitted;
  let answer: Awaited<ReturnType<ProcessComputer['start']>>;
  try {
    answer = await computer.start(
      {
        id: row.id,
        cwd: input.cwdPath,
        command: launchScript(
          provider.capabilities.markerRoot,
          { marker: input.actionId, argv: runOptions.request.argv, forget: input.forget },
          { keep: keptFor(runOptions), envFile, echo: true },
        ),
        halfBytes: Math.floor(processes.limits.outputMaxBytes / 2),
        // Short, so a command the person speaks during is moved soon after.
        waitMs: Math.max(0, Math.min(START_WAIT_MS, input.yieldAfterMs, input.timeoutMs)),
        firstMaxBytes: PROCESS_LIMITS.first_output_max_bytes,
      },
      signal,
    );
  } catch (error) {
    if (error instanceof ProcessHelperUnavailable || error instanceof ProcessHelperRefusal) {
      if (error instanceof ProcessHelperUnavailable)
        remember(`${session.adapter}:${session.providerSandboxId}`);
      return notStarted(error.message);
    }
    // The start may have reached the computer; its own directory, then the marker, say.
    const found = await computer.status([row.id], signal).catch(() => null);
    const facts = found?.processes.find((each) => each.id === row.id);
    if (!found || !facts)
      return {
        kind: 'settled',
        result: await settleOutcome(runOptions, lost('unknown')),
      };
    row = await processes.apply(row, facts, found.boot);
    return follow(input, computer, runOptions, row, began, held);
  }
  if (answer.outcome === 'reentered') {
    const found = await computer.status([row.id], signal);
    const facts = found.processes.find((each) => each.id === row.id);
    if (facts) row = await processes.apply(row, facts, found.boot);
    return follow(input, computer, runOptions, row, began, held);
  }
  row = await processes.apply(row, answer.process, answer.boot);
  return follow(input, computer, runOptions, row, began, held);
}

const lost = (started: ExecOutcome['started']): ExecOutcome => ({
  started,
  state: 'lost',
  exitCode: null,
  signal: null,
  timedOut: false,
  durationMs: 0,
  output: new Uint8Array(0),
  totalBytes: 0,
  captureLimited: false,
});

/** Wait for the command until it ends, its time is up, or it moves to the background. */
async function follow(
  input: YieldingRun,
  computer: ProcessComputer,
  runOptions: RunOptions,
  start: ProcessRow,
  began: number,
  held: Held,
): Promise<YieldOutcome> {
  const { processes, signal } = input;
  let row = start;
  let moved: MovedBecause | null = null;
  let timedOut = false;
  for (let poll = 0; ; poll += 1) {
    moved = held.moved;
    if (!LIVE_STATES.includes(row.state) || moved) break;
    const ran = Date.now() - began;
    if (ran >= input.timeoutMs) {
      timedOut = true;
      break;
    }
    if (ran >= input.yieldAfterMs) {
      moved = 'still_running';
      break;
    }
    const pause = Math.min(
      POLL_MS[Math.min(poll, POLL_MS.length - 1)] ?? 2_000,
      input.timeoutMs - ran,
      input.yieldAfterMs - ran,
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, pause));
      held.wake = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', held.wake, { once: true });
    });
    signal.removeEventListener('abort', held.wake);
    held.wake = () => {};
    moved = held.moved;
    if (signal.aborted)
      return {
        kind: 'settled',
        result: {
          outcome: 'unknown',
          reason:
            'the wait for the command was cut off while it ran; it goes on in the background, and process.list shows it',
        },
      };
    if (moved) break;
    const status = await computer.status([row.id], signal);
    const facts = status.processes.find((each) => each.id === row.id);
    if (facts) row = await processes.apply(row, facts, status.boot);
  }
  if (timedOut) {
    // Stopped at its timeout, as the provider's exec stops one.
    const stopped = await processes.end(
      row,
      computer,
      'stopped',
      END_REASONS.expired,
      signal,
      2_000,
    );
    const result = await settleOutcome(runOptions, {
      started: 'yes',
      state: 'killed',
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      durationMs: Date.now() - began,
      output: new Uint8Array(0),
      totalBytes: 0,
      captureLimited: false,
    });
    await processes.forget(stopped.id);
    return { kind: 'settled', result };
  }
  if (moved && LIVE_STATES.includes(row.state))
    return { kind: 'moved', row, detail: await movedDetail(input, computer, row, moved, began) };
  return settleEnded(input, computer, runOptions, row, began);
}

/** A command whose process has ended, settled from its marker; its row goes with it. */
async function settleEnded(
  input: YieldingRun,
  computer: ProcessComputer,
  runOptions: RunOptions,
  row: ProcessRow,
  began: number,
): Promise<YieldOutcome> {
  if (row.state !== 'exited' || row.exitCode === null) {
    const result = await settleOutcome(runOptions, lost('yes'));
    return { kind: 'settled', result };
  }
  // The wrapper says why it refused in its own output, which the ring holds.
  const said =
    row.exitCode === REENTERED_EXIT || row.exitCode === 112
      ? await computer
          .read(row.id, -1, 4_096, 0, input.signal)
          .then((read) => read.data)
          .catch(() => new Uint8Array(0))
      : new Uint8Array(0);
  const result = await settleOutcome(runOptions, {
    started: 'yes',
    state: 'exited',
    exitCode: row.exitCode,
    signal: null,
    timedOut: false,
    durationMs: Date.now() - began,
    output: said,
    totalBytes: said.byteLength,
    captureLimited: false,
  });
  // A command that was waited for to its end leaves no process behind to list.
  if (result.outcome !== 'unknown') await input.processes.forget(row.id);
  return { kind: 'settled', result };
}

/** An action dispatched before, with its process: still running, or ended since. */
async function readBack(
  input: YieldingRun,
  computer: ProcessComputer,
  runOptions: RunOptions,
  row: ProcessRow,
): Promise<YieldOutcome> {
  let current = row;
  if (LIVE_STATES.includes(current.state)) {
    const status = await computer.status([current.id], input.signal).catch(() => null);
    const facts = status?.processes.find((each) => each.id === current.id);
    if (status && facts) current = await input.processes.apply(current, facts, status.boot);
  }
  const began = (current.startedAt ?? current.createdAt).getTime();
  if (LIVE_STATES.includes(current.state))
    return {
      kind: 'moved',
      row: current,
      detail: await movedDetail(input, computer, current, 'still_running', began),
    };
  return settleEnded(
    input,
    computer,
    { ...runOptions, request: { ...runOptions.request, dispatch: 'again' } },
    current,
    began,
  );
}

/** What the receipt of a command that moved to the background says. */
async function movedDetail(
  input: YieldingRun,
  computer: ProcessComputer,
  row: ProcessRow,
  why: MovedBecause,
  began: number,
): Promise<Record<string, JsonValue>> {
  const last = await computer
    .read(row.id, -1, PROCESS_LIMITS.wake_tail_bytes, 0, input.signal)
    .catch(() => null);
  const soFar = last ? terminalText(decode(last.data), PROCESS_LIMITS.wake_tail_bytes, 'last') : '';
  const printed = Math.max(row.outputCursor, last?.read.total ?? 0);
  let watch: Record<string, JsonValue>;
  try {
    const made = await createProcessWatch(input.sql, {
      jobId: input.ctx.job_id,
      spaceId: input.ctx.space_id,
      connectionId: input.connectionId,
      processId: row.id,
      kind: 'exit',
      pattern: null,
      fromCursor: 0,
    });
    watch = {
      watch: {
        trigger_id: made.triggerId,
        on: 'exit',
        pattern: null,
        event_name: made.eventName,
        wait_with: `process:${row.id}`,
      },
    };
  } catch (error) {
    if (!(error instanceof ProcessWatchRefusal)) throw error;
    watch = { watch: null, watch_refused: error.message };
  }
  const keepsRunning = input.provider.capabilities.keepAwake;
  const elapsed = Math.max(0, Date.now() - began);
  return {
    language: 'shell',
    command: input.command,
    cwd: input.cwd,
    exit_code: null,
    signal: null,
    timed_out: false,
    stopped_by: null,
    moved_to_background: {
      process_id: row.id,
      elapsed_ms: elapsed,
      output_so_far: soFar,
      output_so_far_bytes: printed,
      why,
    },
    process_id: row.id,
    output: soFar,
    output_binary: false,
    ...watch,
    keeps_running_after_this_turn: keepsRunning,
    next_step: keepsRunning
      ? `The command is still running in the background as ${row.id}${
          why === 'person_spoke' ? ', because the person sent a message' : ''
        }. Do not run it again. Tell the person it is running, then wait for it with process.wait, or end your turn with job.wait, kind event and event_name process:${row.id}: this conversation is woken when it ends, with its exit code and last lines.`
      : `The command is still running as ${row.id}, because the person sent a message. On ${input.session.adapter} computers it stops when this turn ends. Do not run it again. Answer the person, then wait for it in this turn with process.wait.`,
    adapter: input.session.adapter,
    sandbox_id: input.session.providerSandboxId,
    session_id: input.session.id,
    egress: input.session.egressPolicy.kind,
    persistence: input.session.persistence,
    duration_ms: elapsed,
    output_bytes: printed,
    digest_verified: false,
    max_wait_ms: Number.isFinite(input.yieldAfterMs) ? input.yieldAfterMs : input.timeoutMs,
    default_timeout_ms: EXEC_LIMITS.default_timeout_ms,
  };
}
