/**
 * Apps: reading a bundle from a conversation's workspace, recording a version
 * of it, and deciding who may open or change an app.
 *
 * A version's files are blobs. They are stored again from the bytes on disk at
 * the moment of publishing, never named by a hash someone supplied, so a
 * version can only ever hold bytes the publishing conversation actually had.
 * Each version refers to its blobs (`blob_ref` owner kind `app_version`), and
 * the space a reference belongs to is read from the app the version belongs to.
 */

import { constants } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import {
  APP_ENTRY,
  APP_LIMITS,
  type AppManifest,
  type AppRole,
  appFileType,
  appManifest,
  canonicalizePayload,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { heldDirectories, holdBeneath, openBeneath, segmentsFor } from '../connectors/files.ts';
import { newId } from '../ids.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import {
  type BlobKey,
  BlobNotFound,
  type BlobStore,
  blobKey,
  type StoredBlob,
} from '../storage/blob.ts';
import { defineBlobOwner, referenceBlobs, releaseBlob } from '../storage/refs.ts';

/** The blob owner kind a version's files are referred to by. */
export const APP_VERSION_OWNER = 'app_version';

defineBlobOwner(APP_VERSION_OWNER, async (tx, versionId) => {
  const [row] = await tx<{ space_id: string }[]>`select a.space_id from app_version v
    join app a on a.id = v.app_id where v.id = ${versionId}`;
  return row?.space_id ?? null;
});

/** A bundle that cannot be published as it is. The message says why, in words the agent can act on. */
export class BundleRefused extends Error {
  readonly code = 'bundle_refused';
}

export type BundleFile = {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
  mime: string;
};

const sha256Hex = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

const KB = 1024;
const MB = 1024 * KB;
export function byteText(bytes: number): string {
  if (bytes < KB) return `${bytes} bytes`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Every file under `dir` in the job's workspace, checked against the bundle
 * rules before any of them is read: no links anywhere on the way, only
 * regular files and folders, allowed types only, within the size and count
 * limits, and an `index.html` at the top. A refusal lists what to fix.
 */
export async function readBundle(
  workRoot: string,
  jobId: string,
  dir: string,
): Promise<BundleFile[]> {
  if (!/^job_[A-Za-z0-9]+$/.test(jobId)) throw new Error('invalid trusted file scope');
  let segments: string[];
  try {
    segments = segmentsFor(dir);
  } catch {
    throw new BundleRefused(`${dir} is not a folder in this conversation's workspace`);
  }
  // Every folder is held open from the job's workspace down, never looked up by
  // name again: a folder swapped for a link mid-walk is refused, not followed.
  const { base, segments: top } = await new LocalWorkspaceFs(workRoot).location(jobId, segments);
  try {
    await (await holdBeneath(base, top)).close();
  } catch {
    throw new BundleRefused(`${dir} is not a folder in this conversation's workspace`);
  }

  type Found = { path: string; size: number };
  const found: Found[] = [];
  const problems: string[] = [];
  let total = 0;
  // Folders count too, so a tree of empty folders cannot make the walk long.
  let visited = 0;
  const folders = heldDirectories(base);
  const walk = async (inside: string[], depth: number): Promise<void> => {
    const prefix = inside.join('/');
    if (depth > MAX_DEPTH) {
      problems.push(`${prefix} is more than ${MAX_DEPTH} folders deep`);
      return;
    }
    let names: string[];
    try {
      const held = await folders.at([...top, ...inside]);
      names = (await readdir(held.self)).sort();
    } catch {
      problems.push(`${prefix || dir} changed while it was being read`);
      return;
    }
    visited += names.length;
    if (visited > MAX_ENTRIES) {
      problems.push(`the folder has more than ${MAX_ENTRIES} files and folders`);
      return;
    }
    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        // Named through the held folder, so a link is seen as a link wherever it points.
        stat = await lstat((await folders.at([...top, ...inside])).at(name));
      } catch {
        problems.push(`${relative} changed while it was being read`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        problems.push(`${relative} is a link; copy the file in instead`);
        continue;
      }
      if (stat.isDirectory()) {
        await walk([...inside, name], depth + 1);
        if (visited > MAX_ENTRIES) return;
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`${relative} is not a regular file`);
        continue;
      }
      try {
        segmentsFor(relative);
      } catch {
        problems.push(`${relative} has a name that cannot be served`);
        continue;
      }
      if (relative.length > 512) {
        problems.push(`${relative.slice(0, 80)}… has a path longer than 512 characters`);
        continue;
      }
      if (!appFileType(relative)) problems.push(`${relative} is not an allowed file type`);
      if (stat.size > APP_LIMITS.max_file_bytes)
        problems.push(
          `${relative} is ${byteText(stat.size)}, over the ${byteText(APP_LIMITS.max_file_bytes)} a file may be`,
        );
      total += stat.size;
      found.push({ path: relative, size: stat.size });
      if (found.length > APP_LIMITS.max_files) return;
    }
  };
  try {
    await walk([], 0);
  } finally {
    await folders.close();
  }
  if (found.length > APP_LIMITS.max_files)
    problems.push(`the folder has more than ${APP_LIMITS.max_files} files`);
  if (total > APP_LIMITS.max_total_bytes)
    problems.push(`the files come to more than ${byteText(APP_LIMITS.max_total_bytes)} together`);
  if (!found.some((file) => file.path === APP_ENTRY))
    problems.push(`there is no ${APP_ENTRY} at the top of ${dir}`);
  if (problems.length)
    throw new BundleRefused(
      `This app cannot be published yet: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}. Allowed types: html, js, mjs, css, json, svg, png, jpg, jpeg, gif, webp, ico, woff2, txt, map, wasm.`,
    );

  const files: BundleFile[] = [];
  const changed = (file: Found) =>
    new BundleRefused(`${file.path} changed while it was being read; publish again`);
  for (const file of found) {
    // Opened beneath the workspace root one held folder at a time, never through
    // a link, and never waiting on something that is not a file.
    const handle = await openBeneath(
      base,
      [...top, ...file.path.split('/')],
      constants.O_RDONLY,
    ).catch(() => {
      throw changed(file);
    });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > APP_LIMITS.max_file_bytes) throw changed(file);
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength > APP_LIMITS.max_file_bytes) throw changed(file);
      files.push({
        path: file.path,
        bytes,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        mime: appFileType(file.path) as string,
      });
    } finally {
      await handle.close();
    }
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > APP_LIMITS.max_total_bytes)
    throw new BundleRefused('the files changed while they were being read; publish again');
  return files;
}

