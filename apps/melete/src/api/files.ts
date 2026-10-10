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
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { ArtifactRoots } from '../artifact/content.ts';
import { FILE_TOOLS, mimeForName, savedFile } from '../artifact/shown.ts';
import { attachment } from '../attachments/schema.ts';
import {
  filesTrash,
  latestTrash,
  moveToTrash,
  restoreFromTrash,
  type TrashPlace,
} from '../connectors/files-trash.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, job } from '../db/schema.ts';
import { ownJob } from '../principals/authority.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { artifactLocation, openArtifact, type Stored } from './artifacts.ts';
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

const noFile = () => new ServiceError('not_found', 'There is no such file.', 404);

type Scope = { spaceId: string; principalId: string | undefined };
type JobRow = typeof job.$inferSelect;

/** One record of a file on disk, before it is checked to still be there. */
type Found = {
  id: string;
  row: Stored;
  mime: string;
  savedAt: Date;
  job: JobRow | null;
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
  };
}

function fromAction(row: { action: typeof action.$inferSelect; job: JobRow }): Found | null {
  const saved = savedFile(row.action.kind, row.action.receipt);
  if (!saved) return null;
  return {
    id: row.action.id,
    row: { area: saved.area, path: saved.path, jobId: row.job.id, sourceJobId: row.job.id },
    mime: mimeForName(saved.path.split('/').at(-1) ?? ''),
    savedAt: row.action.resolvedAt ?? row.action.dispatchedAt ?? new Date(0),
    job: row.job,
  };
}

/** A browser step's capture, which is the browser's working record rather than the person's file. */
const browserStep = (found: Found) =>
  found.id.startsWith(`${ID_PREFIXES.artifact}_`) &&
  found.row.sourceJobId === null &&
  BROWSER_STEP.test(found.row.path);

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

/** The trash a delete of this record's file uses: the one the files tools use for it. */
async function trashFor(
  roots: ArtifactRoots,
  spaceId: string,
  found: Found,
): Promise<{ place: TrashPlace; path: string }> {
  const where = placeOf(roots, spaceId, found.row);
  if (where.job !== null)
    return { place: await new LocalWorkspaceFs(roots.workRoot).trash(where.job), path: where.path };
  // A file in the space's folder goes into the trash of the conversation that
  // saved it, where Melete can also restore it; one saved with none, into the space's.
  const owner = found.job?.id ?? 'files';
  return { place: filesTrash(await realpath(roots.spacesRoot), spaceId, owner), path: where.path };
}

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
): void {
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
      .filter((found) => !browserStep(found))
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
    // Only what is still there: a file moved, deleted or never written is not listed.
    const present = await inBatches([...newest.values()], async (entry) => {
      try {
        const opened = await openArtifact(roots, scope.spaceId, entry.found.row);
        await opened.handle.close();
        return { ...entry, size: opened.size };
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
        deletable: true,
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
    return c.json(personFileList.parse({ files }));
  });

  app.delete('/files/:id', async (c) => {
    const scope = await scopeOf(c, resolveSpace);
    const id = c.req.param('id');
    const found = await oneRecord(db, scope, id);
    if (!found || browserStep(found)) throw noFile();
    let target: { place: TrashPlace; path: string };
    try {
      target = await trashFor(roots, scope.spaceId, found);
    } catch {
      throw noFile();
    }
    // Only a file that is there, and is a file: never a folder, never through a link.
    try {
      const opened = await openArtifact(roots, scope.spaceId, found.row);
      await opened.handle.close();
    } catch {
      throw noFile();
    }
    const trashed = await moveToTrash(target.place, [{ path: target.path, hash: null }], {
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
    if (!trashed.trash_id || !trashed.moved.length)
      throw new ServiceError(
        'file_not_deleted',
        `The file was not deleted${trashed.kept[0] ? `: ${trashed.kept[0].reason}` : ''}.`,
        409,
      );
    return c.json(
      personFileDeleted.parse({
        id: found.id,
        trash_id: trashed.trash_id,
        restorable_until: trashed.restorable_until,
      }),
    );
  });

  app.post('/files/:id/restore', async (c) => {
    const scope = await scopeOf(c, resolveSpace);
    const body = personFileRestore.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      throw new ServiceError('invalid_request', 'Name the trash to restore from.', 400);
    const found = await oneRecord(db, scope, c.req.param('id'));
    if (!found || browserStep(found)) throw noFile();
    let target: { place: TrashPlace; path: string };
    try {
      target = await trashFor(roots, scope.spaceId, found);
    } catch {
      throw noFile();
    }
    let restored: Awaited<ReturnType<typeof restoreFromTrash>>;
    try {
      // Only the latest delete that took this file: never another file's trash.
      const latest = await latestTrash(target.place, target.path);
      if (latest?.id !== body.data.trash_id) throw noFile();
      restored = await restoreFromTrash(target.place, body.data.trash_id);
    } catch {
      throw new ServiceError('not_found', 'There is nothing in the trash to put back.', 404);
    }
    if (!restored.restored.includes(target.path))
      throw new ServiceError(
        'file_not_restored',
        `The file was not put back${restored.kept[0] ? `: ${restored.kept[0].reason}` : ''}.`,
        409,
      );
    return c.json(personFileRestored.parse({ id: found.id, restored: true }));
  });
}
