/**
 * The person's files, in one place: what Melete saved into their Files, what
 * their own conversations made, and what they sent in chat. Each is read from
 * its own content route, so this list adds no way to read a file that those
 * routes do not already allow; it only finds them.
 *
 * A file belongs to the person whose conversation made it, as on the content
 * routes: one recorded without a conversation belongs to the space. A delete
 * moves the file into the trash the files tools use, so it can be put back,
 * here or by asking Melete in the conversation it came from.
 */
import { realpath } from 'node:fs/promises';
import {
  ID_PREFIXES,
  type PersonFile,
  personFileDeleted,
  personFileList,
  personFileRestore,
  personFileRestored,
  prefixedId,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import type { ArtifactRoots } from '../artifact/content.ts';
import { FILE_TOOLS, mimeForName, savedFile } from '../artifact/shown.ts';
import { attachment } from '../attachments/schema.ts';
import {
  filesTrash,
  hasTrash,
  latestTrash,
  moveToTrash,
  restoreFromTrash,
  SPACE_FILES_TRASH,
  type TrashPlace,
} from '../connectors/files-trash.ts';
import {
  FILES_TURN_IDLE_LIMIT,
  FILES_TURN_LOCK,
  FILES_TURN_LOCK_TIMEOUT,
  type FilesHold,
  heldThrough,
  inFilesTurn,
  managesSharedFiles,
} from '../connectors/shared-files.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, job } from '../db/schema.ts';
import { ownJob, spaceAuthority } from '../principals/authority.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { restoreStoredFiles, storageUsed, trashStoredFile } from '../storage/per-person.ts';
import {
  artifactLocation,
  MAX_SERVED_BYTES,
  matches,
  type Opened,
  openArtifact,
  type Stored,
} from './artifacts.ts';
import { ServiceError } from './errors.ts';
import type { SpaceResolver } from './reactions.ts';

/** The most records of each kind read for one list. */
const READ_LIMIT = 1000;
/** The most files one list returns. */
const LIST_LIMIT = 500;

/**
 * A page or a screenshot the agent's browser kept at one step of its work.
 * The browser records each under `browser/` in the space's folder with no
 * conversation of its own (`source_job_id` is null) and names it by its own
 * record id, so only those are left out: anything else under `browser/`,
 * a file the person or the agent put there, is listed.
 */
const BROWSER_STEP = /^browser\/art_[A-Za-z0-9]+\.(?:txt|png)$/;

/**
 * Melete's own working folder in a chat's workspace. In the person's Files a
 * folder of that name is theirs, like any other.
 */
const WORKING_FOLDER = /^\.melete\//;

const noFile = () => new ServiceError('not_found', 'There is no such file.', 404);
const notTheirs = (what: string) =>
  new ServiceError(
    'scope_denied',
    `Only the owner of this space can ${what} a file that no chat of yours made.`,
    403,
  );

type Scope = { spaceId: string; principalId: string | undefined };
type JobRow = typeof job.$inferSelect;

/** One record of a file on disk, before it is checked to still be there. */
type Found = {
  id: string;
  row: Stored;
  mime: string;
  savedAt: Date;
  job: JobRow | null;
  /** The content the record saved, and its size where recorded. */
  hash: string | null;
  size: number | null;
};

/** Where a record's file is: the key that makes one file one entry, and how to reach its trash. */
function placeOf(roots: ArtifactRoots, spaceId: string, row: Stored) {
  const location = artifactLocation(roots, spaceId, row);
  if ('job' in location)
    return {
      place: 'chat' as const,
      job: location.job,
      path: location.segments.join('/'),
      key: `chat:${location.job}:${location.segments.join('/')}`,
    };
  // The space's folder: the names after `<space>/artifacts`.
  const path = location.segments.slice(2).join('/');
  return { place: 'files' as const, job: null, path, key: `files:${path}` };
}

async function scopeOf(c: Context, resolveSpace: SpaceResolver): Promise<Scope> {
  const scope = await resolveSpace(c);
  if (!scope || !prefixedId(ID_PREFIXES.space).safeParse(scope.spaceId).success) throw noFile();
  return { spaceId: scope.spaceId, principalId: scope.principalId };
}

/** The artifacts this person may read in the space, as the artifacts route allows. */
function visibleArtifacts(db: Database, scope: Scope, id?: string) {
  return db
    .select({ artifact, job })
    .from(artifact)
    .leftJoin(job, eq(artifact.jobId, job.id))
    .where(
      and(
        id ? eq(artifact.id, id) : undefined,
        eq(artifact.spaceId, scope.spaceId),
        or(
          isNull(artifact.jobId),
          and(
            eq(job.spaceId, scope.spaceId),
            scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
          ),
        ),
      ),
    )
    .orderBy(desc(artifact.createdAt))
    .limit(READ_LIMIT);
}

/** The files actions of this person's own conversations, as the files route allows. */
function visibleActions(db: Database, scope: Scope, id?: string) {
  return db
    .select({ action, job })
    .from(action)
    .innerJoin(job, eq(action.jobId, job.id))
    .where(
      and(
        id ? eq(action.id, id) : undefined,
        eq(action.status, 'succeeded'),
        inArray(action.kind, [...FILE_TOOLS]),
        eq(job.spaceId, scope.spaceId),
        scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
      ),
    )
    .orderBy(desc(action.resolvedAt))
    .limit(READ_LIMIT);
}

function fromArtifact(row: { artifact: typeof artifact.$inferSelect; job: JobRow | null }): Found {
  return {
    id: row.artifact.id,
    row: row.artifact,
    mime: row.artifact.mime,
    savedAt: row.artifact.createdAt,
    job: row.job,
    hash: row.artifact.contentHash,
    size: row.artifact.size,
  };
}

function fromAction(row: { action: typeof action.$inferSelect; job: JobRow }): Found | null {
  const saved = savedFile(row.action.kind, row.action.receipt);
  if (!saved) return null;
  const bytes = (row.action.receipt as { detail?: { bytes?: unknown } } | null)?.detail?.bytes;
  return {
    id: row.action.id,
    row: { area: saved.area, path: saved.path, jobId: row.job.id, sourceJobId: row.job.id },
    mime: mimeForName(saved.path.split('/').at(-1) ?? ''),
    savedAt: row.action.resolvedAt ?? row.action.dispatchedAt ?? new Date(0),
    job: row.job,
    hash: saved.contentHash,
    size: typeof bytes === 'number' && Number.isSafeInteger(bytes) ? bytes : null,
  };
}

/** Whether a record's file is in a conversation's own folder, as `artifactLocation` decides. */
const inChatFolder = (row: Stored) => row.area === 'work' && row.sourceJobId !== null;

/**
 * A record of Melete's own working, rather than the person's file: a browser
 * step's capture, or anything under a chat folder's `.melete/` folder, such as
 * the full output of a command kept beside a chat.
 */
const workingRecord = (found: Found) =>
  (inChatFolder(found.row) && WORKING_FOLDER.test(found.row.path)) ||
  (found.id.startsWith(`${ID_PREFIXES.artifact}_`) &&
    found.row.sourceJobId === null &&
    BROWSER_STEP.test(found.row.path));

/** One record by its id, when this person may see it; null otherwise. */
async function oneRecord(db: Database, scope: Scope, id: string): Promise<Found | null> {
  if (prefixedId(ID_PREFIXES.artifact).safeParse(id).success) {
    const [row] = await visibleArtifacts(db, scope, id);
    return row ? fromArtifact(row) : null;
  }
  if (prefixedId(ID_PREFIXES.action).safeParse(id).success) {
    const [row] = await visibleActions(db, scope, id);
    return row ? fromAction(row) : null;
  }
  return null;
}

/**
 * The trash a delete of this record's file uses, the one the files tools use
 * for it, first; then any other an earlier delete of it may have used.
 */
async function trashesFor(
  db: Database,
  scope: Scope,
  roots: ArtifactRoots,
  found: Found,
): Promise<{ places: TrashPlace[]; path: string }> {
  const where = placeOf(roots, scope.spaceId, found.row);
  if (where.job !== null)
    return {
      places: [await new LocalWorkspaceFs(roots.workRoot).trash(where.job)],
      path: where.path,
    };
  // A file in the space's folder goes into the trash of the chat that saved
  // it, or that the run which saved it was started from, where Melete can
  // also restore it by asking in that chat; one saved with none, into the
  // space's. Files a run saved went into the run's own trash before.
  const owners: string[] = [];
  if (found.job) {
    const chat = (await chatsFor(db, scope, [found.job])).get(found.job.id);
    if (chat) owners.push(chat.id);
    owners.push(found.job.id);
  } else owners.push(SPACE_FILES_TRASH);
  const base = await realpath(roots.spacesRoot);
  return {
    places: [...new Set(owners)].map((owner) => filesTrash(base, scope.spaceId, owner)),
    path: where.path,
  };
}

/**
 * Whether this person may delete what the space holds with no chat of theirs
 * behind it: in a space of their own, always; in a shared one, only its owner.
 */
async function managesSpaceFiles(db: Database, scope: Scope): Promise<boolean> {
  if (!scope.principalId) return true;
  const access = await spaceAuthority(db, scope.spaceId, scope.principalId).catch(
    (error: unknown) => {
      if (error instanceof ServiceError) return null;
      throw error;
    },
  );
  return managesSharedFiles(access?.role);
}

/**
 * Whether the file open at a record's name is still the one the record saved:
 * the same size where one was recorded, and the same content. A chat's record
 * of a file in the space's Files stands for that file only while it is.
 */
const stillSaved = (found: Found, opened: Opened): Promise<boolean> =>
  found.hash === null
    ? Promise.resolve(false)
    : matches(opened, { size: found.size, hash: found.hash, max: MAX_SERVED_BYTES }).catch(
        () => false,
      );

/** The chats files came from, by job: a run reports into the chat it was started from. */
async function chatsFor(
  db: Database,
  scope: Scope,
  jobs: JobRow[],
): Promise<Map<string, { id: string; title: string }>> {
  const chats = new Map<string, { id: string; title: string }>();
  const parents = new Set<string>();
  for (const row of jobs) {
    if (row.kind === 'chat') chats.set(row.id, { id: row.id, title: row.title });
    else if (row.experienceParentId) parents.add(row.experienceParentId);
  }
  if (parents.size) {
    const found = await db
      .select({ id: job.id, title: job.title })
      .from(job)
      .where(
        and(
          inArray(job.id, [...parents]),
          eq(job.spaceId, scope.spaceId),
          eq(job.kind, 'chat'),
          scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
        ),
      );
    const byId = new Map(found.map((row) => [row.id, row]));
    for (const row of jobs) {
      const parent = row.experienceParentId ? byId.get(row.experienceParentId) : undefined;
      if (row.kind !== 'chat' && parent) chats.set(row.id, parent);
    }
  }
  return chats;
}

/** Runs `work` over `items`, a few at a time. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>, size = 16): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  return results;
}

export function mountFiles(
  app: Hono,
  db: Database,
  roots: ArtifactRoots,
  resolveSpace: SpaceResolver,
  trash: { days: number; maxBytes: number },
  /**
   * Where what each person keeps is recorded, and the most they may keep
   * (storage/per-person.ts). Left out, deletes here are not recorded there.
   */
  storage?: { sql: Sql; quota: number | null },
): void {
  /** What this person keeps against their limit, where the installation sets one. */
  const storageOf = async (scope: Scope) => {
    if (!storage?.quota || !scope.principalId) return null;
    const used = await storageUsed(storage.sql, scope.principalId);
    return { used_bytes: Math.round(used), quota_bytes: storage.quota };
  };

  app.get('/files', async (c) => {
    const scope = await scopeOf(c, resolveSpace);
    const [artifacts, actions, sent] = await Promise.all([
      visibleArtifacts(db, scope),
      visibleActions(db, scope),
      db
        .select({ attachment, job })
        .from(attachment)
        .innerJoin(job, eq(attachment.jobId, job.id))
        .where(
          and(
            eq(attachment.spaceId, scope.spaceId),
            eq(job.spaceId, scope.spaceId),
            scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
          ),
        )
        .orderBy(desc(attachment.createdAt))
        .limit(READ_LIMIT),
    ]);
    const records = [
      ...artifacts.map(fromArtifact),
      ...actions.flatMap((row) => fromAction(row) ?? []),
    ]
      .filter((found) => !workingRecord(found))
      .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
    // One file saved twice, or recorded both as an artifact and a write, is listed once, at its newest.
    const newest = new Map<string, { found: Found; where: ReturnType<typeof placeOf> }>();
    for (const found of records) {
      let where: ReturnType<typeof placeOf>;
      try {
        where = placeOf(roots, scope.spaceId, found.row);
      } catch {
        continue;
      }
      if (!newest.has(where.key)) newest.set(where.key, { found, where });
    }
    const managesSpace = [...newest.values()].some((entry) => entry.where.place === 'files')
      ? await managesSpaceFiles(db, scope)
      : false;
    // Only what is still there: a file moved, deleted or never written is not listed.
    const present = await inBatches([...newest.values()], async (entry) => {
      try {
        const opened = await openArtifact(roots, scope.spaceId, entry.found.row);
        try {
          // What the space holds with no chat behind it, or that is no longer
          // what a chat saved there, is its owner's to delete.
          const deletable =
            managesSpace ||
            (entry.found.job !== null &&
              (entry.where.place === 'chat' || (await stillSaved(entry.found, opened))));
          return { ...entry, size: opened.size, deletable };
        } finally {
          await opened.handle.close();
        }
      } catch {
        return null;
      }
    });
    const kept = present.flatMap((entry) => entry ?? []);
    const chats = await chatsFor(db, scope, [
      ...kept.flatMap((entry) => entry.found.job ?? []),
      ...sent.map((row) => row.job),
    ]);
    const files: PersonFile[] = [
      ...kept.map((entry) => ({
        id: entry.found.id,
        name: entry.where.path.split('/').at(-1) ?? entry.where.path,
        path: entry.where.path,
        place: entry.where.place,
        mime: entry.found.mime,
        size: entry.size,
        saved_at: entry.found.savedAt.toISOString(),
        chat: entry.found.job ? (chats.get(entry.found.job.id) ?? null) : null,
        deletable: entry.deletable,
      })),
      ...sent.map((row) => ({
        id: row.attachment.id,
        name: row.attachment.name,
        path: row.attachment.name,
        place: 'sent' as const,
        mime: row.attachment.mediaType,
        size: row.attachment.size,
        saved_at: (row.attachment.sentAt ?? row.attachment.createdAt).toISOString(),
        chat: chats.get(row.job.id) ?? null,
        deletable: false,
      })),
    ]
      .sort((a, b) => Date.parse(b.saved_at) - Date.parse(a.saved_at))
      .slice(0, LIST_LIMIT);
    return c.json(personFileList.parse({ files, storage: await storageOf(scope) }));
  });

  /**
   * A delete's turn in the space's Files held in the database too, so it is
   * one turn with steps on every instance (`inFilesTurn`): the same lock as
   * `lockFilesTurnIn`, in Drizzle form.
   */
  const filesTurnHold: FilesHold = <T>(spaceId: string, work: (query: null) => Promise<T>) =>
    heldThrough<Parameters<Parameters<Database['transaction']>[0]>[0], T>(
      (body) => db.transaction(body),
      (tx) =>
        tx.execute(sql`select pg_advisory_xact_lock(${FILES_TURN_LOCK}, hashtext(${spaceId}))
          from (select set_config('lock_timeout', ${FILES_TURN_LOCK_TIMEOUT}, true) as timeout,
              set_config('idle_in_transaction_session_timeout', ${FILES_TURN_IDLE_LIMIT}, true) as idle) limits
          where limits.timeout is not null and limits.idle is not null`),
      () => work(null),
    );

  app.delete('/files/:id', async (c) => {
    const scope = await scopeOf(c, resolveSpace);
    const id = c.req.param('id');
    const found = await oneRecord(db, scope, id);
    if (!found || workingRecord(found)) throw noFile();
    if (found.job === null && !(await managesSpaceFiles(db, scope))) throw notTheirs('delete');
    let target: { places: TrashPlace[]; path: string };
    try {
      target = await trashesFor(db, scope, roots, found);
    } catch {
      throw noFile();
    }
    const place = target.places[0];
    if (!place) throw noFile();
    // Only a file that is there, and is a file: never a folder, never through
    // a link. The one checked here is the one that goes: anything put at its
    // name since stays where it is. It is held open until the move is done,
    // so a file made at its name after it was deleted there cannot be given
    // its number on the disk and pass for it.
    // A chat's record of a file in the space's Files deletes only the file it
    // saved: anything put at its name since is the space's, and its owner's to
    // delete. Who manages the space is read before the turn, which then
    // sends nothing to the database but its own lock.
    const onlyAsSaved =
      found.job !== null && !inChatFolder(found.row) && !(await managesSpaceFiles(db, scope));
    let opened: Awaited<ReturnType<typeof openArtifact>>;
    try {
      opened = await openArtifact(roots, scope.spaceId, found.row);
    } catch {
      throw noFile();
    }
    let trashed: Awaited<ReturnType<typeof moveToTrash>>;
    try {
      // The check and the delete are one turn in the space's Files, on every
      // instance: nothing saved there can change the open file between them.
      trashed = await inFilesTurn(
        scope.spaceId,
        async () => {
          // The file checked is the open one, the one that goes.
          if (onlyAsSaved && !(await stillSaved(found, opened))) throw notTheirs('delete');
          const checked = await opened.handle.stat().catch(() => {
            throw noFile();
          });
          const file = { dev: checked.dev, ino: checked.ino };
          return moveToTrash(place, [{ path: target.path, hash: null, file }], {
            days: trash.days,
            maxBytes: trash.maxBytes,
          }).catch((error: unknown) => {
            throw new ServiceError(
              'file_not_deleted',
              error instanceof Error
                ? `The file was not deleted: ${error.message}.`
                : 'The file was not deleted.',
              409,
            );
          });
        },
        filesTurnHold,
      );
    } finally {
      await opened.handle.close();
    }
    // Anything kept means the file asked for is not what went: it changed
    // after the check, even when what took its place is now in the trash.
    if (!trashed.trash_id || !trashed.moved.length || trashed.kept.length) {
      const evicted = trashed.evicted.length;
      throw new ServiceError(
        'file_not_deleted',
        `The file was not deleted${trashed.kept[0] ? `: ${trashed.kept[0].reason}` : ''}.${
          evicted
            ? ` The trash was full, so ${evicted === 1 ? 'an earlier delete was' : `${evicted} earlier deletes were`} taken out of it to make room and can no longer be put back.`
            : ''
        }`,
        409,
      );
    }
    // What it held is no longer counted against anyone while it is in the trash.
    if (storage)
      await trashStoredFile(
        storage.sql,
        scope.spaceId,
        { place: placeOf(roots, scope.spaceId, found.row).key },
        trashed.trash_id,
      );
    return c.json(
      personFileDeleted.parse({
        id: found.id,
        trash_id: trashed.trash_id,
        restorable_until: trashed.restorable_until,
        evicted: trashed.evicted.length,
      }),
    );
  });

  app.post('/files/:id/restore', async (c) => {
    const scope = await scopeOf(c, resolveSpace);
    const body = personFileRestore.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new ServiceError('invalid_request', 'Name the trash to restore from.', 400);
    const found = await oneRecord(db, scope, c.req.param('id'));
    if (!found || workingRecord(found)) throw noFile();
    if (found.job === null && !(await managesSpaceFiles(db, scope))) throw notTheirs('restore');
    let target: { places: TrashPlace[]; path: string };
    try {
      target = await trashesFor(db, scope, roots, found);
    } catch {
      throw noFile();
    }
    let restored: Awaited<ReturnType<typeof restoreFromTrash>>;
    try {
      let place: TrashPlace | undefined;
      for (const candidate of target.places)
        if (await hasTrash(candidate, body.data.trash_id)) {
          place = candidate;
          break;
        }
      if (!place) throw noFile();
      // Only the latest delete that took this file: never another file's trash.
      const latest = await latestTrash(place, target.path);
      if (latest?.id !== body.data.trash_id) throw noFile();
      restored = await restoreFromTrash(place, body.data.trash_id);
    } catch {
      throw new ServiceError('not_found', 'There is nothing in the trash to put back.', 404);
    }
    if (!restored.restored.includes(target.path))
      throw new ServiceError(
        'file_not_restored',
        `The file was not put back${restored.kept[0] ? `: ${restored.kept[0].reason}` : ''}.`,
        409,
      );
    if (storage) await restoreStoredFiles(storage.sql, scope.spaceId, body.data.trash_id);
    return c.json(personFileRestored.parse({ id: found.id, restored: true }));
  });
}