const MAX_ENTRIES = 1_000;
const MAX_DEPTH = 32;

export function manifestFor(
  files: readonly BundleFile[],
  data: AppManifest['data'],
  collections: AppManifest['collections'],
): AppManifest {
  return appManifest.parse({
    entry: APP_ENTRY,
    files: Object.fromEntries(
      files.map((file) => [file.path, { sha256: file.sha256, size: file.size, mime: file.mime }]),
    ),
    data,
    collections,
  });
}

/** The sha256 of a manifest's canonical form: what a publish approval binds. */
export function manifestHash(manifest: AppManifest): string {
  return canonicalizePayload(manifest).hash;
}

/** A version is named by its app and its manifest, so the same bundle is one version per app. */
export function versionIdFor(appId: string, hash: string): string {
  return sha256Hex(new TextEncoder().encode(`${appId}\n${hash}`));
}

export function manifestBytes(manifest: AppManifest): number {
  return Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0);
}

/** Who may open the app besides its publisher, as a publish or the owner sets it. */
export type DesiredGrant =
  | { kind: 'principal'; id: string; role: AppRole }
  | { kind: 'installation'; role: 'view' };

const grantKey = (grant: { kind: string; id: string; role: string }) =>
  `${grant.kind}:${grant.id}:${grant.role}`;

/**
 * Make the app's live grants exactly `desired`. Grants that stay are left as
 * they are; the rest are revoked and the new ones added. Any change moves the
 * grant generation, which ends every open view made under the old list.
 *
 * With `viewersOnly`, as a publish sets who may open the app, only view grants
 * are replaced: the managers the publisher chose stay managers, and a manager
 * named among the viewers is not made a viewer.
 */
