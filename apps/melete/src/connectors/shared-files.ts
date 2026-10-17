/**
 * Who may change what is already in a shared space's Files.
 *
 * In a person's own space, everything in their Files is theirs, as before. In
 * a shared space, its owner changes anything there. Anyone else's agent adds
 * new files, and saves over, moves or deletes only a file that person's own
 * work put there and nobody has changed since. Their own work is a request
 * they made of the room's agent (or a run started from one), or a chat of
 * their own in the space; nobody having changed it since is the file holding
 * exactly the content that work last left at its name.
 *
 * The role is the one the space's own routes read (`spaceStanding`, the raw-SQL
 * twin of `spaceAuthority`), and `managesSharedFiles` is the one rule both the
 * files tools and the Files routes apply to it.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Query } from '../broker/records.ts';
import { segmentsFor } from '../paths.ts';
import { type MembershipRole, spaceStanding } from '../principals/authority.ts';
import { beneath } from './files-ownership.ts';

/**
 * The advisory lock that holds a space's Files turn across every instance on
 * the database, with the space's hashed id as its second key. Its two-key form
 * keeps it apart from the single-key locks the service takes elsewhere (the
 * event order lock among them); two spaces that hash alike only take turns.
 */
export const FILES_TURN_LOCK = 31003104;

/**
 * How long a step waits for another instance to finish its turn in the same
 * space's Files. A turn takes milliseconds of file work, so a wait this long
 * means the holder is stuck: the step fails rather than hold its connection.
 */
export const FILES_TURN_LOCK_TIMEOUT = '30s';

/**
 * How long a turn's transaction may sit idle while its file work runs, in
 * place of the minute the service gives its other transactions
 * (`IDLE_IN_TRANSACTION_TIMEOUT_MS`). A turn sends nothing to the database
 * while it works on the disk, and the biggest one, a delete of a folder of
 * `DELETE_ENTRIES` files, reads each file twice: it can take minutes, and
 * the space must stay held until it is done.
 */
export const FILES_TURN_IDLE_LIMIT = '15min';

