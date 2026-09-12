import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { artifact, job } from '../db/schema.ts';
import { ServiceError } from './errors.ts';
import type { SpaceResolver } from './reactions.ts';

const notFound = () => new ServiceError('not_found', 'No such artifact.', 404);

async function readArtifact(root: string, spaceId: string, relative: string): Promise<Uint8Array> {
  const parts = relative.replace(/^artifacts\//, '').split('/');
  if (
    relative.length > 2048 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[<>:"\\|?*\p{Cc}]/u.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw notFound();
  let file = await realpath(root);
  for (const part of [spaceId, 'artifacts', ...parts]) {
    file = join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw notFound();
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  spacesRoot: string,
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
          or(isNull(artifact.jobId), eq(job.spaceId, scope.spaceId)),
        ),
      );
    if (!row) throw notFound();
    let bytes: Uint8Array;
    try {
      bytes = await readArtifact(spacesRoot, scope.spaceId, row.artifact.path);
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
