/**
 * The disk the operator console shows: free space on the fullest of the
 * directories the service writes, against the floor the disk alert uses
 * (`MELETE_ALERT_DISK_MIN_FREE_MB`). The same measure as the health check's,
 * as numbers rather than a sentence, and without the directories' names.
 */
import type { Env } from '../env.ts';
import { statfsFree } from '../health/monitor.ts';
import type { DiskReading } from './console.ts';

const MB = 1024 ** 2;

export function diskReading(
  env: Pick<
    Env,
    | 'MELETE_ALERT_DISK_MIN_FREE_MB'
    | 'MELETE_SPACES_DIR'
    | 'MELETE_ARTIFACTS_DIR'
    | 'MELETE_WORK_DIR'
  >,
  free: (path: string) => number | null = statfsFree,
): DiskReading | null {
  const floor = env.MELETE_ALERT_DISK_MIN_FREE_MB;
  if (!(floor > 0)) return null;
  const paths = [
    ...new Set([env.MELETE_SPACES_DIR, env.MELETE_ARTIFACTS_DIR, env.MELETE_WORK_DIR]),
  ];
  const known = paths
    .map((path) => free(path))
    .filter((bytes): bytes is number => bytes !== null && Number.isFinite(bytes));
  if (!known.length) return { free_mb: null, floor_mb: floor, ok: false };
  const fullest = Math.floor(Math.min(...known) / MB);
  return { free_mb: fullest, floor_mb: floor, ok: fullest >= floor };
}
