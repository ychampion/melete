/**
 * How old the newest backup is. `melete backup` notes the time and place of
 * every backup it finishes in deploy/.melete/last-backup.json, so a backup
 * streamed to another machine counts too; a finished backup directory in the
 * backup folder counts by the time in its name. Only the newest time is read, so
 * however old backups are pruned, the answer is the same.
 *
 * `check` and `status` judge it on a hosted installation, or on one whose
 * deploy file says backups run on a schedule (`"backup": { "scheduled": true }`):
 * the newest backup must be at most 26 hours old, a day with room for a late run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_BACKUP_AGE_HOURS } from '../../../apps/melete/src/operator/backup-note.ts';
import type { DeployConfig } from './deploy-config.ts';
import { STATE_DIR } from './lock.ts';
import type { Result } from './schema.ts';

export const LAST_BACKUP_FILE = 'last-backup.json';
/** At most a day apart, with room for a late run; the operator console judges by the same. */
export { MAX_BACKUP_AGE_HOURS };

const HOUR = 60 * 60 * 1000;
const record = z.object({ at: z.string(), location: z.string() });

export const lastBackupPath = (deployDir: string) => join(deployDir, STATE_DIR, LAST_BACKUP_FILE);

/** Notes a finished backup; it holds a time and a place, nothing secret. */
export function recordBackup(deployDir: string, at: Date, location: string): void {
  mkdirSync(join(deployDir, STATE_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(
    lastBackupPath(deployDir),
    `${JSON.stringify({ at: at.toISOString(), location })}\n`,
    { mode: 0o600 },
  );
}

/** `melete-20261002T101500Z` as the time it names; null for any other name. */
export function backupNameTime(name: string): Date | null {
  const match = /^melete-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const time = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}

const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

function recorded(deployDir: string): { at: Date; location: string } | null {
  try {
    const parsed = record.parse(JSON.parse(readFileSync(lastBackupPath(deployDir), 'utf8')));
    const at = new Date(parsed.at);
    return Number.isNaN(at.getTime()) ? null : { at, location: parsed.location };
  } catch {
    return null;
  }
}

/**
 * The newest finished backup in the folder. A backup writes its SHA256SUMS
 * once every part is in, so a directory without one is a run that was stopped
 * part way, by a reboot or the memory killer, and does not count.
 */
function newestInFolder(dir: string): { at: Date; location: string } | null {
  if (!existsSync(dir)) return null;
  let newest: { at: Date; location: string } | null = null;
  for (const entry of readdirSync(dir)) {
    const at = backupNameTime(entry);
    if (!at || (newest && at <= newest.at)) continue;
    try {
      if (statSync(join(dir, entry)).isDirectory() && existsSync(join(dir, entry, 'SHA256SUMS')))
        newest = { at, location: join(dir, entry) };
    } catch {
      // Removed while it was read: not a backup any more.
    }
  }
  return newest;
}

/** The newest backup this installation knows of, from its note and its backup folder. */
export function newestBackup(
  deployDir: string,
  config: DeployConfig,
  home = homedir(),
): { at: Date; location: string } | null {
  const candidates = [recorded(deployDir), newestInFolder(expandHome(config.backup.dir, home))];
  return candidates.reduce<{ at: Date; location: string } | null>(
    (best, next) => (next && (!best || next.at > best.at) ? next : best),
    null,
  );
}

const hoursAgo = (hours: number) =>
  hours < 1 ? 'under an hour ago' : `${Math.floor(hours)} hour${hours < 2 ? '' : 's'} ago`;

const FIX =
  'Run bun run melete backup now, then check the schedule that runs it (docs/DEPLOYMENT.md, "Backups on a schedule").';

/**
 * Whether the newest backup is recent enough. Judged only on a hosted
 * installation or one with a backup schedule; otherwise nothing is said.
 */
export function judgeBackupAge(
  deployDir: string,
  config: DeployConfig,
  now: Date,
  home = homedir(),
): Result[] {
  if (config.hosted !== true && config.backup.scheduled !== true) return [];
  const newest = newestBackup(deployDir, config, home);
  if (!newest)
    return [
      {
        id: 'backup.age',
        level: 'fail',
        detail: `No backup has been taken yet; one is expected every day, at most ${MAX_BACKUP_AGE_HOURS} hours apart.`,
        fix: FIX,
      },
    ];
  const hours = (now.getTime() - newest.at.getTime()) / HOUR;
  return [
    hours <= MAX_BACKUP_AGE_HOURS
      ? {
          id: 'backup.age',
          level: 'ok',
          detail: `The newest backup was taken ${hoursAgo(Math.max(0, hours))}: ${newest.location}`,
        }
      : {
          id: 'backup.age',
          level: 'fail',
          detail: `The newest backup was taken ${hoursAgo(hours)}, more than ${MAX_BACKUP_AGE_HOURS} hours ago: ${newest.location}`,
          fix: FIX,
        },
  ];
}
