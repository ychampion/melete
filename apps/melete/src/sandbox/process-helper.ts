/**
 * The service's side of `melete-proc`, the helper that keeps background
 * processes in the agent's computer (`deploy/sandbox/melete-proc`).
 *
 * Every call is one short command through the provider's ordinary `exec`, so
 * it works on every adapter. The sandbox image carries the helper as
 * `melete-proc`; a computer without it, or with another version of it, is
 * sent the helper's source to run with its own `python3`. A computer with no
 * `python3` at all cannot keep background processes, and the tools say so.
 *
 * The helper keeps each process's files under a root beside the command
 * markers, on the same disk that outlives a stop: `/home/agent/.melete/proc`
 * where the markers are under `/home/agent/.melete/exec`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkMarkerRoot } from './marker.ts';
import type { SandboxCapabilities, SandboxHandle, SandboxProvider } from './types.ts';
import { SANDBOX_WORKDIR } from './workspace.ts';

/** The protocol version this service speaks; a helper that answers another is replaced. */
export const PROCESS_HELPER_VERSION = 1;
const REENTERED_EXIT = 111;
const NOT_FOUND_EXIT = 127;
const NO_PYTHON_EXIT = 126;
/** One answer carries at most a 64 KiB read, base64-encoded, and its facts. */
const ANSWER_BYTES = 256 * 1024;
const CALL_MARGIN_MS = 15_000;

/** Where the helper keeps processes, beside the adapter's command markers. */
export function processRoot(capabilities: Pick<SandboxCapabilities, 'markerRoot'>): string {
  const markers = checkMarkerRoot(capabilities.markerRoot);
  return markers.endsWith('/exec') ? `${markers.slice(0, -5)}/proc` : `${markers}-proc`;
}

/** One process, as the helper found it in the computer. */
export type ProcessFacts = {
  id: string;
  state: 'starting' | 'running' | 'exited' | 'lost';
  exit_code: number | null;
  /** Every byte the process ever wrote; the next byte to read. */
  cursor: number;
  /** The oldest byte the ring still holds. */
  oldest: number;
  last_line: string | null;
  ports: number[];
  /** How many processes of its session are still alive. */
  members: number;
  /** When it started, in epoch milliseconds. */
  started: number | null;
};

export type ReadMeta = { from: number; next: number; dropped: number; total: number };

export type ComputerStatus = { boot: string; processes: ProcessFacts[]; missing: string[] };

export type StartRequest = {
  id: string;
  /** Absolute, inside the computer. */
  cwd: string;
  command: string;
  /** The ring holds two files of this many bytes. */
  halfBytes: number;
  waitMs: number;
  firstMaxBytes: number;
};

export type StartAnswer =
  | { outcome: 'started'; boot: string; process: ProcessFacts; read: ReadMeta; data: Uint8Array }
  /** A process with this id was started before; nothing new ran. */
  | { outcome: 'reentered' };

export type ReadAnswer = { boot: string; process: ProcessFacts; read: ReadMeta; data: Uint8Array };