export async function replaceGrants(
  tx: TransactionSql,
  appId: string,
  desired: readonly DesiredGrant[],
  grantedBy: string | null,
  viewersOnly = false,
): Promise<boolean> {
  const all = await tx<{ id: string; grantee_kind: string; grantee_id: string; role: string }[]>`
    select id, grantee_kind, grantee_id, role from app_grant
    where app_id = ${appId} and revoked_at is null for update`;
  const managers = new Set(
    all
      .filter((row) => row.role === 'manage')
      .map((row) => `${row.grantee_kind}:${row.grantee_id}`),
  );
  const live = viewersOnly ? all.filter((row) => row.role === 'view') : all;
  const kept = viewersOnly
    ? desired.filter(
        (grant) =>
          grant.role === 'view' &&
          !managers.has(
            `${grant.kind}:${grant.kind === 'installation' ? 'installation' : grant.id}`,
          ),
      )
    : desired;
  const wanted = new Map(
    kept.map((grant) => {
      const row = {
        kind: grant.kind,
        id: grant.kind === 'installation' ? 'installation' : grant.id,
        role: grant.role,
      };
      return [grantKey(row), row];
    }),
  );
  let changed = false;
  for (const row of live) {
    const key = grantKey({ kind: row.grantee_kind, id: row.grantee_id, role: row.role });
    if (wanted.has(key)) {
      wanted.delete(key);
      continue;
    }
    await tx`update app_grant set revoked_at = now() where id = ${row.id}`;
    changed = true;
  }
  for (const grant of wanted.values()) {
    await tx`insert into app_grant (id, app_id, grantee_kind, grantee_id, role, granted_by)
      values (${newId('apg')}, ${appId}, ${grant.kind}, ${grant.id}, ${grant.role}, ${grantedBy})`;
    changed = true;
  }
  if (changed)
    await tx`update app set grant_generation = grant_generation + 1, updated_at = now()
      where id = ${appId}`;
  return changed;
}

