/**
 * The Apps screen's routes: the apps a person can open, one app with its
 * versions and grants, and the changes a manager makes from the screen.
 *
 * These are the person's own actions in their own session, so none of them
 * asks first. An app the person cannot open answers as if it did not exist,
 * and one they can open but do not manage refuses changes.
 */
import {
  type AppDetail,
  type AppManifest,
  type AppRole,
  type AppSummary,
  appCurrentRequest,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appId as appIdSchema,
  appListResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import {
  AppUnavailable,
  appRoleFor,
  type DesiredGrant,
  deleteApp,
  replaceGrants,
  setCurrentVersion,
} from './service.ts';

const notFound = () => new ServiceError('not_found', 'No such app.', 404);
const notManager = () =>
  new ServiceError('forbidden', 'Only someone who manages this app can change it.', 403);

type AppRow = {
  id: string;
  name: string;
  description: string | null;
  publisher_id: string;
  publisher_email: string;
  created_at: Date;
  updated_at: Date;
  version_id: string | null;
  version_created_at: Date | null;
  version_file_count: number | null;
  version_total_bytes: number | null;
  version_by_id: string | null;
  version_by_email: string | null;
  role: AppRole;
};

const iso = (value: Date | string) => new Date(value).toISOString();

function summary(row: AppRow): AppSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    publisher: { id: row.publisher_id, email: row.publisher_email },
    role: row.role,
    current_version:
      row.version_id && row.version_created_at
        ? {
            id: row.version_id,
            created_at: iso(row.version_created_at),
            created_by:
              row.version_by_id && row.version_by_email
                ? { id: row.version_by_id, email: row.version_by_email }
                : null,
            file_count: Number(row.version_file_count ?? 0),
            total_bytes: Number(row.version_total_bytes ?? 0),
          }
        : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Each app the principal can open, with what they may do with it. */
async function visibleApps(sql: Sql, principalId: string, appId?: string): Promise<AppRow[]> {
  return sql<AppRow[]>`select * from (
      select a.id, a.name, a.description, a.created_at, a.updated_at,
        p.id as publisher_id, p.email as publisher_email,
        v.id as version_id, v.created_at as version_created_at,
        v.file_count as version_file_count, v.total_bytes as version_total_bytes,
        vb.id as version_by_id, vb.email as version_by_email,
        case
          when a.publisher_principal_id = ${principalId} then 'manage'
          when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
            and g.role = 'manage' and g.grantee_kind = 'principal'
            and g.grantee_id = ${principalId}) then 'manage'
          when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
            and ((g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
              or g.grantee_kind = 'installation')) then 'view'
          else null end as role
      from app a
      join space s on s.id = a.space_id
      join principal p on p.id = a.publisher_principal_id
      join app_version v on v.id = a.current_version_id
      left join principal vb on vb.id = v.created_by
      where a.status = 'active' and s.removed_at is null
        and (${appId ?? null}::text is null or a.id = ${appId ?? null})
    ) visible
    where role is not null
    order by updated_at desc, id`;
}

type ChangedPaths = AppDetail['versions'] extends (infer V)[] | null
  ? V extends { changes: infer C }
    ? C
    : never
  : never;

const PATH_LIST_LIMIT = 50;

function changesBetween(before: AppManifest | null, after: AppManifest): ChangedPaths {
  const old = before?.files ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, file] of Object.entries(after.files)) {
    const previous = old[path];
    if (!previous) added.push(path);
    else if (previous.sha256 !== file.sha256) changed.push(path);
  }
  for (const path of Object.keys(old)) if (!after.files[path]) removed.push(path);
  const cut = (list: string[]) => list.sort().slice(0, PATH_LIST_LIMIT);
  return {
    added: cut(added),
    removed: cut(removed),
    changed: cut(changed),
    truncated: [added, removed, changed].some((list) => list.length > PATH_LIST_LIMIT),
  };
}

export type AppRoutesDeps = { sql: Sql };