/** What the service can ask of one computer's processes. */
export interface ProcessComputer {
  start(request: StartRequest, signal: AbortSignal): Promise<StartAnswer>;
  status(ids: readonly string[] | 'all', signal: AbortSignal): Promise<ComputerStatus>;
  read(
    id: string,
    cursor: number,
    maxBytes: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<ReadAnswer>;
  write(id: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ written: number }>;
  signal(
    id: string,
    name: ProcessSignal,
    signal: AbortSignal,
  ): Promise<{ boot: string; process: ProcessFacts }>;
  stop(
    id: string,
    graceMs: number,
    signal: AbortSignal,
  ): Promise<{ boot: string; process: ProcessFacts }>;
}

export const PROCESS_SIGNALS = ['TERM', 'INT', 'HUP', 'KILL'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export type ProcessComputerFor = (
  provider: SandboxProvider,
  handle: SandboxHandle,
) => ProcessComputer;

/** The computer cannot run the helper at all: nothing was started or changed. */
export class ProcessHelperUnavailable extends Error {
  override readonly name = 'ProcessHelperUnavailable';
}

/** The helper ran and refused the request, with its reason. */
export class ProcessHelperRefusal extends Error {
  override readonly name = 'ProcessHelperRefusal';
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** The helper's answer could not be had; whether it acted is not known. */
export class ProcessHelperLost extends Error {
  override readonly name = 'ProcessHelperLost';
}

let source: string | null | undefined;
/** The helper's own source, sent to a computer that does not carry it. */
function helperSource(): string | null {
  if (source === undefined) {
    try {
      source = readFileSync(
        new URL('../../../../deploy/sandbox/melete-proc', import.meta.url),
        'utf8',
      );
    } catch {
      source = null;
    }
  }
  return source;
}

const BAKED = 'command -v melete-proc >/dev/null 2>&1 || exit 127; exec melete-proc "$@"';
const INLINE =
  'command -v python3 >/dev/null 2>&1 || exit 126; s=$1; shift; exec python3 -c "$s" "$@"';

/** Which way each computer runs the helper, learned on first use. */
const modes = new Map<string, 'baked' | 'inline'>();
const remember = (key: string, mode: 'baked' | 'inline') => {
  if (modes.size > 4096) modes.clear();
  modes.set(key, mode);
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The last line of output that is a JSON object, or null. */
function answerOf(output: Uint8Array): Record<string, unknown> | null {
  const lines = decode(output).split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {
      // Not the answer.
    }
  }
  return null;
}

const number = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function factsOf(value: unknown): ProcessFacts {
  const raw = (value ?? {}) as Record<string, unknown>;
  const state = raw.state;
  return {
    id: String(raw.id ?? ''),
    state:
      state === 'starting' || state === 'running' || state === 'exited' || state === 'lost'
        ? state
        : 'lost',
    exit_code: typeof raw.exit_code === 'number' ? raw.exit_code : null,
    cursor: number(raw.cursor),
    oldest: number(raw.oldest),
    last_line: typeof raw.last_line === 'string' ? raw.last_line : null,
    ports: Array.isArray(raw.ports)
      ? raw.ports.filter((port): port is number => Number.isInteger(port))
      : [],
    members: number(raw.members),
    started: typeof raw.started === 'number' ? raw.started : null,
  };
}

function readOf(value: unknown): ReadMeta {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    from: number(raw.from),
    next: number(raw.next),
    dropped: number(raw.dropped),
    total: number(raw.total),
  };
}

const bytesOf = (value: unknown): Uint8Array =>
  typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'base64')) : new Uint8Array(0);

