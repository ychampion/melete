/**
 * One melete command that changes the installation at a time. The lock is a
 * directory, deploy/.melete/lock, because creating a directory either succeeds
 * or fails in one step on every filesystem; inside it, `owner` names the
 * process that holds it. A lock left by a process that has ended on this
 * machine is taken over; one held by a live process, or written on another
 * machine, is refused with its owner named.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = '.melete';
export const LOCK_DIR = 'lock';

export class LockRefusal extends Error {}

export type LockOwner = { pid: number; host: string; command: string; since: string };

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

const readOwner = (path: string): LockOwner | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
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
  const ownerFile = join(lock, 'owner');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const owner = readOwner(ownerFile);
      const stale = owner !== null && owner.host === access.host && !access.alive(owner.pid);
      if (stale && attempt === 0) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      throw new LockRefusal(
        owner
          ? `Another melete command holds ${lock}: ${owner.command || 'a command'} (process ${owner.pid} on ${owner.host}, since ${owner.since}). Wait for it to finish.`
          : `${lock} exists without an owner. If no melete command is running, remove that directory and run this again.`,
      );
    }
    const owner: LockOwner = {
      pid: access.pid,
      host: access.host,
      command,
      since: access.now().toISOString(),
    };
    writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only our own lock is removed: a lock someone took over is theirs.
      const current = readOwner(ownerFile);
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
