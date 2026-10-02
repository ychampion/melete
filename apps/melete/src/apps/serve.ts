/**
 * Opening an app: a view for the person asking, and the files the view loads.
 *
 * `POST /apps/:id/views` is the person's own request in their own session. It
 * answers with a path that carries a view token (viewer/tokens.ts). The Apps
 * screen frames that path in a sandboxed iframe, and the page loads each of
 * its files from beside it.
 *
 * `GET /apps/view/:token/:path` reads no session: the page asking has an
 * opaque origin and holds none. On every request it checks the token's
 * signature and expiry, that the app still shows the token's version, that
 * the grant generation has not moved, and that the person may still open the
 * app. Then it serves the one file the version's manifest names at that path,
 * after reading it whole and checking its hash, with the isolation headers
 * (viewer/headers.ts). A browser asking for a file as a page of its own,
 * rather than in a frame, is refused, so a page can never run outside the
 * frame Melete draws around it.
 */
import { type AppManifest, appId as appIdSchema, appView } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { type BlobStore, blobKey } from '../storage/blob.ts';
import { framedRequest, VIEW_PREFIX, viewHeaders } from '../viewer/headers.ts';
import type { ViewTokens } from '../viewer/tokens.ts';
import { appRoleSql } from './service.ts';

export type AppViewDeps = { sql: Sql; blobs?: BlobStore; tokens: ViewTokens };

const ended = () =>
  new ServiceError('not_found', 'This view has ended. Open the app again from Melete.', 404);

type Viewable = {
  version_id: string;
  grant_generation: number;
  manifest: AppManifest;
  role: string | null;
};

/** The app's current version and grant generation, and the person's role in it, or null. */
async function viewable(sql: Sql, appId: string, principalId: string): Promise<Viewable | null> {
  const [row] = await sql<Viewable[]>`select v.id as version_id, a.grant_generation,
      v.manifest, ${appRoleSql(sql, principalId)} as role
    from app a
    join space s on s.id = a.space_id
    join app_version v on v.id = a.current_version_id
    where a.id = ${appId} and a.status = 'active' and s.removed_at is null`;
  return row?.role ? row : null;
}

export function mountAppViews(app: Hono, deps: AppViewDeps): void {
  const { sql, blobs, tokens } = deps;

  app.post('/apps/:id/views', async (c: Context) => {
    const principalId = c.get('owner')?.id as string | undefined;
    const parsed = appIdSchema.safeParse(c.req.param('id'));
    if (!principalId || !parsed.success) throw new ServiceError('not_found', 'No such app.', 404);
    const found = await viewable(sql, parsed.data, principalId);
    if (!found) throw new ServiceError('not_found', 'No such app.', 404);
    const { token, expiresAt } = tokens.issue({
      principalId,
      appId: parsed.data,
      versionId: found.version_id,
      grantGeneration: Number(found.grant_generation),
    });
    return c.json(
      appView.parse({
        view_path: `${VIEW_PREFIX}${token}/${found.manifest.entry}`,
        version_id: found.version_id,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      }),
    );
  });

  app.get(`${VIEW_PREFIX}:token/:path{.+}`, async (c) => {
    if (!framedRequest(c.req.header('sec-fetch-dest')))
      throw new ServiceError('forbidden', 'Open this app from Melete.', 403);
    const claims = tokens.verify(c.req.param('token'));
    if (!claims) throw ended();
    const found = await viewable(sql, claims.appId, claims.principalId);
    if (
      !found ||
      found.version_id !== claims.versionId ||
      Number(found.grant_generation) !== claims.grantGeneration
    )
      throw ended();
    const path = c.req.param('path');
    const file = Object.hasOwn(found.manifest.files, path) ? found.manifest.files[path] : undefined;
    if (!file) throw new ServiceError('not_found', 'This app has no such file.', 404);
    if (!blobs) throw new Error('app files need a blob store');
    // Read whole and checked before a byte is sent: the store errors on bytes
    // that do not hash to the key, so a changed file is a 500, never served.
    const bytes = new Uint8Array(
      await new Response(await blobs.get(blobKey(file.sha256))).arrayBuffer(),
    );
    if (bytes.byteLength !== file.size)
      throw new Error('an app file is not the size its manifest says');
    return new Response(c.req.method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: viewHeaders(file.mime),
    });
  });
}
