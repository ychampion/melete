import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, realpath } from 'node:fs/promises';
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { ArtifactRoots } from '../artifact/content.ts';
import { FILE_TOOLS, fileHeaders, mimeForName, savedFile } from '../artifact/shown.ts';
import { noLinks, openBeneath, segmentsFor } from '../connectors/files.ts';
import type { Database } from '../db/client.ts';
import { action, artifact, job } from '../db/schema.ts';
import { ownJob, spaceAuthority } from '../principals/authority.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { ServiceError } from './errors.ts';
import type { SpaceResolver } from './reactions.ts';

const notFound = () => new ServiceError('not_found', 'No such artifact.', 404);

export type Stored = Pick<typeof artifact.$inferSelect, 'area' | 'path' | 'jobId' | 'sourceJobId'>;

/**
 * Where a recorded file is, inside one of the space's own areas and nowhere
 * else. A declared write names its area and the job whose workspace holds it:
 * `work` is that job's folder, `artifacts` the space's folder. A file recorded
 * without a job (generated audio, a browser capture) is in the space's
 * artifacts folder, and some of those name the folder in their path.
 */
export function artifactLocation(
  roots: ArtifactRoots,
  spaceId: string,
  row: Stored,
): { job: string; segments: string[] } | { root: string; segments: string[] } {
  if (!/^sp_[A-Za-z0-9]+$/.test(spaceId) || (row.area !== 'work' && row.area !== 'artifacts'))
    throw notFound();
  const work = row.area === 'work' && row.sourceJobId !== null;
  // Only the job the route checked against this space and person: never
  // another job's workspace, and nothing once the job itself is gone.
  if (work && (row.jobId !== row.sourceJobId || !/^job_[A-Za-z0-9]+$/.test(row.jobId ?? '')))
    throw notFound();
  const relative = row.sourceJobId === null ? row.path.replace(/^artifacts\//, '') : row.path;
  if (relative.length > 2048 || /[<>"|?*\p{Cc}]/u.test(relative)) throw notFound();
  let segments: string[];
  try {
    // The files connector's own rule: relative, no dot segments, no device names.
    segments = segmentsFor(relative);
  } catch {
    throw notFound();
  }
  if (!segments.length) throw notFound();
  return work
    ? { job: row.sourceJobId as string, segments }
    : { root: roots.spacesRoot, segments: [spaceId, 'artifacts', ...segments] };
}

/**
 * The most the files route serves. A file the agent's computer could rewrite
 * after its receipt is refused above this before a byte of it is read, so a
 * file swapped for a huge or sparse one costs nothing.
 */
export const MAX_SERVED_BYTES = 256 * 1024 * 1024;
const CHUNK = 64 * 1024;

/** A stored file opened for reading, with the size it had when opened. */
type Opened = { handle: FileHandle; size: number };

export async function openArtifact(
  roots: ArtifactRoots,
  spaceId: string,
  row: Stored,
): Promise<Opened> {
  const location = artifactLocation(roots, spaceId, row);
  // Every component is checked, so a link anywhere on the way is refused.
  const { base, segments } =
    'job' in location
      ? await new LocalWorkspaceFs(roots.workRoot).location(location.job, location.segments)
      : { base: await realpath(location.root), segments: location.segments };
  await noLinks(base, segments, false);
  // Opened by walking the names, so a folder swapped for a link since the check opens nothing.
  const handle = await openBeneath(base, segments, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw notFound();
    return { handle, size: stat.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** What a stored file must still be: its size when known, its digest, and the most read. */
type Expected = { size: number | null; hash: string; max: number };

/**
 * Whether the open file is still the one recorded. Its size is checked before
 * any read; its digest is then taken a chunk at a time, never the whole file in
 * memory, and reading stops once it passes the size it had when opened.
 */
async function matches(opened: Opened, expected: Expected): Promise<boolean> {
  if (opened.size > expected.max || (expected.size !== null && opened.size !== expected.size))
    return false;
  const digest = createHash('sha256');
  const buffer = new Uint8Array(CHUNK);
  let read = 0;
  while (read <= opened.size) {
    const { bytesRead } = await opened.handle.read(buffer, 0, CHUNK, read);
    if (!bytesRead) break;
    digest.update(buffer.subarray(0, bytesRead));
    read += bytesRead;
  }
  return read === opened.size && digest.digest('hex') === expected.hash;
}

/** Opens a stored file and checks it is still the recorded one, or closes it and refuses. */
async function verified(
  open: () => Promise<Opened>,
  expected: Expected,
  refuse: () => ServiceError,
): Promise<Opened> {
  let opened: Opened;
  try {
    opened = await open();
  } catch {
    throw refuse();
  }
  const ok = await matches(opened, expected).catch(() => false);
  if (!ok) {
    await opened.handle.close();
    throw refuse();
  }
  return opened;
}

function rangeFor(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start < size && start <= end ? { start, end } : null;
}

/**
 * A file one of a room's requests made, when this person is in that room now.
 * A room's request belongs to the room's principal, so the job rule above never
 * shows it to a person; this is the one route that does, for the room's people.
 */
async function roomArtifact(db: Database, id: string, principalId: string) {
  const [row] = await db
    .select({ artifact })
    .from(artifact)
    .innerJoin(job, eq(artifact.jobId, job.id))
    .where(and(eq(artifact.id, id), eq(job.spaceId, artifact.spaceId), eq(job.audience, 'room')));
  if (!row) return null;
  const access = await spaceAuthority(db, row.artifact.spaceId, principalId).catch(
    (error: unknown) => {
      if (error instanceof ServiceError) return null;
      throw error;
    },
  );
  return access && access.space.kind === 'shared' && access.role !== 'agent' ? row : null;
}

const noFile = () =>
  new ServiceError('not_found', 'This file is no longer the one that was saved.', 404);

/** Bytes `start` to `end` of the open file, read as they are sent. The file closes after. */
function streamOf(handle: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(CHUNK, end + 1 - position);
        const buffer = new Uint8Array(Math.max(length, 0));
        const { bytesRead } =
          length > 0 ? await handle.read(buffer, 0, length, position) : { bytesRead: 0 };
        if (!bytesRead) {
          await handle.close();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await handle.close().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await handle.close();
    },
  });
}

/** Sends the open file, or the range asked for, without holding it in memory. Takes over the handle. */
async function fileResponse(
  opened: Opened,
  options: { mime: string; name: string; inline: boolean; range: string | undefined },
): Promise<Response> {
  const { handle, size } = opened;
  const headers = fileHeaders(options.mime, options.name, options.inline);
  if (options.range) {
    const range = rangeFor(options.range, size);
    if (!range) {
      await handle.close();
      headers.set('content-range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('content-length', String(range.end - range.start + 1));
    return new Response(streamOf(handle, range.start, range.end), { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(streamOf(handle, 0, size - 1), { headers });
}

export function mountArtifacts(
  app: Hono,
  db: Database,
  roots: ArtifactRoots,
  resolveSpace: SpaceResolver,
): void {
  app.get('/artifacts/:id/content', async (c) => {
    const resolved = await resolveSpace(c);
    const id = prefixedId(ID_PREFIXES.artifact).safeParse(c.req.param('id'));
    if (!id.success) throw notFound();
    const scope =
      resolved && prefixedId(ID_PREFIXES.space).safeParse(resolved.spaceId).success
        ? resolved
        : null;
    // A guest has no space of their own: the only files they read are their rooms'.
    const viewer = scope ? scope.principalId : c.get('owner')?.id;
    if (!scope && !viewer) throw notFound();
    const [row] = scope
      ? await db
          .select({ artifact })
          .from(artifact)
          .leftJoin(job, eq(artifact.jobId, job.id))
          .where(
            and(
              eq(artifact.id, id.data),
              eq(artifact.spaceId, scope.spaceId),
              // A job's files follow the job: private to its principal, also in a shared space.
              or(
                isNull(artifact.jobId),
                and(
                  eq(job.spaceId, scope.spaceId),
                  scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
                ),
              ),
            ),
          )
      : [];
    // A file a room's request made belongs to the room: the people in the room
    // read it, checked now, and nobody else. Every other file follows its job.
    const found = row ?? (viewer ? await roomArtifact(db, id.data, viewer) : null);
    if (!found) throw notFound();
    const opened = await verified(
      () => openArtifact(roots, found.artifact.spaceId, found.artifact),
      { size: found.artifact.size, hash: found.artifact.contentHash, max: Number.MAX_SAFE_INTEGER },
      notFound,
    );
    return fileResponse(opened, {
      mime: found.artifact.mime,
      name: found.artifact.path.split('/').at(-1) ?? 'artifact',
      inline: c.req.query('disposition') === 'inline',
      range: c.req.header('range'),
    });
  });

  /**
   * A file one of the person's own conversations saved or moved with the
   * files tools: into their Files, or into the conversation's workspace. Only
   * the job's own principal, in the space the session names, gets it, and
   * only while it is still the content the receipt recorded.
   */
  app.get('/files/:id/content', async (c) => {
    const scope = await resolveSpace(c);
    const id = prefixedId(ID_PREFIXES.action).safeParse(c.req.param('id'));
    if (!scope || !id.success || !prefixedId(ID_PREFIXES.space).safeParse(scope.spaceId).success)
      throw noFile();
    const [row] = await db
      .select({ action, job })
      .from(action)
      .innerJoin(job, eq(action.jobId, job.id))
      .where(
        and(
          eq(action.id, id.data),
          eq(action.status, 'succeeded'),
          inArray(action.kind, [...FILE_TOOLS]),
          eq(job.spaceId, scope.spaceId),
          scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
        ),
      );
    const saved = row ? savedFile(row.action.kind, row.action.receipt) : null;
    if (!row || !saved) throw noFile();
    const opened = await verified(
      () =>
        openArtifact(roots, row.job.spaceId, {
          area: saved.area,
          path: saved.path,
          jobId: row.job.id,
          sourceJobId: row.job.id,
        }),
      { size: null, hash: saved.contentHash, max: MAX_SERVED_BYTES },
      noFile,
    );
    const name = saved.path.split('/').at(-1) ?? 'file';
    return fileResponse(opened, {
      mime: mimeForName(name),
      name,
      inline: c.req.query('disposition') === 'inline',
      range: c.req.header('range'),
    });
  });
}