/** Take the space's Files turn in a postgres.js transaction, with its limits in force first. */
export async function lockFilesTurnIn(tx: TransactionSql, spaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(${FILES_TURN_LOCK}, hashtext(${spaceId}))
    from (select set_config('lock_timeout', ${FILES_TURN_LOCK_TIMEOUT}, true) as timeout,
        set_config('idle_in_transaction_session_timeout', ${FILES_TURN_IDLE_LIMIT}, true) as idle) limits
    where limits.timeout is not null and limits.idle is not null`;
}

/**
 * Run a turn's work in the transaction `begin` opens, once `lock` has taken
 * the space there. The transaction only holds the lock and the work's reads,
 * so once the work has started, its outcome is the turn's: a transaction that
 * ends early (its connection lost, which postgres.js reports at once) or fails
 * to commit still waits for the work: a change made on the disk is never
 * reported as not made, nor this process's next turn let in while it is
 * being made. (Other instances wait only while the connection holds the lock.)
 */
export async function heldThrough<Tx, T>(
  begin: (body: (tx: Tx) => Promise<T>) => Promise<T>,
  lock: (tx: Tx) => Promise<unknown>,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  let working: Promise<T> | undefined;
  try {
    return await begin(async (tx) => {
      await lock(tx);
      working = work(tx);
      return working;
    });
  } catch (error) {
    if (!working) throw error;
    return working;
  }
}

/**
 * Runs a turn's work while the database holds it for this instance. The work
 * is handed the transaction that holds it, and sends its own statements
 * through it: a turn never waits on a second pool connection while it holds
 * one, so turns in many spaces at once cannot use up the pool between them.
 * Null where the turn is not held in the database.
 */
export type FilesHold = <T>(
  spaceId: string,
  work: (query: Query | null) => Promise<T>,
) => Promise<T>;

/** Held in this process only: for a connector with no database, as in tests. */
const inThisProcess: FilesHold = (_spaceId, work) => work(null);

/**
 * The turn held through `sql` as well: one short transaction per turn that
 * takes the space's lock and does the turn's work in it. Nothing but the
 * file work and its own reads runs in it, and never under the event order
 * lock. Slow work that is not the change itself stays outside the turn
 * (asking the agent's computer to drop a moved file's copy among it); the
 * change itself keeps the space held for as long as it takes, up to
 * `FILES_TURN_IDLE_LIMIT` with nothing sent. Without a database, the turn is
 * this process's alone.
 */
export function filesHold(sql: Sql | null | undefined): FilesHold {
  if (!sql) return inThisProcess;
  return <T>(spaceId: string, work: (query: Query | null) => Promise<T>) =>
    heldThrough<TransactionSql, T>(
      (body) => sql.begin(body) as Promise<T>,
      (tx) => lockFilesTurnIn(tx, spaceId),
      work,
    );
}

const turns = new Map<string, Promise<unknown>>();

/**
 * Runs `work` in its turn in a space's Files: after every change there that
 * any instance of the service started before it, and before any started
 * after. A step that checks what is at a name and then changes it does both
 * in one turn, so no other step can save over, move or replace that file in
 * between. Every step that saves over, moves, replaces or deletes something
 * already in a space's Files takes its turn here, whoever it works for.
 *
 * Steps in this process queue here first, so a space has at most one of
 * them waiting on `hold` (the database lock) at a time; `hold` then makes
 * steps on other instances wait too.
 */
export function inFilesTurn<T>(
  spaceId: string,
  work: (query: Query | null) => Promise<T>,
  hold: FilesHold = inThisProcess,
): Promise<T> {
  const previous = turns.get(spaceId) ?? Promise.resolve();
  const run = () => hold(spaceId, work);
  // The queue carries on whether the one before succeeded or failed.
  const result = previous.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  turns.set(spaceId, settled);
  void settled.then(() => {
    if (turns.get(spaceId) === settled) turns.delete(spaceId);
  });
  return result;
}

/** Whether a role changes what others put in a shared space's Files: only its owner's does. */
export const managesSharedFiles = (role: MembershipRole | null | undefined): boolean =>
  role === 'owner';

/**
 * What a job may change in its space's Files. Open: anything, as before.
 * Limited: new files, and the files in `theirs`, each only while it holds one
 * of the contents listed for it.
 */
export type SharedFilesRule =
  | { limited: false }
  | { limited: true; theirs: Map<string, Set<string>> };

export const ANY_FILE: SharedFilesRule = { limited: false };
const NONE: SharedFilesRule = { limited: true, theirs: new Map() };

/**
 * The rule for one job's files steps, read through `query`. Who a job works
 * for is read as the room's approvals read it (`roomAuthorityOf`): a run
 * started from a room's request, or the request itself, works for the member
 * who asked; the room's own work, for nobody; anything else, for the job's
 * principal. The same reading picks that person's steps in the space.
 */
export async function sharedFilesRule(
  query: Query,
  jobId: string,
  spaceId: string,
): Promise<SharedFilesRule> {
  const [row] = await query`select s.kind as space_kind,
      case when r.audience = 'room' then r.requested_by_principal_id
        when j.audience = 'room' then j.requested_by_principal_id
        when p.kind = 'room' then null
        else j.principal_id end as works_for,
      coalesce(r.audience = 'room' or j.audience = 'room' or p.kind = 'room', false) as for_room
    from job j join space s on s.id = j.space_id
    left join principal p on p.id = j.principal_id
    left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.id = ${jobId} and j.space_id = ${spaceId}`;
  if (row?.space_kind === 'personal') return ANY_FILE;
  // A job this space does not hold, or a room's work nobody is recorded as asking for.
  if (!row || (row.for_room && !row.works_for)) return NONE;
  const actor = row.works_for ? String(row.works_for) : null;
  if (managesSharedFiles((await spaceStanding(query, spaceId, actor))?.role)) return ANY_FILE;
  if (!actor) return NONE;
  // Only steps that settled: one still out, or whose outcome is not known,
  // makes nothing theirs, and the check of the bytes there covers what it did.
  const rows = await query`select x.kind, x.canonical_payload, x.receipt from action x
    join job j on j.id = x.job_id
    left join principal p on p.id = j.principal_id
    left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.space_id = ${spaceId} and x.status = 'succeeded'
      and x.kind in ('files.write', 'files.move', 'files.delete')
      and (case when r.audience = 'room' then r.requested_by_principal_id
        when j.audience = 'room' then j.requested_by_principal_id
        when p.kind = 'room' then null
        else j.principal_id end) = ${actor}
    order by x.resolved_at nulls last, x.created_at, x.id`;
  return { limited: true, theirs: theirFiles(rows as unknown as RecordRow[]) };
}

type RecordRow = { kind: string; canonical_payload: unknown; receipt: unknown };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A recorded path as its names joined by `/`, or null when it names no file. */
export function filesPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const segments = segmentsFor(value);
    return segments.length ? segments.join('/') : null;
  } catch {
    return null;
  }
}

/**
 * The files in the space's Files one person's work put there, with the
 * content it left, folded from their settled steps in the order they settled.
 * A write makes a file theirs only when its receipt says it made the file new,
 * or that it saved over content of theirs at that name (`replaced`); any
 * other write there ends their claim. A move keeps a file theirs at its new
 * name, and one from their own workspace becomes theirs; a delete ends it.
 */
export function theirFiles(rows: readonly RecordRow[]): Map<string, Set<string>> {
  const theirs = new Map<string, Set<string>>();
  for (const row of rows) {
    const payload = object(row.canonical_payload);
    const detail = object(object(row.receipt).detail);
    const hash = typeof detail.content_hash === 'string' ? detail.content_hash : null;
    const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
    if (row.kind === 'files.write') {
      const written = filesPath(payload.path);
      if (!written || area !== 'artifacts') continue;
      const kept =
        detail.created === true ||
        (typeof detail.replaced === 'string' && theirs.get(written)?.has(detail.replaced) === true);
      if (hash && kept) theirs.set(written, new Set([hash]));
      else theirs.delete(written);
    } else if (row.kind === 'files.move') {
      const from = filesPath(payload.from);
      const to = filesPath(payload.to);
      if (!from || !to) continue;
      const toArea = (payload.to_area ?? payload.area) === 'artifacts' ? 'artifacts' : 'work';
      const was = area === 'work' || theirs.has(from);
      if (area === 'artifacts') theirs.delete(from);
      if (toArea !== 'artifacts') continue;
      if (was && hash) theirs.set(to, new Set([hash]));
      else theirs.delete(to);
    } else if (row.kind === 'files.delete') {
      const gone = filesPath(payload.path);
      if (!gone || area !== 'artifacts') continue;
      for (const path of beneath(theirs.keys(), gone)) theirs.delete(path);
    }
  }
  return theirs;
}

/** Whether `relative` in the space's Files holds content this rule lets the job change. */
export function mayChange(rule: SharedFilesRule, relative: string, hash: string | null): boolean {
  if (!rule.limited) return true;
  const path = filesPath(relative);
  return hash !== null && path !== null && rule.theirs.get(path)?.has(hash) === true;
}

/** Why a step on someone else's file in a shared space's Files was refused, said to the agent. */
export function notTheirs(
  kind: 'files.write' | 'files.move' | 'files.delete',
  relative: string,
  folder = false,
): string {
  const name = JSON.stringify(relative);
  if (folder)
    return `only the space's owner can delete the folder ${name} in this space's Files, since it is not made up only of files your own work added; delete your own files in it one at a time instead`;
  const what = `${name} in this space's Files was added or changed by someone else, and only the space's owner can`;
  if (kind === 'files.write') return `${what} change it; save your version as a new file instead`;
  if (kind === 'files.move')
    return `${what} move or rename it; save a copy under a new name instead`;
  return `${what} delete it`;
}

/**
 * Why a published or generated file was not saved at a name already in a
 * shared space's Files, said to the agent. Only a new name is open to anyone
 * but the space's owner here, their own earlier files included.
 */
export const alreadyInFiles = (name: string): string =>
  `${JSON.stringify(name)} is already in this space's Files, and only the space's owner can replace it; save it under a new name instead`;

/**
 * Whether this job may only add new files to its space's Files through tools
 * that do not track whose each file is (publishing, generated audio): true in
 * a shared space for anyone but its owner, as `sharedFilesRule` decides.
 */
export async function onlyNewFiles(query: Query, jobId: string, spaceId: string): Promise<boolean> {
  return (await sharedFilesRule(query, jobId, spaceId)).limited;
}
