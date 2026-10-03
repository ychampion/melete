/**
 * One melete command that changes the installation at a time. The lock is the
 * directory deploy/.melete/lock, holding a `holder` file that names the
 * process. It is put in place whole: the holder is written into a fresh
 * directory beside it, which one rename then makes the lock, and a rename onto
 * an existing lock fails. So a lock is never seen without its holder, and two
 * commands can never both create it.
 *
 * A lock left by a process that has ended on this machine is taken over, but
 * only under a second, short-lived directory, deploy/.melete/lock.takeover:
 * whoever creates that re-reads the holder, and removes the lock only while it
 * still names the same ended process. Two commands finding the same stale lock
 * therefore cannot both take it over, and neither can remove a lock that a
 * third has just taken. A lock held by a live process, or written on another
 * machine, is refused with its holder named.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = '.melete';
export const LOCK_DIR = 'lock';
export const TAKEOVER_DIR = 'lock.takeover';

export class LockRefusal extends Error {}

export type LockHolder = { pid: number; host: string; command: string; since: string };

export type LockAccess = {
  pid: number;
  host: string;
  now: () => Date;
  /** Whether a process with this id is running on this machine. */
  alive: (pid: number) => boolean;
  /** Called after a stale holder is read and before the takeover; tests run a rival here. */
  onStale?: (holder: LockHolder) => void;
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

const sameHolder = (a: LockHolder | null, b: LockHolder | null) =>
  a !== null &&
  b !== null &&
  a.pid === b.pid &&
  a.host === b.host &&
  a.since === b.since &&
  a.command === b.command;

const code = (error: unknown) =>
  error instanceof Error && 'code' in error ? String(error.code) : '';

const unique = (access: LockAccess) => `${access.pid}.${Math.random().toString(36).slice(2, 10)}`;

/**
 * Makes `lock` a directory holding `holder`, or returns false when a lock is
 * already there. The holder is written first, in a directory nobody else uses.
 */
function placeLock(state: string, lock: string, holder: LockHolder, access: LockAccess): boolean {
  const fresh = join(state, `lock.new.${unique(access)}`);
  mkdirSync(fresh, { mode: 0o700 });
  try {
    writeFileSync(join(fresh, 'holder'), `${JSON.stringify(holder)}\n`, { mode: 0o600 });
    // A rename refuses a non-empty directory in its place: POSIX with EEXIST or
    // ENOTEMPTY, Windows with EPERM. An empty one, which no holder ever leaves,
    // would be replaced, so it is checked for first.
    if (existsSync(lock)) return false;
    renameSync(fresh, lock);
    return true;
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code(error)) && existsSync(lock))
      return false;
    throw error;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

/** Removes `lock` if, and only if, it still names `stale`. Run only under the takeover directory. */
function removeIfStill(state: string, lock: string, stale: LockHolder, access: LockAccess): void {
  if (!sameHolder(readHolder(join(lock, 'holder')), stale)) return;
  const tombstone = join(state, `lock.stale.${unique(access)}`);
  renameSync(lock, tombstone);
  rmSync(tombstone, { recursive: true, force: true });
}

function refusal(lock: string, holder: LockHolder | null): LockRefusal {
  return new LockRefusal(
    holder
      ? `Another melete command holds ${lock}: ${holder.command || 'a command'} (process ${holder.pid} on ${holder.host}, since ${holder.since}). Wait for it to finish.`
      : `${lock} exists without a holder. If no melete command is running, remove that directory and run this again.`,
  );
}

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
  const mine: LockHolder = {
    pid: access.pid,
    host: access.host,
    command,
    since: access.now().toISOString(),
  };
  const release = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A live holder's lock is never taken over, so a lock naming us is ours.
      if (!sameHolder(readHolder(holderFile), mine)) return;
      const tombstone = join(state, `lock.released.${unique(access)}`);
      renameSync(lock, tombstone);
      rmSync(tombstone, { recursive: true, force: true });
    };
  };

  if (placeLock(state, lock, mine, access)) return release();
  const holder = readHolder(holderFile);
  const stale = holder !== null && holder.host === access.host && !access.alive(holder.pid);
  if (!stale) throw refusal(lock, holder);

  access.onStale?.(holder);
  const takeover = join(state, TAKEOVER_DIR);
  try {
    mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    throw new LockRefusal(
      `Another melete command is taking over a lock left by an ended process (${takeover}). Run this again in a moment; if it persists and no melete command is running, remove that directory.`,
    );
  }
  try {
    removeIfStill(state, lock, holder, access);
    if (placeLock(state, lock, mine, access)) return release();
    throw refusal(lock, readHolder(holderFile));
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }
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