/** A name a person can type into an address, unique among the space's apps. */
async function freeSlug(tx: TransactionSql, spaceId: string, name: string): Promise<string> {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'app';
  await tx`select pg_advisory_xact_lock(hashtextextended(${`app-slug:${spaceId}`}, 0))`;
  const taken = new Set(
    (
      await tx<{ slug: string }[]>`select slug from app where space_id = ${spaceId}
        and (slug = ${base} or slug like ${`${base}-%`})`
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export type PublishInput = {
  appId: string;
  /** True when this publish makes the app; false when it adds a version to one that exists. */
  create: boolean;
  spaceId: string;
  name: string;
  description: string | null;
  /** The person the app is published as. */
  publisherId: string;
  files: readonly BundleFile[];
  manifest: AppManifest;
  manifestHash: string;
  jobId: string;
  actionId: string;
  /** Null leaves an existing app's grants as they are. */
  grants: readonly DesiredGrant[] | null;
  /**
   * Run under the app's row lock, after the person's role is checked and
   * before anything is written: throwing stops the publish with nothing stored
   * in the database.
   */
  recheck?: (tx: TransactionSql) => Promise<void>;
};

export type Published = { appId: string; versionId: string; created: boolean; slug: string };

export class AppUnavailable extends Error {
  readonly code = 'app_unavailable';
}

/**
 * Store the files, record the version, point the app at it and set its
 * grants, all or nothing. The files are stored first, outside the
 * transaction; a blob collected between storing and referring is stored again
 * once.
 */
export async function publishVersion(
  sql: Sql,
  store: BlobStore,
  input: PublishInput,
): Promise<Published> {
  const versionId = versionIdFor(input.appId, input.manifestHash);
  for (let attempt = 0; ; attempt++) {
    const stored: StoredBlob[] = [];
    for (const file of input.files)
      stored.push(await store.put(file.bytes, { sha256: file.sha256 }));
    try {
      return await sql.begin(async (tx) => {
        let created = false;
        if (input.create) {
          const [exists] = await tx`select 1 from app where id = ${input.appId}`;
          if (!exists) {
            const slug = await freeSlug(tx, input.spaceId, input.name);
            await tx`insert into app (id, space_id, slug, name, description, publisher_principal_id)
              values (${input.appId}, ${input.spaceId}, ${slug}, ${input.name},
                ${input.description}, ${input.publisherId})`;
            created = true;
          }
        }
        const [row] = await tx<
          { space_id: string; status: string; slug: string }[]
        >`select space_id, status, slug from app where id = ${input.appId} for update`;
        if (!row || row.space_id !== input.spaceId || row.status !== 'active')
          throw new AppUnavailable('the app is no longer there to publish to');
        if (!created && (await appRoleFor(tx, input.appId, input.publisherId)) !== 'manage')
          throw new AppUnavailable('the person this publishes as no longer manages the app');
        // Checked again under this app's lock, which a change to its grants also takes.
        await input.recheck?.(tx);
        await tx`insert into app_version (id, app_id, manifest_hash, manifest, file_count,
            total_bytes, job_id, action_id, created_by)
          values (${versionId}, ${input.appId}, ${input.manifestHash},
            ${JSON.stringify(input.manifest)}::jsonb, ${input.files.length},
            ${manifestBytes(input.manifest)}, ${input.jobId}, ${input.actionId}, ${input.publisherId})
          on conflict (id) do nothing`;
        await referenceBlobs(tx, store, stored, { kind: APP_VERSION_OWNER, id: versionId });
        // A description is kept unless a new one was approved.
        await tx`update app set current_version_id = ${versionId}, name = ${input.name},
            description = coalesce(${input.description}, description),
            last_action_id = ${input.actionId}, updated_at = now()
          where id = ${input.appId}`;
        if (input.grants)
          await replaceGrants(tx, input.appId, input.grants, input.publisherId, true);
        return { appId: input.appId, versionId, created, slug: row.slug };
      });
    } catch (error) {
      if (!(error instanceof BlobNotFound) || attempt > 0) throw error;
    }
  }
}

/** Point the app at one of its own versions, recording the action that asked, if one did. */
export async function setCurrentVersion(
  tx: TransactionSql,
  appId: string,
  versionId: string,
  actionId: string | null = null,
): Promise<void> {
  const [row] = await tx<
    { status: string }[]
  >`select status from app where id = ${appId} for update`;
  if (row?.status !== 'active') throw new AppUnavailable('no such app');
  const [version] =
    await tx`select 1 from app_version where id = ${versionId} and app_id = ${appId}`;
  if (!version) throw new AppUnavailable('that version is not one of this app');
  await tx`update app set current_version_id = ${versionId}, last_action_id = ${actionId},
    updated_at = now() where id = ${appId}`;
}

/**
 * Whether `principalId` speaks for the app as its owner: its publisher while
 * they belong to its space, or the space's owner. Only they change who
 * manages it, delete it, or let a reviewed data version through.
 */
export async function ownsApp(
  q: Sql | TransactionSql,
  appId: string,
  principalId: string,
): Promise<boolean> {
  const [row] = await q<{ owner: boolean }[]>`select (s.owner_principal_id = ${principalId}
      or (a.publisher_principal_id = ${principalId} and exists (
        select 1 from space_membership m where m.space_id = a.space_id
          and m.principal_id = ${principalId} and m.revoked_at is null))) as owner
    from app a join space s on s.id = a.space_id
    where a.id = ${appId} and s.removed_at is null`;
  return row?.owner === true;
}

/**
 * Remove the app, its versions, grants, responses and released data. The references go
 * with them, so blobs nothing else uses are collected after the grace period.
 */
export async function deleteApp(sql: Sql, appId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx`select 1 from app where id = ${appId} for update`;
    if (!row) return false;
    const versions = await tx<{ id: string; manifest: AppManifest }[]>`
      select id, manifest from app_version where app_id = ${appId}`;
    for (const version of versions)
      for (const file of Object.values(version.manifest.files))
        await releaseBlob(tx, blobKey(file.sha256), { kind: APP_VERSION_OWNER, id: version.id });
    // Data versions let through to viewers are kept as blobs too.
    const releases = await tx<{ id: string; content_hash: string }[]>`
      select id, content_hash from app_data_release where app_id = ${appId}`;
    for (const release of releases)
      await releaseBlob(tx, blobKey(release.content_hash), {
        kind: 'app_data_release',
        id: release.id,
      });
    await tx`delete from app where id = ${appId}`;
    return true;
  });
}

/**
 * The bundle's script and page files that use WebRTC or the camera and
 * microphone, by the names those use. A sandboxed page can still open WebRTC
 * connections to a server of its choosing, which no header in today's
 * browsers stops, so the person is told before publishing. This reads names,
 * not behaviour: code that hides them is not found, and the warning is
 * advice, never a guarantee.
 */
const WEBRTC = /RTCPeerConnection|RTCDataChannel|getUserMedia/;
const SCRIPT_OR_PAGE = /\.(?:js|mjs|html?)$/i;
const MAX_NAMED = 10;

export function webrtcUse(files: readonly BundleFile[]): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return files
    .filter((file) => SCRIPT_OR_PAGE.test(file.path) && WEBRTC.test(decoder.decode(file.bytes)))
    .map((file) => file.path)
    .sort()
    .slice(0, MAX_NAMED);
}

