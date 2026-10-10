/**
 * Which chat made which file in a persistent computer's `/work`, and taking a
 * deleted chat's files out of it.
 *
 * `/work` is one folder for every chat of an agent in a space: what one chat
 * leaves there, the next can see. So each time a command's changes are read
 * back, every file in it is recorded against the computer with its content
 * hash, and a file that is new or changed since the last read-back is put
 * down to the chat that ran the command, but only when nothing else could have
 * changed it meanwhile: no other chat's command, computer action or
 * background process, and no takeover by the person. A file new to `/work`
 * that the chat's own copy brought in (one it wrote with its file tools) is
 * the chat's too, unless the person gave it. Anything else is marked shared:
 * a file someone else also wrote, one that was there before records were
 * kept, one a chat's copy put back over what was there, or one whose writer
 * cannot be shown. When the answer is in doubt, the file is shared, and shared files
 * are never removed.
 *
 * Deleting a chat queues the files it alone made, with the content they had.
 * A running computer is cleaned by the sweep, a stopped one when it next
 * starts; nothing starts a computer to clean it. A queued file is removed
 * only if it is still a regular file inside `/work`, reached through no link,
 * with the recorded content; anything else stays and is marked shared. The
 * same files are taken out of the copies other chats keep of `/work` on this
 * machine, into those chats' trash, so the next command does not put them
 * back. The chat's own copy goes to its trash with the chat
 * (experience/workspace-trash.ts).
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { recordId } from '../broker/records.ts';
import { moveToTrash } from '../connectors/files-trash.ts';
import { LocalWorkspaceFs, portable } from '../runtime/workspace-fs.ts';
import { SandboxFileNotFound, type SandboxHandle, type SandboxProvider } from './types.ts';
import { SANDBOX_WORKDIR, type SentFile, SYNC_LIMITS } from './workspace.ts';

type Query = Sql | TransactionSql;

/** A persistent computer: one agent's, on one connection, in one space. */
export type WorkComputer = {
  spaceId: string;
  agentId: string;
  connectionId: string;
  /** The sandbox it is now, whose takeovers count as the person at work. */
  providerSandboxId: string;
};