export function mountApps(app: Hono, deps: AppRoutesDeps): void {
  const { sql } = deps;
  const principalOf = (c: Context): string => {
    const id = c.get('owner')?.id as string | undefined;
    if (!id) throw notFound();
    return id;
  };
  const appIdOf = (c: Context): string => {
    const parsed = appIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) throw notFound();
    return parsed.data;
  };
  const requireRole = async (c: Context, wanted: 'view' | 'manage') => {
    const principalId = principalOf(c);
    const appId = appIdOf(c);
    const role = await appRoleFor(sql, appId, principalId);
    if (!role) throw notFound();
    if (wanted === 'manage' && role !== 'manage') throw notManager();
    return { principalId, appId, role };
  };

  const detail = async (principalId: string, appId: string): Promise<AppDetail> => {
    const [row] = await visibleApps(sql, principalId, appId);
    if (!row?.version_id) throw notFound();
    const [current] = await sql<{ manifest: AppManifest }[]>`select manifest from app_version
      where id = ${row.version_id}`;
    const manifest = current?.manifest;
    if (!manifest) throw notFound();
    const manager = row.role === 'manage';
    let versions: AppDetail['versions'] = null;
    let grants: AppDetail['grants'] = null;
    if (manager) {
      const rows = await sql<
        {
          id: string;
          manifest: AppManifest;
          created_at: Date;
          file_count: number;
          total_bytes: number;
          by_id: string | null;
          by_email: string | null;
        }[]
      >`select v.id, v.manifest, v.created_at, v.file_count, v.total_bytes,
          p.id as by_id, p.email as by_email
        from app_version v left join principal p on p.id = v.created_by
        where v.app_id = ${appId} order by v.created_at asc, v.id asc`;
      let before: AppManifest | null = null;
      const listed: NonNullable<AppDetail['versions']> = [];
      for (const version of rows) {
        listed.push({
          id: version.id,
          created_at: iso(version.created_at),
          created_by:
            version.by_id && version.by_email
              ? { id: version.by_id, email: version.by_email }
              : null,
          file_count: Number(version.file_count),
          total_bytes: Number(version.total_bytes),
          current: version.id === row.version_id,
          changes: changesBetween(before, version.manifest),
        });
        before = version.manifest;
      }
      versions = listed.reverse();
      const granted = await sql<
        {
          grantee_kind: string;
          grantee_id: string;
          role: AppRole;
          created_at: Date;
          email: string | null;
        }[]
      >`select g.grantee_kind, g.grantee_id, g.role, g.created_at, p.email
        from app_grant g
        left join principal p on g.grantee_kind = 'principal' and p.id = g.grantee_id
        where g.app_id = ${appId} and g.revoked_at is null
        order by g.created_at, g.id`;
      grants = granted.flatMap((grant): NonNullable<AppDetail['grants']> => {
        if (grant.grantee_kind === 'installation')
          return [{ kind: 'installation', role: 'view', granted_at: iso(grant.created_at) }];
        if (grant.grantee_kind === 'principal' && grant.email)
          return [
            {
              kind: 'principal',
              principal: { id: grant.grantee_id, email: grant.email },
              role: grant.role,
              granted_at: iso(grant.created_at),
            },
          ];
        return [];
      });
    }
    return appDetail.parse({
      app: summary(row),
      files: Object.entries(manifest.files)
        .map(([path, file]) => ({ path, size: file.size, mime: file.mime }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      data: Object.entries(manifest.data).map(([name, binding]) => ({
        name,
        kind: binding.kind,
        path: binding.path,
      })),
      collections: Object.entries(manifest.collections).map(([name, collection]) => ({
        name,
        max_bytes: collection.max_bytes,
      })),
      versions,
      grants,
    });
  };

  app.get('/apps', async (c) => {
    const rows = await visibleApps(sql, principalOf(c));
    return c.json(appListResponse.parse({ apps: rows.map(summary) }));
  });

  app.get('/apps/:id', async (c) => {
    const { principalId, appId } = await requireRole(c, 'view');
    return c.json(await detail(principalId, appId));
  });

  app.post('/apps/:id/current', async (c) => {
    const { principalId, appId } = await requireRole(c, 'manage');
    const input = appCurrentRequest.parse(await c.req.json());
    try {
      await sql.begin((tx) => setCurrentVersion(tx, appId, input.version_id));
    } catch (error) {
      if (error instanceof AppUnavailable)
        throw new ServiceError('not_found', 'That version is not one of this app.', 404);
      throw error;
    }
    return c.json(await detail(principalId, appId));
  });

  app.put('/apps/:id/grants', async (c) => {
    const { principalId, appId } = await requireRole(c, 'manage');
    const input = appGrantsRequest.parse(await c.req.json());
    const emails = [
      ...new Set(
        input.grants.flatMap((grant) =>
          grant.kind === 'principal' ? [grant.email.trim().toLowerCase()] : [],
        ),
      ),
    ];
    const accounts = emails.length
      ? await sql<{ id: string; email: string }[]>`select id, lower(email) as email
          from principal where lower(email) = any(${emails})`
      : [];
    const byEmail = new Map(accounts.map((row) => [row.email, row.id]));
    const missing = emails.filter((email) => !byEmail.has(email));
    if (missing.length)
      throw new ServiceError(
        'invalid_request',
        `No account here for ${missing.join(', ')}. Apps open only for people with an account on this installation.`,
        400,
      );
    const [owner] = await sql<{ publisher_principal_id: string }[]>`select publisher_principal_id
      from app where id = ${appId}`;
    const desired: DesiredGrant[] = [];
    const seen = new Set<string>();
    for (const grant of input.grants) {
      if (grant.kind === 'installation') {
        if (!seen.has('installation')) desired.push({ kind: 'installation', role: 'view' });
        seen.add('installation');
        continue;
      }
      const id = byEmail.get(grant.email.trim().toLowerCase()) as string;
      // The publisher always manages their own app; a grant to them would say nothing.
      if (id === owner?.publisher_principal_id || seen.has(id)) continue;
      seen.add(id);
      desired.push({ kind: 'principal', id, role: grant.role });
    }
    await sql.begin(async (tx) => {
      const [row] =
        await tx`select 1 from app where id = ${appId} and status = 'active' for update`;
      if (!row) throw notFound();
      await replaceGrants(tx, appId, desired, principalId);
    });
    return c.json(await detail(principalId, appId));
  });

  app.delete('/apps/:id', async (c) => {
    const { principalId, appId } = await requireRole(c, 'manage');
    const [row] = await sql<{ publisher_principal_id: string }[]>`select publisher_principal_id
      from app where id = ${appId}`;
    if (row?.publisher_principal_id !== principalId)
      throw new ServiceError(
        'forbidden',
        'Only the person who published this app can delete it.',
        403,
      );
    if (!(await deleteApp(sql, appId))) throw notFound();
    return c.json(appDeleted.parse({ id: appId, deleted: true }));
  });
}
