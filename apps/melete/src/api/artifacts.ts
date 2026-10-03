import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { ArtifactRoots } from '../artifact/content.ts';
import { noLinks, openBeneath, segmentsFor } from '../connectors/files.ts';
import type { Database } from '../db/client.ts';
import { artifact, job } from '../db/schema.ts';
import { ownJob } from '../principals/authority.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { ServiceError } from './errors.ts';
import type { SpaceResolver } from './reactions.ts';

const notFound = () => new ServiceError('not_found', 'No such artifact.', 404);

type Stored = Pick<typeof artifact.$inferSelect, 'area' | 'path' | 'jobId' | 'sourceJobId'>;

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

async function readArtifact(
  roots: ArtifactRoots,
  spaceId: string,
  row: Stored,
): Promise<Uint8Array> {
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
    if (!(await handle.stat()).isFile()) throw notFound();
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
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

export function mountArtifacts(
  app: Hono,
  db: Database,
  roots: ArtifactRoots,
  resolveSpace: SpaceResolver,
): void {
  app.get('/artifacts/:id/content', async (c) => {
    const scope = await resolveSpace(c);
    const id = prefixedId(ID_PREFIXES.artifact).safeParse(c.req.param('id'));
    if (!scope || !id.success || !prefixedId(ID_PREFIXES.space).safeParse(scope.spaceId).success)
      throw notFound();
    const [row] = await db
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
      );
    if (!row) throw notFound();
    let bytes: Uint8Array;
    try {
      bytes = await readArtifact(roots, scope.spaceId, row.artifact);
    } catch {
      throw notFound();
    }
    if (
      bytes.length !== row.artifact.size ||
      createHash('sha256').update(bytes).digest('hex') !== row.artifact.contentHash
    )
      throw notFound();
    const headers = new Headers({
      'content-type': row.artifact.mime,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-disposition': `${row.artifact.mime.startsWith('audio/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(row.artifact.path.split('/').at(-1) ?? 'artifact')}"`,
    });
    const requested = c.req.header('range');
    if (requested) {
      const range = rangeFor(requested, bytes.length);
      if (!range) {
        headers.set('content-range', `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`);
      headers.set('content-length', String(range.end - range.start + 1));
      return new Response(Uint8Array.from(bytes.subarray(range.start, range.end + 1)), {
        status: 206,
        headers,
      });
    }
    headers.set('content-length', String(bytes.length));
    return new Response(Uint8Array.from(bytes), { headers });
  });
}