/** The computer a session is, or null when its `/work` ends with it. */
export function workComputerOf(session: {
  spaceId: string;
  agentId: string | null;
  connectionId: string;
  providerSandboxId: string;
  persistence: string;
}): WorkComputer | null {
  if (!session.agentId || session.persistence === 'ephemeral') return null;
  return {
    spaceId: session.spaceId,
    agentId: session.agentId,
    connectionId: session.connectionId,
    providerSandboxId: session.providerSandboxId,
  };
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One writer at a time per computer, across service instances. */
async function lockComputer(tx: TransactionSql, computer: WorkComputer) {
  const key = `work:${computer.spaceId}:${computer.agentId}:${computer.connectionId}`;
  await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
}

/** The regular files in `/work`, by portable path, with their sizes; links and folders apart. */
async function listWork(
  provider: SandboxProvider,
  handle: SandboxHandle,
  signal: AbortSignal,
): Promise<{ files: Map<string, number>; other: Set<string> }> {
  const files = new Map<string, number>();
  const other = new Set<string>();
  let listing: Awaited<ReturnType<SandboxProvider['listFiles']>>;
  try {
    listing = await provider.listFiles(handle, SANDBOX_WORKDIR, signal);
  } catch (error) {
    if (error instanceof SandboxFileNotFound) return { files, other };
    throw error;
  }
  for (const entry of listing) {
    let relative: string;
    try {
      relative = portable(entry.path).join('/');
    } catch {
      continue;
    }
    if (!relative) continue;
    if (entry.symlink || entry.directory) other.add(relative);
    else files.set(relative, entry.size);
  }
  return { files, other };
}

/**
 * Start a computer's records, once: everything already in `/work` is shared,
 * since nothing says who made it. Called before a command's own files are
 * sent, so what the command then makes can be told apart.
 */
export async function startWorkRecords(
  sql: Sql,
  provider: SandboxProvider,
  handle: SandboxHandle,
  computer: WorkComputer,
  signal: AbortSignal,
): Promise<void> {
  const [known] = await sql`select 1 from sandbox_work_read
    where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
      and connection_id = ${computer.connectionId}`;
  if (known) return;
  const { files } = await listWork(provider, handle, signal);
  await sql.begin(async (tx) => {
    await lockComputer(tx, computer);
    const rows = [...files.keys()].map((path) => ({
      space_id: computer.spaceId,
      agent_id: computer.agentId,
      connection_id: computer.connectionId,
      path,
      shared: true,
    }));
    for (let at = 0; at < rows.length; at += 500)
      await tx`insert into sandbox_work_file ${tx(rows.slice(at, at + 500), 'space_id', 'agent_id', 'connection_id', 'path', 'shared')}
        on conflict do nothing`;
    await tx`insert into sandbox_work_read (space_id, agent_id, connection_id)
      values (${computer.spaceId}, ${computer.agentId}, ${computer.connectionId})
      on conflict do nothing`;
  });
}

/**
 * Whether anything but this chat could have changed `/work` since `since`:
 * another chat's command or computer action on this connection begun since
 * or still under way, a background process another chat started that ran
 * since, or the person taking the computer, or one of its displays, over.
 * When it cannot be asked, the answer is yes. `since` only moves on at a
 * read-back that found nobody else at work, so an action under way then is
 * still counted at the next.
 */
export async function othersAtWork(
  tx: Query,
  computer: WorkComputer,
  jobId: string,
  since: Date,
): Promise<boolean> {
  try {
    const [row] = await tx`select
      exists (select 1 from sandbox_process
        where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
          and connection_id = ${computer.connectionId}
          and job_id is distinct from ${jobId}
          and (state in ('starting', 'running') or ended_at is null or ended_at > ${since}))
      or exists (select 1 from action a join job j on j.id = a.job_id
        where a.connection_id = ${computer.connectionId} and j.space_id = ${computer.spaceId}
          and j.agent_id = ${computer.agentId} and a.job_id <> ${jobId}
          and (a.dispatched_at > ${since}
            or (a.resolved_at is null and a.dispatched_at > now() - interval '1 day')))
      or exists (select 1 from sandbox_control
        where (provider_sandbox_id = ${computer.providerSandboxId}
            or left(provider_sandbox_id, ${computer.providerSandboxId.length + 1}) = ${`${computer.providerSandboxId}#`})
          and changed_at > ${since}) as busy`;
    return row?.busy !== false;
  } catch {
    return true;
  }
}

type FileRow = { path: string; hash: string | null; writers: string[]; shared: boolean };

/**
 * Record `/work` as one command's read-back found it: `files` is every
 * regular file there with its content hash, and `sent` what this chat's own
 * copy put there before the command ran. `chatMade` says whether a file of
 * that copy is the chat's own rather than one the person gave it; null when
 * that is not known.
 */
export async function recordWorkFiles(
  sql: Sql,
  computer: WorkComputer,
  jobId: string,
  files: ReadonlyMap<string, string>,
  sent: ReadonlyMap<string, SentFile> | null,
  chatMade: ((path: string) => boolean) | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    await lockComputer(tx, computer);
    const [read] = await tx`select read_at from sandbox_work_read
      where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
        and connection_id = ${computer.connectionId}`;
    // With no starting point, what changed cannot be told from what was there.
    const others = read ? await othersAtWork(tx, computer, jobId, read.read_at as Date) : true;
    const rows = await tx<FileRow[]>`select path, hash, writers, shared from sandbox_work_file
      where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
        and connection_id = ${computer.connectionId}`;
    const known = new Map(rows.map((row) => [row.path, row]));
    // A deleted chat's file still waiting to be removed is not anyone's new file.
    const queued = new Map(
      (
        await tx`select path, hash from sandbox_work_removal
          where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
            and connection_id = ${computer.connectionId}`
      ).map((row) => [String(row.path), String(row.hash)]),
    );
    for (const [path, hash] of files) {
      const row = known.get(path);
      if (row && row.hash === hash) continue;
      if (!row && queued.get(path) === hash) continue;
      const restored = sent?.get(path)?.hash === hash;
      let writers = row?.writers ?? [];
      let shared: boolean;
      if (restored) {
        // This chat's own copy brought it. New to /work, and not a file the
        // person gave the chat, it is the chat's: written with its file tools.
        // Over a file already there, who made that content cannot be shown.
        if (!row && chatMade?.(path)) writers = [jobId];
        shared = !(!row && chatMade?.(path));
      } else if (others) shared = true;
      else {
        if (!writers.includes(jobId)) writers = [...writers, jobId];
        shared =
          (row?.shared ?? false) || (row !== undefined && row.hash === null) || writers.length > 1;
      }
      await tx`insert into sandbox_work_file
          (space_id, agent_id, connection_id, path, hash, writers, shared, updated_at)
        values (${computer.spaceId}, ${computer.agentId}, ${computer.connectionId}, ${path},
          ${hash}, ${writers}::text[], ${shared}, now())
        on conflict (space_id, agent_id, connection_id, path) do update
          set hash = excluded.hash, writers = excluded.writers, shared = excluded.shared,
            updated_at = now()`;
    }
    // A file no longer there has no maker to remember.
    await tx`delete from sandbox_work_file
      where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
        and connection_id = ${computer.connectionId} and path <> all(${[...files.keys()]}::text[])`;
    // The next read-back counts from here only when nobody else was at work.
    if (!read || !others)
      await tx`insert into sandbox_work_read (space_id, agent_id, connection_id, read_at)
        values (${computer.spaceId}, ${computer.agentId}, ${computer.connectionId}, now())
        on conflict (space_id, agent_id, connection_id) do update set read_at = now()`;
  });
}

/** What deleting chats does to the files they made on their computers. */
export type WorkFilesOutcome = {
  /** Files only these chats made, removed from the computer now or when it next starts. */
  removed: number;
  /** Files these chats changed that someone else also wrote, or whose maker is not known; they stay. */
  kept: number;
  /** What was queued, for taking the same files out of other chats' copies. */
  queued: QueuedRemoval[];
};

export type QueuedRemoval = {
  spaceId: string;
  agentId: string;
  connectionId: string;
  jobId: string;
  path: string;
  hash: string;
};

/**
 * Queue the files only these chats made for removal from their computers,
 * in the transaction that deletes them. Files they shared with anyone stay,
 * and are counted.
 */
export async function queueWorkRemovals(
  tx: TransactionSql,
  jobIds: readonly string[],
): Promise<WorkFilesOutcome> {
  const list = [...jobIds];
  const own = await tx`delete from sandbox_work_file
    where not shared and hash is not null and cardinality(writers) = 1 and writers[1] = any(${list})
    returning space_id, agent_id, connection_id, path, hash, writers[1] as job_id`;
  const queued: QueuedRemoval[] = own.map((row) => ({
    spaceId: String(row.space_id),
    agentId: String(row.agent_id),
    connectionId: String(row.connection_id),
    jobId: String(row.job_id),
    path: String(row.path),
    hash: String(row.hash),
  }));
  for (let at = 0; at < queued.length; at += 500) {
    const rows = queued.slice(at, at + 500).map((each) => ({
      id: recordId('wrm'),
      space_id: each.spaceId,
      agent_id: each.agentId,
      connection_id: each.connectionId,
      job_id: each.jobId,
      path: each.path,
      hash: each.hash,
    }));
    await tx`insert into sandbox_work_removal ${tx(rows, 'id', 'space_id', 'agent_id', 'connection_id', 'job_id', 'path', 'hash')}`;
  }
  const [kept] = await tx`select count(*)::int as n from sandbox_work_file
    where writers && ${list}::text[]`;
  return { removed: queued.length, kept: Number(kept?.n ?? 0), queued };
}

/**
 * Take the queued files out of the copies of `/work` the computer's other
 * chats keep on this machine, into each chat's trash, where its content is
 * still what was recorded. Otherwise the next command of such a chat would
 * send them back. Answers how many went.
 */
export async function trashOtherCopies(
  sql: Sql,
  workspaces: { workRoot: string; days: number },
  queued: readonly QueuedRemoval[],
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const fs = new LocalWorkspaceFs(workspaces.workRoot);
  const byComputer = new Map<string, QueuedRemoval[]>();
  for (const each of queued) {
    const key = `${each.spaceId}\n${each.agentId}`;
    byComputer.set(key, [...(byComputer.get(key) ?? []), each]);
  }
  let moved = 0;
  for (const files of byComputer.values()) {
    const first = files[0] as QueuedRemoval;
    const jobs = await sql`select id from job
      where space_id = ${first.spaceId} and agent_id = ${first.agentId}`;
    for (const job of jobs) {
      const jobId = String(job.id);
      const place = await fs.trash(jobId).catch(() => null);
      if (!place) continue;
      // Only paths there now, so a copy without them gets no empty trash.
      const present: { path: string; hash: string }[] = [];
      for (const file of files) {
        const bytes = await fs.read(jobId, file.path, SYNC_LIMITS.maxFileBytes).catch(() => null);
        if (bytes && digest(bytes) === file.hash)
          present.push({ path: file.path, hash: file.hash });
      }
      if (!present.length) continue;
      try {
        const trashed = await moveToTrash(place, present, {
          days: workspaces.days,
          maxBytes: Number.POSITIVE_INFINITY,
        });
        moved += trashed.moved.length;
      } catch (error) {
        log(
          `files a deleted chat made could not be taken out of ${jobId}'s copy: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return moved;
}

export type WorkCleanup = { removed: string[]; kept: { path: string; reason: string }[] };

/**
 * Remove a computer's queued files from its `/work`. The computer must be
 * running; this never starts it. Each file goes only while it is still a
 * regular file inside `/work`, reached through no link, with the content
 * recorded when its chat was deleted. One that is not stays, recorded as
 * shared. The queue empties either way.
 */
export async function removeQueuedWork(
  sql: Sql,
  provider: SandboxProvider,
  handle: SandboxHandle,
  computer: WorkComputer,
  signal: AbortSignal,
): Promise<WorkCleanup> {
  const queued = await sql`select id, path, hash from sandbox_work_removal
    where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
      and connection_id = ${computer.connectionId}
    order by queued_at, id limit 2000`;
  const outcome: WorkCleanup = { removed: [], kept: [] };
  if (!queued.length) return outcome;
  const { files, other } = await listWork(provider, handle, signal);
  const doomed: string[] = [];
  const keptPresent = new Map<string, string | null>();
  for (const row of queued) {
    const path = String(row.path);
    let relative: string;
    try {
      relative = portable(path).join('/');
    } catch {
      outcome.kept.push({ path, reason: 'it is not a path inside /work' });
      continue;
    }
    if (relative !== path || !relative) {
      outcome.kept.push({ path, reason: 'it is not a path inside /work' });
      continue;
    }
    const size = files.get(relative);
    if (size === undefined) {
      // Gone already; or a link or a folder now, which is never followed or taken.
      if (other.has(relative))
        outcome.kept.push({ path, reason: 'it is no longer a regular file' });
      continue;
    }
    if (size > SYNC_LIMITS.maxFileBytes) {
      outcome.kept.push({ path, reason: 'it changed since the chat wrote it' });
      keptPresent.set(relative, null);
      continue;
    }
    const bytes = await provider.getFile(
      handle,
      `${SANDBOX_WORKDIR}/${relative}`,
      SYNC_LIMITS.maxFileBytes + 1,
      signal,
    );
    const hash = digest(bytes);
    if (bytes.byteLength !== size || hash !== String(row.hash)) {
      outcome.kept.push({ path, reason: 'it changed since the chat wrote it' });
      keptPresent.set(relative, hash);
      continue;
    }
    doomed.push(relative);
  }
  for (let at = 0; at < doomed.length; at += 200) {
    const batch = doomed.slice(at, at + 200);
    const ran = await provider.exec(
      handle,
      {
        marker: recordId('act'),
        argv: ['rm', '-f', '--', ...batch.map((relative) => `${SANDBOX_WORKDIR}/${relative}`)],
        cwd: SANDBOX_WORKDIR,
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      },
      signal,
    );
    if (ran.exitCode !== 0) throw new Error('the files could not be removed from the computer');
    outcome.removed.push(...batch);
  }
  await sql.begin(async (tx) => {
    await lockComputer(tx, computer);
    // Someone changed it after the chat: it is theirs too now, and stays.
    for (const [path, hash] of keptPresent)
      await tx`insert into sandbox_work_file
          (space_id, agent_id, connection_id, path, hash, shared, updated_at)
        values (${computer.spaceId}, ${computer.agentId}, ${computer.connectionId}, ${path},
          ${hash}, true, now())
        on conflict (space_id, agent_id, connection_id, path) do update
          set shared = true, updated_at = now()`;
    // What was removed is gone for everyone who had it recorded.
    if (outcome.removed.length)
      await tx`delete from sandbox_work_file
        where space_id = ${computer.spaceId} and agent_id = ${computer.agentId}
          and connection_id = ${computer.connectionId} and path = any(${outcome.removed}::text[])`;
    await tx`delete from sandbox_work_removal where id = any(${queued.map((row) => String(row.id))}::text[])`;
  });
  return outcome;
}

/**
 * Clean every running computer that has files queued: the sweep calls this,
 * so a deleted chat's files leave a running computer within a sweep. A
 * computer that is not running is left for its next start.
 */
export async function cleanRunningComputers(
  sql: Sql,
  providerFor: (adapter: string, connectionId: string) => SandboxProvider | undefined,
  signal: AbortSignal,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const rows = await sql`select distinct on (s.space_id, s.agent_id, s.connection_id)
      s.space_id, s.agent_id, s.connection_id, s.adapter, s.provider_sandbox_id,
      s.image_digest, s.region
    from sandbox_work_removal r
    join sandbox_session s on s.space_id = r.space_id and s.agent_id = r.agent_id
      and s.connection_id = r.connection_id and s.status = 'ready'
      and s.persistence <> 'ephemeral'
    order by s.space_id, s.agent_id, s.connection_id, s.opened_at desc`;
  let removed = 0;
  for (const row of rows) {
    if (signal.aborted) break;
    let provider: SandboxProvider | undefined;
    try {
      provider = providerFor(String(row.adapter), String(row.connection_id));
    } catch {
      provider = undefined;
    }
    if (!provider) continue;
    const computer: WorkComputer = {
      spaceId: String(row.space_id),
      agentId: String(row.agent_id),
      connectionId: String(row.connection_id),
      providerSandboxId: String(row.provider_sandbox_id),
    };
    try {
      const handle: SandboxHandle = {
        providerSandboxId: computer.providerSandboxId,
        imageDigest: (row.image_digest as string | null) ?? null,
        region: (row.region as string | null) ?? null,
      };
      removed += (await removeQueuedWork(sql, provider, handle, computer, signal)).removed.length;
    } catch (error) {
      log(
        `files deleted chats made were not removed from ${computer.providerSandboxId} yet: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return removed;
}
