/**
 * A screenshot's picture in the person's own trail.
 *
 * The person always sees what was taken for them: the agent's own computer,
 * and their paired computer's screen too, whatever that computer lets cloud
 * models see. Only the job's own principal, in the space the session names,
 * gets it; anyone else, an action that is not a succeeded screenshot, or a
 * picture that is no longer the one recorded gets a 404.
 */
import { ID_PREFIXES, prefixedId } from '@melete/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { readScreenshot, SCREENSHOT_TOOLS } from '../broker/screenshots.ts';
import type { Database } from '../db/client.ts';
import { action, job } from '../db/schema.ts';
import { ownJob } from '../principals/authority.ts';
import { ServiceError } from './errors.ts';
import type { SpaceResolver } from './reactions.ts';

const notFound = () => new ServiceError('not_found', 'No such screenshot.', 404);

export function mountScreenshots(
  app: Hono,
  db: Database,
  workRoot: string,
  resolveSpace: SpaceResolver,
): void {
  app.get('/screenshots/:id', async (c) => {
    const scope = await resolveSpace(c);
    const id = prefixedId(ID_PREFIXES.action).safeParse(c.req.param('id'));
    if (!scope || !id.success || !prefixedId(ID_PREFIXES.space).safeParse(scope.spaceId).success)
      throw notFound();
    const [row] = await db
      .select({ action })
      .from(action)
      .innerJoin(job, eq(action.jobId, job.id))
      .where(
        and(
          eq(action.id, id.data),
          eq(action.status, 'succeeded'),
          inArray(action.kind, [...SCREENSHOT_TOOLS]),
          eq(job.spaceId, scope.spaceId),
          scope.principalId ? ownJob(job.principalId, scope.principalId) : undefined,
        ),
      );
    if (!row) throw notFound();
    const bytes = await readScreenshot(workRoot, {
      id: row.action.id,
      job_id: row.action.jobId,
      kind: row.action.kind,
      status: row.action.status,
      receipt: row.action.receipt as { detail?: unknown } | null,
    });
    if (!bytes) throw notFound();
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline; filename="screenshot.png"',
      },
    });
  });
}
