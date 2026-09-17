/**
 * Running one admitted command in a remote sandbox exactly once.
 *
 * The service, not the adapter, wraps every command. The wrapper creates a
 * directory named after the action before the command starts, sends the
 * command's combined output to a file inside it, and writes the exit status
 * there when the command ends. Creating a directory either succeeds or finds
 * one already there, so a second dispatch of the same action cannot start the
 * command again even if two dispatches race inside the sandbox.
 *
 * When the answer to a dispatch never arrives, the directory is how the service
 * learns what happened:
 *
 * | Sandbox state             | Meaning                 | Outcome                        |
 * |---------------------------|-------------------------|--------------------------------|
 * | no marker directory       | never started           | failed, retryable              |
 * | marker, no exit record    | started, result unknown | unknown, never run again       |
 * | exit record present       | finished                | succeeded, late                |
 *
 * The marker lives inside a sandbox the command itself can write to, so it is
 * evidence about the command, not a guard against it. The guard against a
 * second run is the one row per action the service records before dispatch.
 */
import { createHash } from 'node:crypto';
import { EXEC_LIMITS } from '@melete/contracts';
import {
  type ExecOutcome,
  type FileEntry,
  SandboxAdapterRefusal,
  SandboxFileNotFound,
  type SandboxHandle,
  type SandboxProvider,
} from './types.ts';
import { readWorkspaceFile, SANDBOX_WORKDIR, writeWorkspaceFile } from './workspace.ts';

export const MARKER_ROOT = '/var/tmp/.melete-exec';
export const REENTERED_EXIT = 111;
export const REENTERED_MESSAGE = 'melete_exec_reentered';
/** The marker root could not be created, so the command was not started. */
export const MARKER_SETUP_EXIT = 112;

const MARKER = /^[A-Za-z0-9_-]{1,64}$/;
const EMPTY = new Uint8Array(0);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function checkMarker(marker: string): string {
  if (!MARKER.test(marker)) throw new Error('a marker must be an action id');
  return marker;
}

export const markerDirectory = (marker: string): string => `${MARKER_ROOT}/${checkMarker(marker)}`;

/** POSIX single quoting: the only character that needs care is the quote itself. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('an argument cannot contain a NUL byte');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The wrapped argv the adapter runs. `argv` is the admitted command, quoted
 * word by word; nothing in it is interpreted by the wrapper's own shell.
 */
export function markCommand(marker: string, argv: readonly string[]): string[] {
  const directory = markerDirectory(marker);
  if (argv.length === 0) throw new Error('an admitted command needs at least one word');
  const command = argv.map(shellQuote).join(' ');
  const script = [
    `d=${directory}`,
    `mkdir -p ${MARKER_ROOT} || exit ${MARKER_SETUP_EXIT}`,
    `mkdir "$d" 2>/dev/null || { echo ${REENTERED_MESSAGE} >&2; exit ${REENTERED_EXIT}; }`,
    `( ${command} ) > "$d/out" 2>&1`,
    'ec=$?',
    // Written aside and renamed, so a reader never sees a half-written status.
    `printf '%s' "$ec" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"`,
    'exit "$ec"',
  ].join('\n');
  return ['/bin/sh', '-c', script];
}

const regular = (entries: FileEntry[], name: string) =>
  entries.find((entry) => entry.path === name && !entry.directory && !entry.symlink);

/**
 * Reattach by reading the marker directory. Adapters with no native way to
 * reconnect to a process use this as their `reattach`.
 */
export async function reattachByMarker(
  provider: Pick<SandboxProvider, 'listFiles' | 'getFile'>,
  handle: SandboxHandle,
  marker: string,
  signal: AbortSignal,
): Promise<ExecOutcome | null> {
  const directory = markerDirectory(marker);
  let entries: FileEntry[];
  try {
    entries = await provider.listFiles(handle, directory, signal);
  } catch (error) {
    if (error instanceof SandboxFileNotFound) return null;
    throw error;
  }
  const base = {
    signal: null,
    timedOut: false,
    durationMs: 0,
    output: EMPTY,
    totalBytes: 0,
    captureLimited: false,
  };
  if (!regular(entries, 'exit')) return { ...base, state: 'lost', exitCode: null };
  const status = text(await provider.getFile(handle, `${directory}/exit`, 16, signal));
  if (!/^\d{1,3}$/.test(status)) return { ...base, state: 'lost', exitCode: null };
  return { ...base, state: 'exited', exitCode: Number(status) };
}

export type CommandRequest = {
  marker: string;
  /** The admitted command, unwrapped. */
  argv: readonly string[];
  cwd?: string;
  timeoutMs: number;
  stdin?: Uint8Array;
  /** `again` when this action was dispatched before: it is reattached, never run. */
  dispatch: 'first' | 'again';
};

export type ExecutionRecord = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Null when the command was not watched while it ran. */
  durationMs: number | null;
  /** sha256 of the captured output, before truncation. */
  outputDigest: string;
  outputBytes: number;
  totalBytes: number;
  captureLimited: boolean;
  truncated: boolean;
  preview: Uint8Array;
  /** Relative to the job workspace; set when the output did not fit the preview. */
  outputPath: string | null;
};

export type CommandResult =
  | { outcome: 'succeeded'; late: boolean; reattached: boolean; record: ExecutionRecord }
  | { outcome: 'failed'; retryable: boolean; reason: string }
  | { outcome: 'unknown'; reason: string };

export type RunOptions = {
  provider: SandboxProvider;
  handle: SandboxHandle;
  request: CommandRequest;
  workRoot: string;
  jobId: string;
  signal: AbortSignal;
  limits?: { maxOutputBytes?: number; maxCaptureBytes?: number; probeTimeoutMs?: number };
};

