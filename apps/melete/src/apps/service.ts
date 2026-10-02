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
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
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
import { noLinks, segmentsFor } from '../connectors/files.ts';
import { newId } from '../ids.ts';
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
  const base = await realpath(workRoot);
  let root: string;
  try {
    root = await noLinks(base, [jobId, ...segments], false);
    const stat = await lstat(root);
    if (!stat.isDirectory()) throw new Error('not a folder');
  } catch {
    throw new BundleRefused(`${dir} is not a folder in this conversation's workspace`);
  }

  type Found = { path: string; full: string; size: number };
  const found: Found[] = [];
  const problems: string[] = [];
  let total = 0;
  const walk = async (folder: string, prefix: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(folder, entry.name);
      // Checked again with lstat: the entry type is what readdir saw, and a
      // link must be refused whatever it points at.
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        problems.push(`${relative} is a link; copy the file in instead`);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full, relative);
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
      found.push({ path: relative, full, size: stat.size });
      if (found.length > APP_LIMITS.max_files) return;
    }
  };
  await walk(root, '');
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
  for (const file of found) {
    const handle = await open(file.full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > APP_LIMITS.max_file_bytes)
        throw new BundleRefused(`${file.path} changed while it was being read; publish again`);
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength > APP_LIMITS.max_file_bytes)
        throw new BundleRefused(`${file.path} changed while it was being read; publish again`);
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
 */
export async function replaceGrants(
  tx: TransactionSql,
  appId: string,
  desired: readonly DesiredGrant[],
  grantedBy: string | null,
): Promise<boolean> {
  const wanted = new Map(
    desired.map((grant) => {
      const row = {
        kind: grant.kind,
        id: grant.kind === 'installation' ? 'installation' : grant.id,
        role: grant.role,
      };
      return [grantKey(row), row];
    }),
  );
  const live = await tx<{ id: string; grantee_kind: string; grantee_id: string; role: string }[]>`
    select id, grantee_kind, grantee_id, role from app_grant
    where app_id = ${appId} and revoked_at is null for update`;
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
        await tx`insert into app_version (id, app_id, manifest_hash, manifest, file_count,
            total_bytes, job_id, action_id, created_by)
          values (${versionId}, ${input.appId}, ${input.manifestHash},
            ${tx.json(input.manifest as never)}, ${input.files.length},
            ${manifestBytes(input.manifest)}, ${input.jobId}, ${input.actionId}, ${input.publisherId})
          on conflict (id) do nothing`;
        await referenceBlobs(tx, store, stored, { kind: APP_VERSION_OWNER, id: versionId });
        await tx`update app set current_version_id = ${versionId}, name = ${input.name},
            description = ${input.description}, updated_at = now()
          where id = ${input.appId}`;
        if (input.grants) await replaceGrants(tx, input.appId, input.grants, input.publisherId);
        return { appId: input.appId, versionId, created, slug: row.slug };
      });
    } catch (error) {
      if (!(error instanceof BlobNotFound) || attempt > 0) throw error;
    }
  }
}

/** Point the app at one of its own versions. */
export async function setCurrentVersion(
  tx: TransactionSql,
  appId: string,
  versionId: string,
): Promise<void> {
  const [row] = await tx<
    { status: string }[]
  >`select status from app where id = ${appId} for update`;
  if (row?.status !== 'active') throw new AppUnavailable('no such app');
  const [version] =
    await tx`select 1 from app_version where id = ${versionId} and app_id = ${appId}`;
  if (!version) throw new AppUnavailable('that version is not one of this app');
  await tx`update app set current_version_id = ${versionId}, updated_at = now() where id = ${appId}`;
}

/**
 * Remove the app, its versions and its grants. The versions' references go
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
    await tx`delete from app where id = ${appId}`;
    return true;
  });
}

/** Every blob a manifest names. */
export function manifestKeys(manifest: AppManifest): BlobKey[] {
  return [...new Set(Object.values(manifest.files).map((file) => blobKey(file.sha256)))];
}

/**
 * What `principalId` may do with an app: manage it (its publisher, or a
 * manage grant), view it (a live grant to them or to everyone here), or
 * nothing, which is null. An app whose space is being removed, or that is not
 * active, is nothing to everyone.
 */
export async function appRoleFor(
  sql: Sql | TransactionSql,
  appId: string,
  principalId: string,
): Promise<AppRole | null> {
  const [row] = await sql<{ role: AppRole | null }[]>`select case
      when a.publisher_principal_id = ${principalId} then 'manage'
      when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
        and g.role = 'manage' and g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
        then 'manage'
      when exists (select 1 from app_grant g where g.app_id = a.id and g.revoked_at is null
        and ((g.grantee_kind = 'principal' and g.grantee_id = ${principalId})
          or g.grantee_kind = 'installation'))
        then 'view'
      else null end as role
    from app a join space s on s.id = a.space_id
    where a.id = ${appId} and a.status = 'active' and s.removed_at is null
      and a.current_version_id is not null`;
  return row?.role ?? null;
}
