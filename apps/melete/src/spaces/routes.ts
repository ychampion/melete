/**
 * The surface a person removes a space through, and nothing else reaches.
 *
 * Two mechanisms keep this away from a model, both of them structural rather
 * than a rule written down somewhere. Nothing generates it: a model's tools
 * come solely from connector manifests, and removal is not a connector and has
 * no manifest, so no granted catalog can contain it. And nothing admits it:
 * every effect a model asks for becomes an action row bound to a connection,
 * and removal creates no action. It is a service method behind a route that
 * requires an owner's session.
 *
 * Authorization is the guard `mountPrincipals` already installs on every
 * non-GET under `/spaces/:id`, which is why these routes are mounted after it.
 * The service checks the same thing again, so it is not safe only by virtue of
 * where it is mounted.
 */
import {
  deleteSpaceRequest,
  type RemovalProvider,
  removalPreviewCounts,
  spaceRemovalPreview,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { space } from '../db/schema.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { previewCopy, reportFor } from './copy.ts';
import { removalView, type SpaceRemovalService } from './removal.ts';

export type SpaceRemovalRoutes = {
  db: Database;
  sql: Sql;
  removals: SpaceRemovalService;
};

export function mountSpaceRemoval(app: Hono, deps: SpaceRemovalRoutes): void {
  const { db, sql, removals } = deps;

  /** What is in the space, and what removing it will not reach. Counts first. */
  app.get('/spaces/:id/removal/preview', async (c) => {
    const spaceId = c.req.param('id');
    const parent = await ownedSpace(db, spaceId, c.get('owner').id);
    const providers = await providersFor(sql, spaceId);
    const kind = parent.kind === 'personal' ? ('emptied' as const) : ('removed' as const);
    return c.json({
      preview: spaceRemovalPreview.parse({
        space_id: parent.id,
        name: parent.name,
        kind,
        counts: removalPreviewCounts.parse(await previewCounts(sql, spaceId)),
        providers,
        ...previewCopy(parent.name, kind, providers),
      }),
    });
  });

  /**
   * The fence runs inside this request, so either it is committed and the
   * removal has started, or the call failed and nothing changed. The sweep
   * that follows is reported through the route below.
   */
  app.delete('/spaces/:id', async (c) => {
    const request = deleteSpaceRequest.parse(await c.req.json());
    const row = await removals.fence(c.get('owner').id, c.req.param('id'), request.confirm_name);
    removals.dispatch(row.id);
    return c.json({ removal: removalView(row) }, 202);
  });

  /** Where the removal has got to, while there is still a space to ask about. */
  app.get('/spaces/:id/removal', async (c) => {
    const row = await removals.current(c.req.param('id'));
    if (!row) throw new ServiceError('not_found', 'This space is not being removed.', 404);
    const view = removalView(row);
    return c.json({ removal: view, report: reportFor(view, row.providers) });
  });

  /**
   * And after it. A finished removal has no space left to hang a route off, so
   * the record answers for itself, to the person who asked for it: the row
   * keeps who that was, which is the whole of the authority needed here. It is
   * not under `/spaces/:id`, so the guard there does not apply and this one
   * does its own.
   */
  app.get('/removals/:id', async (c) => {
    const row = await removals.byId(c.req.param('id'));
    if (!row || row.requestedBy !== c.get('owner').id)
      throw new ServiceError('not_found', 'Removal not found.', 404);
    const view = removalView(row);
    return c.json({ removal: view, report: reportFor(view, row.providers) });
  });
}

async function ownedSpace(db: Database, spaceId: string, actor: string) {
  const access = await spaceAuthority(db, spaceId, actor);
  if (access.role !== 'owner')
    throw new ServiceError('scope_denied', 'Space administration requires its owner.', 403);
  const [row] = await db.select().from(space).where(eq(space.id, spaceId));
  if (!row) throw new ServiceError('not_found', 'Space not found.', 404);
  return row;
}

async function providersFor(sql: Sql, spaceId: string): Promise<RemovalProvider[]> {
  const rows = await sql<{ provider: string; label: string }[]>`select distinct provider, label
    from connection where space_id = ${spaceId} order by provider, label`;
  return rows.map((row) => ({ provider: row.provider, label: row.label }));
}

/**
 * Counted from the live tables rather than from a cached figure, because the
 * number a person is shown before they type a name has to be the real one.
 */
async function previewCounts(sql: Sql, spaceId: string) {
  const [row] = await sql<Record<string, number>[]>`select
    (select count(*)::int from job where space_id = ${spaceId}) as jobs,
    (select count(*)::int from memory_claims where space_id = ${spaceId}) as memory_claims,
    (select count(*)::int from knowledge_record
      where space_id = ${spaceId} and status = 'active') as knowledge_files,
    (select count(*)::int from artifact where space_id = ${spaceId}) as artifacts,
    (select count(*)::int from connection where space_id = ${spaceId}) as connections,
    (select count(*)::int from company where space_id = ${spaceId}) as companies,
    (select count(*)::int from ledger_item where space_id = ${spaceId}) as ledger_items`;
  return {
    jobs: Number(row?.jobs ?? 0),
    memory_claims: Number(row?.memory_claims ?? 0),
    knowledge_files: Number(row?.knowledge_files ?? 0),
    artifacts: Number(row?.artifacts ?? 0),
    connections: Number(row?.connections ?? 0),
    companies: Number(row?.companies ?? 0),
    ledger_items: Number(row?.ledger_items ?? 0),
    // Both live on lanes that have not landed. Counted when their table is
    // there, and honestly zero when it is not.
    signed_in_sites: await countIfPresent(sql, 'browser_site_profile', spaceId),
    sandboxes: await countIfPresent(sql, 'sandbox_session', spaceId),
  };
}

async function countIfPresent(sql: Sql, table: string, spaceId: string): Promise<number> {
  const [present] = await sql<
    { there: boolean }[]
  >`select to_regclass(${`public.${table}`}) is not null as there`;
  if (!present?.there) return 0;
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count
    from ${sql(table)} where space_id = ${spaceId}`;
  return Number(row?.count ?? 0);
}
