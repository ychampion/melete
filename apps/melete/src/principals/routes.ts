import {
  createPrincipalRequest,
  createSharedSpaceRequest,
  grantMembershipRequest,
  space as spaceContract,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  action,
  approval,
  backgroundOperation,
  connection,
  notification,
  owner,
  question,
  replyObligation,
} from '../db/schema.ts';
import type { JobService } from '../jobs/service.ts';
import { requireJobAccess, spaceAuthority } from './authority.ts';
import { PrincipalService } from './service.ts';

/** Resource IDs and space headers select a resource; authenticated membership authorizes it. */
export function mountPrincipals(
  app: Hono,
  db: Database | null,
  spacesRoot: string,
  jobs?: JobService,
) {
  if (!db) return;
  const service = new PrincipalService(db, spacesRoot, jobs);
  app.use('*', async (c, next) => {
    if (['/health', '/setup', '/login'].includes(c.req.path)) return next();
    const actor = c.get('owner').id;
    const path = c.req.path;
    const parts = path.split('/').filter(Boolean);
    const resource = parts[0];
    const id = parts[1];
    const method = c.req.method;
    const headerSpace = c.req.header('x-melete-space');
    const querySpace = c.req.query('space_id');
    if (headerSpace) await spaceAuthority(db, headerSpace, actor);
    if (querySpace) await spaceAuthority(db, querySpace, actor);
    const queryJob = c.req.query('job_id');
    if (queryJob) await requireJobAccess(db, queryJob, actor);
    if (resource === 'jobs' && id) await requireJobAccess(db, id, actor);
    if (resource === 'spaces' && id && id !== 'shared') {
      const access = await spaceAuthority(db, id, actor);
      if (method !== 'GET' && access.role !== 'owner')
        throw new ServiceError('scope_denied', 'Space administration requires its owner.', 403);
    }
    if (resource === 'connections' && id) {
      const [row] = await db.select().from(connection).where(eq(connection.id, id));
      if (!row || (await spaceAuthority(db, row.spaceId, actor)).role !== 'owner')
        throw new ServiceError('scope_denied', 'Connection is not accessible.', 403);
    }
    if (resource === 'approvals' && id) {
      const [row] = await db
        .select({ jobId: action.jobId })
        .from(approval)
        .innerJoin(action, eq(action.id, approval.actionId))
        .where(eq(approval.id, id));
      if (!row) throw new ServiceError('not_found', 'Approval not found.', 404);
      await requireJobAccess(db, row.jobId, actor);
    }
    if (
      id &&
      ['operations', 'notifications', 'reply-obligations', 'questions'].includes(resource ?? '')
    ) {
      const table =
        resource === 'operations'
          ? backgroundOperation
          : resource === 'notifications'
            ? notification
            : resource === 'reply-obligations'
              ? replyObligation
              : question;
      const [row] = await db.select({ jobId: table.jobId }).from(table).where(eq(table.id, id));
      if (row?.jobId) await requireJobAccess(db, row.jobId, actor);
      else if (resource === 'questions') {
        const [entry] = await db.select().from(question).where(eq(question.id, id));
        if (!entry?.spaceId || (await spaceAuthority(db, entry.spaceId, actor)).role !== 'owner')
          throw new ServiceError('scope_denied', 'Question is not accessible.', 403);
      } else throw new ServiceError('scope_denied', 'Resource is not accessible.', 403);
    }
    if (path.startsWith('/internal/')) {
      const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
      if (installation?.id !== actor)
        throw new ServiceError(
          'scope_denied',
          'Internal administration requires the setup owner.',
          403,
        );
    }
    return next();
  });

  app.post('/principals', async (c) => {
    const request = createPrincipalRequest.parse(await c.req.json());
    return c.json(
      { principal: await service.create(c.get('owner').id, request.email, request.password) },
      201,
    );
  });
  app.post('/spaces/shared', async (c) => {
    const request = createSharedSpaceRequest.parse(await c.req.json());
    const row = await service.createShared(c.get('owner').id, request.name);
    if (!row) throw new Error('Space insert returned no row');
    return c.json(
      {
        space: spaceContract.parse({
          id: row.id,
          name: row.name,
          kind: row.kind,
          audience: row.audience,
          owner_principal_id: row.ownerPrincipalId,
          git_path: row.gitPath,
          created_at: row.createdAt.toISOString(),
        }),
      },
      201,
    );
  });
  app.post('/spaces/:id/memberships', async (c) => {
    const request = grantMembershipRequest.parse(await c.req.json());
    return c.json(
      {
        membership: await service.grant(c.get('owner').id, c.req.param('id'), request.principal_id),
      },
      201,
    );
  });
  app.delete('/spaces/:id/memberships/:principalId', async (c) =>
    c.json(await service.revoke(c.get('owner').id, c.req.param('id'), c.req.param('principalId'))),
  );
}
