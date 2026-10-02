/**
 * A try the harness measures itself. The command runs in the space's sandbox
 * through the broker, exactly as a model's own command would; this file holds
 * what happens on either side of that: the command the files and the try
 * become, and the value read back from what the command really printed.
 */
import { EXEC_LIMITS } from '@melete/contracts';
import { shellQuote } from '../sandbox/marker.ts';

/** What the sandbox did with one command, as the broker recorded it. */
export type SandboxRun =
  | {
      status: 'ran';
      action_id: string;
      exit_code: number | null;
      timed_out: boolean;
      duration_ms: number;
      output: string;
      /** The output was longer than what is kept for reading. */
      truncated: boolean;
    }
  /** It did not run, or how it ended is not known: no value can come from it. */
  | { status: 'failed'; action_id: string | null; reason: string }
  /** The person's rules ask them first; nothing ran yet. */
  | { status: 'waiting'; action_id: string; message: string };

/** Runs one command in the space's sandbox, through the broker's ordinary path. */
export type TrySandbox = (command: { command: string; timeout_ms: number }) => Promise<SandboxRun>;

/** The most of a command's output a try's record keeps. */
export const OUTPUT_TAIL = 2000;
/** How long a value pattern may take over one output before it is given up. */
const PATTERN_MS = 250;

/**
 * The command the sandbox runs: the files written first, each exactly as
 * given, then the try's own command. One command, so one approval and one
 * receipt cover both.
 */
export function tryCommand(command: string, files: Record<string, string> = {}): string {
  const writes = Object.entries(files).map(([path, text]) => {
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
    const write = `printf '%s' ${shellQuote(text)} > ${shellQuote(path)}`;
    return folder ? `mkdir -p ${shellQuote(folder)} && ${write}` : write;
  });
  return writes.length ? `${writes.join(' && ')} && (\n${command}\n)` : command;
}

/** The most a composed command may be: what the sandbox terminal accepts. */
export const MAX_COMMAND_CHARS = 20_000;

export const timeoutMs = (seconds: number | undefined, fallback: number) =>
  Math.min((seconds ?? fallback) * 1000, EXEC_LIMITS.max_timeout_ms);

const METRIC_LINE = /^METRIC\s+(.+?)\s*=\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*$/gim;

/**
 * The value a `METRIC <name>=<number>` line reports: the last one for the
 * run's metric when it has one, else the last of any name.
 */
export function metricValue(output: string, metric: string | null): number | null {
  const wanted = metric?.trim().toLowerCase() ?? null;
  let found: number | null = null;
  for (const match of output.matchAll(METRIC_LINE)) {
    if (wanted !== null && (match[1] ?? '').trim().toLowerCase() !== wanted) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) found = value;
  }
  return found;
}

/**
 * The value a pattern's capture group finds, the last match winning. The
 * pattern comes from a model, so it runs in a worker that is stopped if it
 * takes too long: a pattern that backtracks without end cannot hold the service.
 */
export async function patternValue(output: string, pattern: string): Promise<number | null> {
  const worker = new Worker(new URL('./pattern-worker.ts', import.meta.url));
  try {
    const found = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the value pattern took too long')),
        PATTERN_MS,
      );
      worker.onmessage = (event: MessageEvent<string | null>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || 'the value pattern could not be used'));
      };
      worker.postMessage({ output, pattern });
    });
    if (found === null) return null;
    const value = Number(found.trim());
    return found.trim() && Number.isFinite(value) ? value : null;
  } finally {
    worker.terminate();
  }
}

export const tail = (text: string, limit = OUTPUT_TAIL) =>
  text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`;

/** Whether `value` is better than `than` in the metric's direction. */
export const better = (value: number, than: number, direction: 'higher' | 'lower') =>
  direction === 'higher' ? value > than : value < than;
