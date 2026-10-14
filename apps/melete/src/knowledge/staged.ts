/**
 * Writes staged in a space's `.proposed/` that nothing applied. Each holds the
 * whole record it would write, so one left waiting would keep that text in the
 * space for ever; after STAGED_WRITE_DAYS it is discarded. Removing or
 * forgetting the record a staged write names discards it at once (records.ts,
 * memory/markdown.ts); this sweep bounds the rest.
 */
import { lstatSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expireProposals, STAGED_WRITE_DAYS, spacePaths } from '@melete/knowledge';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Discard every space's staged writes older than `days`. Answers how many went. */
export async function sweepStagedWrites(
  spacesRoot: string,
  now = Date.now(),
  days = STAGED_WRITE_DAYS,
): Promise<number> {
  let spaces: string[];
  try {
    spaces = await readdir(spacesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const before = new Date(now - days * DAY_MS);
  let expired = 0;
  for (const space of spaces) {
    if (!/^sp_[A-Za-z0-9]+$/.test(space)) continue;
    // A space is a folder of its own, never a link to somewhere else.
    if (!lstatSync(join(spacesRoot, space), { throwIfNoEntry: false })?.isDirectory()) continue;
    expired += expireProposals(spacePaths(spacesRoot, space), before);
  }
  return expired;
}

/** Sweep now and every hour, on the instance that leads it; the returned function stops it. */
export function startStagedWriteSweep(
  spacesRoot: string,
  leads: () => boolean | Promise<boolean> = () => true,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () =>
    void Promise.resolve(leads())
      .then((leading) => (leading ? sweepStagedWrites(spacesRoot) : undefined))
      .catch((error: unknown) =>
        say(`staged write sweep failed: ${String((error as Error)?.message ?? error)}`),
      );
  sweep();
  const timer = setInterval(sweep, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
