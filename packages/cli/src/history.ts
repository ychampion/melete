/**
 * deploy/.melete/history.jsonl: one line per deploy, rollback or upgrade, in the
 * order they ran. Each line says which images and which checkout the stack ran
 * before and after, how many migrations the database held before and the
 * target expects, where the backup went, and how the run ended. `rollback`
 * reads it to find the previous images; nothing in it is a secret.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STATE_DIR } from './lock.ts';

export const HISTORY_FILE = 'history.jsonl';

const side = z.object({
  /** The image tag the stack ran, or runs. */
  tag: z.string(),
  /** The commit the service image was built from, when its label says. */
  revision: z.string().nullable(),
});

export const historyEntrySchema = z.object({
  at: z.string(),
  command: z.enum(['deploy', 'rollback', 'upgrade']),
  from: side,
  to: side,
  /** The checkout before and after, when the run moved it. */
  checkout: z
    .object({ from: z.string(), branch: z.string().nullable(), to: z.string() })
    .nullable(),
  /** Migrations the database held before the run, and the count the target's journal has. */
  migrations: z.object({ from: z.number().nullable(), to: z.number().nullable() }),
  /** Where the backup taken before the switch is, or null when none was taken. */
  backup: z.string().nullable(),
  result: z.enum(['deployed', 'planned', 'refused', 'failed']),
  detail: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyPath = (deployDir: string) => join(deployDir, STATE_DIR, HISTORY_FILE);

export function appendHistory(deployDir: string, entry: HistoryEntry): void {
  mkdirSync(join(deployDir, STATE_DIR), { recursive: true, mode: 0o700 });
  appendFileSync(historyPath(deployDir), `${JSON.stringify(historyEntrySchema.parse(entry))}\n`, {
    mode: 0o600,
  });
}

/** Every readable entry, oldest first. A line that does not parse is skipped, never fatal. */
export function readHistory(deployDir: string): HistoryEntry[] {
  const path = historyPath(deployDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = historyEntrySchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

/** The run that put the stack where it is now: the newest one that finished. */
export const lastDeployed = (entries: readonly HistoryEntry[]): HistoryEntry | null =>
  [...entries].reverse().find((entry) => entry.result === 'deployed') ?? null;

export function renderHistory(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'No deploys are recorded yet.\n';
  return `${entries
    .map(
      (entry) =>
        `${entry.at}  ${entry.command.padEnd(8)}  ${entry.from.tag} -> ${entry.to.tag}  ${entry.result}${entry.backup ? `  backup ${entry.backup}` : ''}${entry.detail ? `\n    ${entry.detail}` : ''}`,
    )
    .join('\n')}\n`;
}
