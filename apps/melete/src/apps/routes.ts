/**
 * The Apps screen's routes: the apps a person can open, one app with its
 * versions and grants, and the changes a manager makes from the screen.
 *
 * These are the person's own actions in their own session, so none of them
 * asks first. An app the person cannot open answers as if it did not exist,
 * and one they can open but do not manage refuses changes.
 */
import {
  APP_LIMITS,
  type AppDetail,
  type AppManifest,
  type AppRole,
  type AppSummary,
  appBindingName,
  appCurrentRequest,
  appDataReleaseRequest,
  appDataUpdates,
  appDataValue,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appId as appIdSchema,
  appListResponse,
  appSubmissionAccepted,
  appSubmissionDeleted,
  appSubmissionList,
  appSubmissionMine,
  appSubmissionRequest,
  appSubmissionsDeleted,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { type ArtifactRoots, defaultArtifactRoots } from '../artifact/content.ts';
import type { BlobStore } from '../storage/blob.ts';
import {
  type DataDeps,
  DataUnavailable,
  dataUpdates,
  dataWaiting,
  ReleaseRefused,
  readData,
  releaseData,
} from './data.ts';
import {
  AppUnavailable,
  appRoleFor,
  appRoleSql,
  type DesiredGrant,
  deleteApp,
  ownsApp,
  replaceGrants,
  setCurrentVersion,
} from './service.ts';
import {
  deleteSubmission,
  deleteSubmissionsFrom,
  listSubmissions,
  mySubmission,
  SubmissionRefused,
  submit,
} from './submissions.ts';

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
        ${appRoleSql(sql, principalId)} as role
      from app a
      join space s on s.id = a.space_id
      join principal p on p.id = a.publisher_principal_id
      join app_version v on v.id = a.current_version_id
      left join principal vb on vb.id = v.created_by
      where a.status = 'active' and s.removed_at is null
        and (${appId ?? null}::text is null or a.id = ${appId ?? null})
        -- Only apps this person could have any role in are looked at.
        and (a.publisher_principal_id = ${principalId} or s.owner_principal_id = ${principalId}
          or exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
            and ((g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
              or g.grantee_kind = 'installation')))
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

export type AppRoutesDeps = {
  sql: Sql;
  /** Where data versions let through to viewers are kept. */
  blobs?: BlobStore;
  /** Where the conversations' workspaces are, to read the files data names. */
  roots?: ArtifactRoots;
};

/** The largest request body a response may arrive in, well above its record's limit. */
const SUBMISSION_BODY_BYTES = 4 * APP_LIMITS.max_collection_record_bytes;
const SUBMISSION_ID = /^asub_[0-9A-Z]{26}$/;

export function mountApps(app: Hono, deps: AppRoutesDeps): void {
  const { sql } = deps;
  const data: DataDeps = {
    sql,
    roots: deps.roots ?? defaultArtifactRoots(),
    ...(deps.blobs ? { blobs: deps.blobs } : {}),
  };
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

  const isOwner = (appId: string, principalId: string) => ownsApp(sql, appId, principalId);

  /** The app's space and its current version's manifest. */
  const currentOf = async (appId: string) => {
    const [row] = await sql<{ space_id: string; manifest: AppManifest }[]>`select a.space_id,
        v.manifest from app a join app_version v on v.id = a.current_version_id
      where a.id = ${appId}`;
    if (!row) throw notFound();
    return { app: { id: appId, space_id: row.space_id }, manifest: row.manifest };
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
        review: binding.review === true,
      })),
      data_waiting: (await isOwner(appId, principalId))
        ? await dataWaiting(sql, (await currentOf(appId)).app, manifest)
        : null,
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
    const ownerAsks = await isOwner(appId, principalId);
    await sql.begin(async (tx) => {
      const [row] =
        await tx`select 1 from app where id = ${appId} and status = 'active' for update`;
      if (!row) throw notFound();
      // Who manages the app is its owner's to change; other managers change who views it.
      if (!ownerAsks) {
        const managers = await tx<{ grantee_id: string }[]>`select grantee_id from app_grant
          where app_id = ${appId} and revoked_at is null and role = 'manage'
          order by grantee_id`;
        const asked = desired
          .flatMap((grant) =>
            grant.kind === 'principal' && grant.role === 'manage' ? [grant.id] : [],
          )
          .sort();
        if (managers.map((manager) => manager.grantee_id).join() !== asked.join())
          throw new ServiceError(
            'forbidden',
            'Only the person who published this app, or the owner of its space, can change who manages it.',
            403,
          );
      }
      await replaceGrants(tx, appId, desired, principalId);
    });
    return c.json(await detail(principalId, appId));
  });

  app.delete('/apps/:id', async (c) => {
    const { principalId, appId } = await requireRole(c, 'manage');
    if (!(await isOwner(appId, principalId)))
      throw new ServiceError(
        'forbidden',
        'Only the person who published this app, or the owner of its space, can delete it.',
        403,
      );
    if (!(await deleteApp(sql, appId))) throw notFound();
    return c.json(appDeleted.parse({ id: appId, deleted: true }));
  });
  app.get('/apps/:id/data/:name', async (c) => {
    const { appId } = await requireRole(c, 'view');
    const name = appBindingName.safeParse(c.req.param('name'));
    if (!name.success)
      throw new ServiceError('not_found', 'This app has no data by that name.', 404);
    const { app: found, manifest } = await currentOf(appId);
    let value: Awaited<ReturnType<typeof readData>>;
    try {
      value = await readData(data, found, manifest, name.data);
    } catch (error) {
      if (error instanceof DataUnavailable) throw new ServiceError('conflict', error.message, 409);
      throw error;
    }
    if (!value) throw new ServiceError('not_found', 'This app has no data by that name.', 404);
    return c.json(appDataValue.parse(value));
  });

  /** The publisher while they belong to the space, or the space's owner. */
  const requireOwner = async (c: Context) => {
    const found = await requireRole(c, 'view');
    if (!(await isOwner(found.appId, found.principalId)))
      throw new ServiceError(
        'forbidden',
        'Only the person who published this app, or the owner of its space, can review its data.',
        403,
      );
    return found;
  };

  const waiting = async (appId: string) => {
    const { app: found, manifest } = await currentOf(appId);
    return appDataUpdates.parse({ updates: await dataUpdates(data, found, manifest) });
  };

  app.get('/apps/:id/data-updates', async (c) => {
    const { appId } = await requireOwner(c);
    return c.json(await waiting(appId));
  });

  app.post('/apps/:id/data-updates', async (c) => {
    const { appId, principalId } = await requireOwner(c);
    const input = appDataReleaseRequest.parse(await c.req.json());
    const blobs = data.blobs;
    if (!blobs) throw new Error('releasing app data needs a blob store');
    try {
      await releaseData(
        { ...data, blobs },
        {
          appId,
          name: input.binding,
          artifactId: input.artifact_id,
          principalId,
          allowed: (tx) => ownsApp(tx, appId, principalId),
        },
      );
    } catch (error) {
      if (error instanceof ReleaseRefused)
        throw new ServiceError(
          error.status === 409 ? 'conflict' : error.status === 403 ? 'forbidden' : 'not_found',
          error.message,
          error.status,
        );
      throw error;
    }
    return c.json(await waiting(appId));
  });

  app.post('/apps/:id/submissions', async (c) => {
    const { appId, principalId } = await requireRole(c, 'view');
    const tooLarge = () =>
      new ServiceError('payload_too_large', 'This response is too large.', 413);
    if (Number(c.req.header('content-length') ?? 0) > SUBMISSION_BODY_BYTES) throw tooLarge();
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > SUBMISSION_BODY_BYTES) throw tooLarge();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ServiceError('invalid_request', 'A response is a JSON object.', 400);
    }
    const parsed = appSubmissionRequest.safeParse(body);
    if (!parsed.success)
      throw new ServiceError(
        'invalid_request',
        'A response names a collection and carries a record object.',
        400,
      );
    try {
      const stored = await submit(sql, {
        appId,
        principalId,
        collection: parsed.data.collection,
        record: parsed.data.record,
        ...(parsed.data.replace ? { replace: true } : {}),
      });
      return c.json(appSubmissionAccepted.parse(stored));
    } catch (error) {
      if (!(error instanceof SubmissionRefused)) throw error;
      const code = {
        400: 'invalid_request',
        404: 'not_found',
        413: 'payload_too_large',
        429: 'rate_limited',
      }[error.status];
      throw new ServiceError(code, error.message, error.status);
    }
  });

  // What the app kept for this viewer, read back when it opens.
  app.get('/apps/:id/submissions/mine', async (c) => {
    const { appId, principalId } = await requireRole(c, 'view');
    const collection = c.req.query('collection');
    if (collection === undefined || !appBindingName.safeParse(collection).success)
      throw new ServiceError('invalid_request', 'No collection by that name.', 400);
    try {
      return c.json(
        appSubmissionMine.parse(await mySubmission(sql, { appId, principalId, collection })),
      );
    } catch (error) {
      if (!(error instanceof SubmissionRefused)) throw error;
      throw new ServiceError(
        error.status === 404 ? 'not_found' : 'invalid_request',
        error.message,
        error.status,
      );
    }
  });

  app.get('/apps/:id/submissions', async (c) => {
    const { appId } = await requireRole(c, 'manage');
    const collection = c.req.query('collection');
    const before = c.req.query('before');
    if (collection !== undefined && !appBindingName.safeParse(collection).success)
      throw new ServiceError('invalid_request', 'No collection by that name.', 400);
    if (before !== undefined && !SUBMISSION_ID.test(before))
      throw new ServiceError('invalid_request', 'Not a response id.', 400);
    const page = await listSubmissions(sql, appId, {
      collection: collection ?? null,
      before: before ?? null,
    });
    return c.json(appSubmissionList.parse(page));
  });

  app.delete('/apps/:id/submissions', async (c) => {
    const { appId, principalId } = await requireRole(c, 'manage');
    const from = c.req.query('from');
    if (!from || from.length > 200)
      throw new ServiceError('invalid_request', 'Name whose responses to delete.', 400);
    const deleted = await deleteSubmissionsFrom(sql, appId, from, principalId);
    return c.json(appSubmissionsDeleted.parse({ from, deleted }));
  });

  app.delete('/apps/:id/submissions/:submission_id', async (c) => {
    const { appId, principalId } = await requireRole(c, 'manage');
    const id = c.req.param('submission_id');
    if (!SUBMISSION_ID.test(id) || !(await deleteSubmission(sql, appId, id, principalId)))
      throw new ServiceError('not_found', 'No such response.', 404);
    return c.json(appSubmissionDeleted.parse({ id, deleted: true }));
  });
}