/**
 * `webrtcUse` over a version already stored: its pages and scripts are read
 * back from the blob store, each checked against its hash as it is read.
 */
export async function storedWebrtcUse(blobs: BlobStore, manifest: AppManifest): Promise<string[]> {
  const files: BundleFile[] = [];
  for (const [filePath, file] of Object.entries(manifest.files)) {
    if (!SCRIPT_OR_PAGE.test(filePath)) continue;
    const bytes = new Uint8Array(
      await new Response(await blobs.get(blobKey(file.sha256))).arrayBuffer(),
    );
    files.push({ path: filePath, bytes, sha256: file.sha256, size: file.size, mime: file.mime });
  }
  return webrtcUse(files);
}

/** Every blob a manifest names. */
export function manifestKeys(manifest: AppManifest): BlobKey[] {
  return [...new Set(Object.values(manifest.files).map((file) => blobKey(file.sha256)))];
}

/**
 * What `principalId` may do with app `a` in space `s`, as a SQL expression:
 * - manage: the space's owner; the publisher while they still belong to the
 *   space; anyone with a manage grant;
 * - view: a live grant to them, or to everyone here;
 * - otherwise null.
 */
export function appRoleSql(q: Sql | TransactionSql, principalId: string) {
  return q`case
      when s.owner_principal_id = ${principalId} then 'manage'
      when a.publisher_principal_id = ${principalId} and exists (
        select 1 from space_membership m where m.space_id = a.space_id
          and m.principal_id = ${principalId} and m.revoked_at is null) then 'manage'
      when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
        and g.role = 'manage' and g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
        then 'manage'
      when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
        and ((g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
          or g.grantee_kind = 'installation'))
        then 'view'
      else null end`;
}

/**
 * Who besides `actor` could open app `appId` once a publish or a rollback has
 * run, by the same rules as appRoleSql: the space's owner, the publisher while
 * they still belong to the space, a manage grant, a view grant or a grant to
 * everyone here. Each is named by their account's address, and a grant to
 * everyone as "everyone with an account here". With `viewGrantsKept` false (a
 * publish to `only_me`, which takes back view grants) only manage grants count
 * among the grants; the space's owner and the publisher keep their access
 * whatever the publish says. A change to who may open an app goes through
 * appRoleSql and here together, so the two cannot drift apart.
 */
export async function othersWhoCanOpen(
  sql: Sql | TransactionSql,
  appId: string,
  actor: string,
  viewGrantsKept: boolean,
): Promise<string[]> {
  const [app] = await sql`select 1 from app where id = ${appId}`;
  // An app that cannot be found is treated as open to others: the question is asked.
  if (!app) return ['people Melete could not list'];
  const rows = await sql<{ who: string | null; everyone: boolean }[]>`
    select p.email as who, false as everyone from app a join space s on s.id = a.space_id
      join principal p on p.id = s.owner_principal_id
      where a.id = ${appId} and s.owner_principal_id <> ${actor}
    union
    select p.email, false from app a join principal p on p.id = a.publisher_principal_id
      where a.id = ${appId} and a.publisher_principal_id <> ${actor} and exists (
        select 1 from space_membership m where m.space_id = a.space_id
          and m.principal_id = a.publisher_principal_id and m.revoked_at is null)
    union
    select p.email, g.grantee_kind = 'installation' from app_grant g
      left join principal p on g.grantee_kind = 'principal' and p.id = g.grantee_id
      where g.app_id = ${appId} and g.revoked_at is null
        and not (g.grantee_kind = 'principal' and g.grantee_id = ${actor})
        and (${viewGrantsKept} or g.role = 'manage')`;
  const named = new Set<string>();
  for (const row of rows)
    named.add(row.everyone ? 'everyone with an account here' : (row.who ?? 'someone else here'));
  return [...named].sort();
}

/**
 * What `principalId` may do with an app (see appRoleSql), or null for
 * nothing. An app whose space is being removed, or that is not active, is
 * nothing to everyone.
 */
export async function appRoleFor(
  sql: Sql | TransactionSql,
  appId: string,
  principalId: string,
): Promise<AppRole | null> {
  const [row] = await sql<{ role: AppRole | null }[]>`select ${appRoleSql(sql, principalId)} as role
    from app a join space s on s.id = a.space_id
    where a.id = ${appId} and a.status = 'active' and s.removed_at is null
      and a.current_version_id is not null`;
  return row?.role ?? null;
}
