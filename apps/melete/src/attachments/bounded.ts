/**
 * Reading a file's words away from the service: in a child process with a
 * deadline and a memory ceiling, a few at a time.
 *
 * The parsers in `extract.ts` bound what they build, but a file is untrusted
 * input reaching the service through uploads and through the agent's own
 * reads, so the reading runs where a mistake costs only that read. The child
 * gets the bytes on stdin and answers with JSON on stdout. It is killed when
 * it passes the deadline or, where the system says how much memory a process
 * holds, the ceiling; either way the read is refused with a plain sentence.
 */
import { readFile } from 'node:fs/promises';
import type { AttachmentKind } from '@melete/contracts';
import { type Extracted, TOO_COMPLEX, UnreadableFile } from './extract.ts';

/** Reads running at once; the rest wait their turn. */
export const READ_CONCURRENCY = 2;
/** Reads waiting at most; past this, a read is turned away as busy. */
const MAX_WAITING = 32;
export const READ_DEADLINE_MS = 15_000;
export const READ_MEMORY_BYTES = 512 * 1024 * 1024;

/** Too many reads are already waiting. */
export class ReadersBusy extends Error {
  readonly code = 'attachment_busy';
  constructor() {
    super('Melete is reading other files right now. Try again in a moment.');
  }
}

let running = 0;
const waiting: (() => void)[] = [];

async function turn(): Promise<() => void> {
  if (running >= READ_CONCURRENCY) {
    if (waiting.length >= MAX_WAITING) throw new ReadersBusy();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

const WORKER = new URL('./worker.ts', import.meta.url);

/** The resident memory of a process, where the system reports it; null elsewhere. */
async function residentBytes(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = /VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1];
    return kb ? Number(kb) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * The text of a file, read in a child process. Throws UnreadableFile with a
 * plain reason (including "it is too complex to read" for a read that ran out
 * of time or memory), or ReadersBusy when too many reads are queued.
 */
export async function extractBounded(
  kind: AttachmentKind,
  bytes: Uint8Array,
  limits: { deadlineMs?: number; memoryBytes?: number } = {},
): Promise<Extracted> {
  if (kind === 'image') return { text: null, pages: null };
  const release = await turn();
  try {
    // No `.env` is read: the child gets this explicit environment and nothing
    // else, and runs from the worker's own folder rather than the service's.
    const child = Bun.spawn([process.execPath, '--no-env-file', Bun.fileURLToPath(WORKER), kind], {
      cwd: Bun.fileURLToPath(new URL('.', WORKER)),
      stdin: bytes,
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV ?? 'production' },
    });
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(stop, limits.deadlineMs ?? READ_DEADLINE_MS);
    const ceiling = limits.memoryBytes ?? READ_MEMORY_BYTES;
    const watch = setInterval(() => {
      void residentBytes(child.pid).then((held) => {
        if (held !== null && held > ceiling) stop();
      });
    }, 100);
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (stopped) throw new UnreadableFile(TOO_COMPLEX);
      let answer:
        | { ok: true; text: string | null; pages: number | null }
        | { ok: false; reason: string };
      try {
        answer = JSON.parse(output);
      } catch {
        // A child that died (out of memory, a crash) leaves no answer.
        throw new UnreadableFile(code === 0 ? 'the file could not be read' : TOO_COMPLEX);
      }
      if (!answer.ok) throw new UnreadableFile(answer.reason);
      return { text: answer.text, pages: answer.pages };
    } finally {
      clearTimeout(deadline);
      clearInterval(watch);
    }
  } finally {
    release();
  }
}
