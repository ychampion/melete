/**
 * One melete command that changes the installation at a time. The lock is a
 * directory, deploy/.melete/lock, because creating a directory either succeeds
 * or fails in one step on every filesystem; inside it, `holder` names the
 * process that holds it. A lock left by a process that has ended on this
 * machine is taken over; one held by a live process, or written on another
 * machine, is refused with its holder named.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = '.melete';
export const LOCK_DIR = 'lock';

export class LockRefusal extends Error {}

export type LockHolder = { pid: number; host: string; command: string; since: string };

export type LockAccess = {
  pid: number;
  host: string;
  now: () => Date;
  /** Whether a process with this id is running on this machine. */
  alive: (pid: number) => boolean;
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

export const thisProcess = (): LockAccess => ({
  pid: process.pid,
  host: hostname(),
  now: () => new Date(),
  alive: processAlive,
});

const readHolder = (path: string): LockHolder | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string'
      ? {
          pid: parsed.pid,
          host: parsed.host,
          command: String(parsed.command ?? ''),
          since: String(parsed.since ?? ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** Takes the lock, or throws a LockRefusal that names who holds it. Returns the release. */
export function acquireLock(
  deployDir: string,
  command: string,
  access: LockAccess = thisProcess(),
): () => void {
  const state = join(deployDir, STATE_DIR);
  const lock = join(state, LOCK_DIR);
  const holderFile = join(lock, 'holder');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const holder = readHolder(holderFile);
      const stale = holder !== null && holder.host === access.host && !access.alive(holder.pid);
      if (stale && attempt === 0) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new LockRefusal(
        holder
          ? `Another melete command holds ${lock}: ${holder.command || 'a command'} (process ${holder.pid} on ${holder.host}, since ${holder.since}). Wait for it to finish.`
          : `${lock} exists without a holder. If no melete command is running, remove that directory and run this again.`,
      );
    }
    const holder: LockHolder = {
      pid: access.pid,
      host: access.host,
      command,
      since: access.now().toISOString(),
    };
    writeFileSync(holderFile, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only our own lock is removed: a lock someone took over is theirs.
      const current = readHolder(holderFile);
      if (current?.pid === access.pid && current.host === access.host)
        rmSync(lock, { recursive: true, force: true });
    };
  }
  throw new LockRefusal(`Could not take ${lock}.`);
}

export async function withLock<T>(
  deployDir: string,
  command: string,
  action: () => Promise<T>,
  access: LockAccess = thisProcess(),
): Promise<T> {
  const release = acquireLock(deployDir, command, access);
  try {
    return await action();
  } finally {
    release();
  }
}