const settings = (options: RunOptions) => ({
  maxOutputBytes: options.limits?.maxOutputBytes ?? EXEC_LIMITS.max_output_bytes,
  maxCaptureBytes: options.limits?.maxCaptureBytes ?? EXEC_LIMITS.max_capture_bytes,
  probeTimeoutMs: options.limits?.probeTimeoutMs ?? 30_000,
});

/** The service reads, hashes and, above the preview cap, stores the output itself. */
async function capture(
  options: RunOptions,
  entries: FileEntry[],
  facts: Pick<ExecutionRecord, 'exitCode' | 'signal' | 'timedOut' | 'durationMs'>,
  signal: AbortSignal,
): Promise<ExecutionRecord> {
  const { maxOutputBytes, maxCaptureBytes } = settings(options);
  const directory = markerDirectory(options.request.marker);
  const out = regular(entries, 'out');
  const listed = out?.size ?? 0;
  const captured =
    listed > 0
      ? await options.provider.getFile(options.handle, `${directory}/out`, maxCaptureBytes, signal)
      : EMPTY;
  const outputDigest = digest(captured);
  const truncated = captured.byteLength > maxOutputBytes;
  let outputPath: string | null = null;
  if (truncated) {
    outputPath = `${EXEC_LIMITS.output_dir}/${options.request.marker}.out`;
    await writeWorkspaceFile(options.workRoot, options.jobId, outputPath, captured, 0o644);
    const stored = await readWorkspaceFile(
      options.workRoot,
      options.jobId,
      outputPath,
      maxCaptureBytes,
    );
    if (digest(stored) !== outputDigest)
      throw new Error('the stored output does not hash to the recorded digest');
  }
  const totalBytes = Math.max(listed, captured.byteLength);
  return {
    ...facts,
    outputDigest,
    outputBytes: captured.byteLength,
    totalBytes,
    captureLimited: totalBytes > captured.byteLength,
    truncated,
    preview: captured.slice(0, maxOutputBytes),
    outputPath,
  };
}

async function fromMarker(options: RunOptions, cause: string): Promise<CommandResult> {
  const signal = AbortSignal.timeout(settings(options).probeTimeoutMs);
  const { provider, handle, request } = options;
  let state: ExecOutcome | null;
  try {
    state = await provider.reattach(handle, request.marker, signal);
  } catch (error) {
    return {
      outcome: 'unknown',
      reason: `${cause}; the marker could not be read: ${(error as Error).message}`,
    };
  }
  if (state === null)
    return { outcome: 'failed', retryable: true, reason: `${cause}; the command never started` };
  if (state.state !== 'exited' || state.exitCode === null)
    return {
      outcome: 'unknown',
      reason: `${cause}; the command started and has no exit record, so it is not run again`,
    };
  try {
    const entries = await provider.listFiles(handle, markerDirectory(request.marker), signal);
    const record = await capture(
      options,
      entries,
      { exitCode: state.exitCode, signal: null, timedOut: false, durationMs: null },
      signal,
    );
    return { outcome: 'succeeded', late: true, reattached: true, record };
  } catch (error) {
    return {
      outcome: 'unknown',
      reason: `${cause}; the command finished but its output could not be read: ${(error as Error).message}`,
    };
  }
}

const reentered = (outcome: ExecOutcome): boolean =>
  outcome.state === 'exited' &&
  outcome.exitCode === REENTERED_EXIT &&
  text(outcome.output).includes(REENTERED_MESSAGE);

export async function runCommand(options: RunOptions): Promise<CommandResult> {
  const { provider, handle, request } = options;
  checkMarker(request.marker);
  if (request.dispatch === 'again') return fromMarker(options, 'this action was dispatched before');
  let outcome: ExecOutcome;
  try {
    outcome = await provider.exec(
      handle,
      {
        marker: request.marker,
        argv: markCommand(request.marker, request.argv),
        cwd: request.cwd ?? SANDBOX_WORKDIR,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: 4096,
        ...(request.stdin ? { stdin: request.stdin } : {}),
      },
      options.signal,
    );
  } catch (error) {
    // An adapter that refused sent nothing; anything else may have run.
    if (error instanceof SandboxAdapterRefusal)
      return { outcome: 'failed', retryable: false, reason: error.message };
    return fromMarker(options, `the acknowledgement was lost (${(error as Error).message})`);
  }
  if (outcome.state === 'lost') return fromMarker(options, 'the sandbox lost track of the command');
  if (reentered(outcome)) return fromMarker(options, 'the marker for this action already existed');
  const signal = AbortSignal.timeout(settings(options).probeTimeoutMs);
  let entries: FileEntry[];
  try {
    entries = await provider.listFiles(handle, markerDirectory(request.marker), signal);
  } catch (error) {
    if (error instanceof SandboxFileNotFound) {
      // The wrapper ended without creating its marker: the command never ran.
      const said = text(outcome.output).trim().slice(0, 200);
      return {
        outcome: 'failed',
        retryable: true,
        reason: `the command did not start (exit ${outcome.exitCode ?? outcome.signal})${said ? `: ${said}` : ''}`,
      };
    }
    return {
      outcome: 'unknown',
      reason: `the command ran but its marker could not be read: ${(error as Error).message}`,
    };
  }
  const record = await capture(
    options,
    entries,
    {
      exitCode: outcome.state === 'exited' ? outcome.exitCode : null,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
    },
    signal,
  );
  return { outcome: 'succeeded', late: false, reattached: false, record };
}
