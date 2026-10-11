/**
 * What a move out of the workspace means on the agent's computer, where the
 * workspace is also `/work`: why a file the agent names is not here when the
 * last read-back left it on the computer, and removing the computer's copy of
 * a file once it moved into the person's Files, so the next read-back does
 * not bring it back.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { portable } from '../runtime/workspace-fs.ts';
import { notHeldByPerson } from './computer-control.ts';
import type { SandboxHandle, SandboxProvider } from './types.ts';
import { SANDBOX_WORKDIR, type SkippedPath } from './workspace.ts';

/** The command tool whose receipt carries what its read-back left on the computer. */
const COMMAND_KIND = 'terminal.run';

/** What happened to the computer's copy of a moved file. */
export type ComputerCopy = { outcome: 'removed' | 'absent' } | { outcome: 'kept'; reason: string };

const count = (files: number) =>
  files === 1 ? 'a file' : `${files.toLocaleString('en-US')} files`;

/** One skipped path in plain words: "skipped big.tar.xz (8.4 MB, over the 8 MB limit)". */
export function describeSkipped(entry: SkippedPath): string {
  if (!entry.path.endsWith('/')) return `skipped ${entry.path} (${entry.reason})`;
  return entry.files
    ? `skipped ${count(entry.files)} under ${entry.path} (${entry.reason})`
    : `skipped the folders under ${entry.path} (${entry.reason})`;
}

/** The skipped entry that covers `relative`, a file or a folder, if any. */
export function skippedEntryFor(
  skipped: readonly SkippedPath[],
  relative: string,
): SkippedPath | null {
  for (const entry of skipped) {
    if (entry.path === relative) return entry;
    if (
      entry.path.endsWith('/') &&
      (relative.startsWith(entry.path) || `${relative}/` === entry.path)
    )
      return entry;
  }
  return null;
}

const asSkipped = (value: unknown): SkippedPath[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is SkippedPath =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as SkippedPath).path === 'string' &&
          typeof (entry as SkippedPath).reason === 'string',
      )
    : [];

/**
 * Why `relative` is not in the job's workspace when the job's last read-back
 * left it on the computer, in words the agent can act on; null when it did
 * not, or that cannot be told.
 */
export async function leftOnComputer(
  sql: Sql,
  jobId: string,
  relative: string,
): Promise<string | null> {
  const [last] = await sql`select receipt->'detail'->'workspace_skipped' as skipped from action
    where job_id = ${jobId} and kind = ${COMMAND_KIND} and status = 'succeeded'
      and receipt is not null
    order by created_at desc, id desc limit 1`;
  const entry = skippedEntryFor(asSkipped(last?.skipped), relative);
  if (!entry) return null;
  const what = entry.path.endsWith('/')
    ? `it is under ${entry.path}, which the last read-back from your computer left there (${entry.reason})`
    : `the last read-back from your computer left it there (${entry.reason})`;
  return `${JSON.stringify(relative)} is not in your workspace: ${what}. It is still in ${SANDBOX_WORKDIR} on your computer. Make it smaller, or move it out of that folder, or delete what you no longer need there; your next command reads it back, and then it can be moved.`;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Remove `/work/<relative>` from one computer, only when it is still a
 * regular file with exactly the moved bytes, reached through no link: the
 * listing must show each folder on the way as a folder and the file itself
 * as a file of the moved size, and the bytes read back must hash to the
 * moved ones. Anything else is kept and said why.
 */
export async function removeMovedFile(input: {
  provider: SandboxProvider;
  handle: SandboxHandle;
  relative: string;
  size: number;
  hash: string;
  signal: AbortSignal;
}): Promise<ComputerCopy> {
  const segments = portable(input.relative);
  const relative = segments.join('/');
  const listing = await input.provider.listFiles(input.handle, SANDBOX_WORKDIR, input.signal);
  const entries = new Map(listing.map((entry) => [entry.path, entry]));
  for (let depth = 1; depth < segments.length; depth += 1) {
    const folder = entries.get(segments.slice(0, depth).join('/'));
    if (!folder) return { outcome: 'absent' };
    if (folder.symlink) return { outcome: 'kept', reason: 'a folder on its path is a link now' };
    if (!folder.directory) return { outcome: 'absent' };
  }
  const entry = entries.get(relative);
  if (!entry) return { outcome: 'absent' };
  if (entry.symlink) return { outcome: 'kept', reason: 'it is a link now' };
  if (entry.directory) return { outcome: 'kept', reason: 'it is a folder now' };
  const changed = { outcome: 'kept', reason: 'it changed after it was read back' } as const;
  if (entry.size !== input.size) return changed;
  const target = `${SANDBOX_WORKDIR}/${relative}`;
  const bytes = await input.provider.getFile(input.handle, target, input.size + 1, input.signal);
  if (bytes.byteLength !== input.size || digest(bytes) !== input.hash) return changed;
  const removed = await input.provider.exec(
    input.handle,
    {
      marker: recordId('act'),
      argv: ['rm', '--', target],
      cwd: SANDBOX_WORKDIR,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    },
    input.signal,
  );
  if (removed.exitCode !== 0)
    return { outcome: 'kept', reason: `removing it failed (exit ${removed.exitCode ?? 'none'})` };
  return { outcome: 'removed' };
}

/**
 * Remove the computer's copy of a file this attempt moved into the person's
 * Files, on each computer this attempt has running. Null when the job never
 * ran a command on a computer, so there is no copy to speak of.
 */
export async function removeMovedFromComputers(input: {
  sql: Sql;
  providerFor: (connectionId: string) => SandboxProvider | undefined;
  attemptId: string;
  jobId: string;
  relative: string;
  size: number;
  hash: string;
  signal: AbortSignal;
}): Promise<ComputerCopy | null> {
  const { sql } = input;
  const running = await sql`select connection_id, provider_sandbox_id, image_digest, region
    from sandbox_session
    where attempt_id = ${input.attemptId} and status = 'ready' and ${notHeldByPerson(sql)}`;
  if (!running.length) {
    const [ran] = await sql`select 1 from sandbox_command c join action a on a.id = c.action_id
      where a.job_id = ${input.jobId} limit 1`;
    return ran ? { outcome: 'kept', reason: 'your computer is not running in this step' } : null;
  }
  const outcomes: ComputerCopy[] = [];
  for (const row of running) {
    const provider = input.providerFor(String(row.connection_id));
    if (!provider) {
      outcomes.push({ outcome: 'kept', reason: 'your computer could not be reached from here' });
      continue;
    }
    outcomes.push(
      await removeMovedFile({
        provider,
        handle: {
          providerSandboxId: String(row.provider_sandbox_id),
          imageDigest: (row.image_digest as string | null) ?? null,
          region: (row.region as string | null) ?? null,
        },
        relative: input.relative,
        size: input.size,
        hash: input.hash,
        signal: input.signal,
      }).catch(
        (error: unknown): ComputerCopy => ({
          outcome: 'kept',
          reason: `your computer did not answer (${error instanceof Error ? error.message : String(error)})`,
        }),
      ),
    );
  }
  const kept = outcomes.find((each) => each.outcome === 'kept');
  if (kept) return kept;
  return outcomes.some((each) => each.outcome === 'removed')
    ? { outcome: 'removed' }
    : { outcome: 'absent' };
}