/** The helper, reached through the provider's own exec. */
export function helperComputer(provider: SandboxProvider, handle: SandboxHandle): ProcessComputer {
  const root = processRoot(provider.capabilities);
  const key = `${provider.capabilities.adapter}:${handle.providerSandboxId}`;

  const exec = async (argv: string[], timeoutMs: number, signal: AbortSignal) => {
    let outcome: Awaited<ReturnType<SandboxProvider['exec']>>;
    try {
      outcome = await provider.exec(
        handle,
        {
          // Each call is its own exec: some providers keep a session per marker.
          marker: `prc_${randomBytes(12).toString('base64url')}`,
          argv,
          cwd: SANDBOX_WORKDIR,
          timeoutMs,
          maxOutputBytes: ANSWER_BYTES,
        },
        signal,
      );
    } catch (error) {
      throw new ProcessHelperLost(`the computer did not answer: ${(error as Error).message}`);
    }
    if (outcome.state !== 'exited')
      throw new ProcessHelperLost(
        outcome.timedOut ? 'the computer took too long to answer' : 'the computer lost the call',
      );
    return { code: outcome.exitCode, answer: answerOf(outcome.output) };
  };

  /** Run one helper request and return its answer; a refusal is thrown with its reason. */
  const call = async (
    args: string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ code: number | null; answer: Record<string, unknown> }> => {
    const full = [root, ...args];
    if (modes.get(key) !== 'inline') {
      const baked = await exec(['/bin/sh', '-c', BAKED, 'melete-proc', ...full], timeoutMs, signal);
      if (baked.answer && baked.answer.v === PROCESS_HELPER_VERSION) {
        remember(key, 'baked');
        return { code: baked.code, answer: baked.answer };
      }
      // An answer in another version means the request was understood
      // differently: only a request that changes nothing is safe to send again.
      if (baked.answer && args[0] !== 'status' && args[0] !== 'read')
        throw new ProcessHelperRefusal(
          "the computer's process helper is another version than this service's",
          baked.code,
        );
      if (!baked.answer && baked.code !== NOT_FOUND_EXIT)
        throw new ProcessHelperLost(`the process helper ended with ${baked.code} and no answer`);
    }
    const text = helperSource();
    if (!text)
      throw new ProcessHelperUnavailable(
        'this computer has no process helper, and the service has no copy of it to send',
      );
    const inline = await exec(
      ['/bin/sh', '-c', INLINE, 'melete-proc', text, ...full],
      timeoutMs,
      signal,
    );
    if (inline.code === NO_PYTHON_EXIT && !inline.answer)
      throw new ProcessHelperUnavailable(
        'this computer has no python3, which background processes need',
      );
    if (!inline.answer)
      throw new ProcessHelperLost(`the process helper ended with ${inline.code} and no answer`);
    remember(key, 'inline');
    return { code: inline.code, answer: inline.answer };
  };

  const ok = (result: { code: number | null; answer: Record<string, unknown> }) => {
    if (result.answer.ok !== true)
      throw new ProcessHelperRefusal(
        typeof result.answer.error === 'string' ? result.answer.error : 'the helper refused',
        result.code,
      );
    return result.answer;
  };

  return {
    async start(request, signal) {
      const result = await call(
        [
          'start',
          request.id,
          request.cwd,
          String(request.halfBytes),
          String(request.waitMs),
          String(request.firstMaxBytes),
          request.command,
        ],
        request.waitMs + CALL_MARGIN_MS,
        signal,
      );
      if (result.code === REENTERED_EXIT && result.answer.ok === false)
        return { outcome: 'reentered' };
      const answer = ok(result);
      return {
        outcome: 'started',
        boot: String(answer.boot ?? ''),
        process: factsOf(answer.process),
        read: readOf(answer.read),
        data: bytesOf(answer.data),
      };
    },

    async status(ids, signal) {
      const answer = ok(
        await call(['status', ...(ids === 'all' ? ['--all'] : ids)], CALL_MARGIN_MS * 2, signal),
      );
      return {
        boot: String(answer.boot ?? ''),
        processes: Array.isArray(answer.processes) ? answer.processes.map(factsOf) : [],
        missing: Array.isArray(answer.missing) ? answer.missing.map(String) : [],
      };
    },

    async read(id, cursor, maxBytes, waitMs, signal) {
      const answer = ok(
        await call(
          ['read', id, String(cursor), String(maxBytes), String(waitMs)],
          waitMs + CALL_MARGIN_MS,
          signal,
        ),
      );
      return {
        boot: String(answer.boot ?? ''),
        process: factsOf(answer.process),
        read: readOf(answer.read),
        data: bytesOf(answer.data),
      };
    },

    async write(id, bytes, signal) {
      const answer = ok(
        await call(['write', id, Buffer.from(bytes).toString('base64')], CALL_MARGIN_MS, signal),
      );
      return { written: number(answer.written) };
    },

    async signal(id, name, signal) {
      const answer = ok(await call(['signal', id, name], CALL_MARGIN_MS, signal));
      return { boot: String(answer.boot ?? ''), process: factsOf(answer.process) };
    },

    async stop(id, graceMs, signal) {
      const answer = ok(
        await call(['stop', id, String(graceMs)], graceMs + CALL_MARGIN_MS, signal),
      );
      return { boot: String(answer.boot ?? ''), process: factsOf(answer.process) };
    },
  };
}
