/**
 * The data an app shows: the newest version of a file one of its publisher's
 * conversations wrote, read at the moment a viewer asks.
 *
 * A data binding names a file and the conversation that writes it. Every
 * write of a checked file in a conversation records a new artifact row with
 * the hash of its bytes (artifact/record.ts), so "the newest version" is the
 * newest row for that file, and the bytes served are exactly the bytes that
 * row records. A routine that rewrites the file keeps the app current without
 * a new version of the app.
 *
 * A binding reads only inside the app's own space: the row, and the
 * conversation it names, must both belong to the space the app was published
 * from, whatever a manifest says.
 *
 * When the publisher chose to review updates, viewers see only versions the
 * publisher let through. A version let through is kept as a blob, because the
 * file in the workspace moves on; its reference belongs to the release row
 * (owner kind `app_data_release`).
 */
import {
  APP_LIMITS,
  type AppDataBinding,
  type AppDataUpdate,
  type AppDataValue,
  type AppManifest,
  type JsonValue,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { type ArtifactRoots, readArtifactContent } from '../artifact/content.ts';
import { recordId } from '../broker/records.ts';
import { BlobNotFound, type BlobStore, blobKey, readBlob } from '../storage/blob.ts';
import { defineBlobOwner, referenceBlob } from '../storage/refs.ts';

/** The blob owner kind a released data version is referred to by. */
export const APP_DATA_RELEASE_OWNER = 'app_data_release';

defineBlobOwner(APP_DATA_RELEASE_OWNER, async (tx, releaseId) => {
  const [row] = await tx<{ space_id: string }[]>`select a.space_id from app_data_release r
    join app a on a.id = r.app_id where r.id = ${releaseId}`;
  return row?.space_id ?? null;
});

/** Data that cannot be served as it is. The message is for the person or the app's author. */
export class DataUnavailable extends Error {
  readonly code = 'data_unavailable';
}

type Query = Sql | TransactionSql;

/** One recorded version of a bound file. */
export type Recorded = {
  id: string;
  content_hash: string;
  size: number;
  created_at: Date;
};

/** The newest recorded version of a binding's file, in the app's own space only, or null. */
export async function newestRecorded(
  q: Query,
  spaceId: string,
  binding: AppDataBinding,
): Promise<Recorded | null> {
  const [row] = await q<Recorded[]>`select a.id, a.content_hash, a.size, a.created_at
    from artifact a join job j on j.id = a.source_job_id
    where a.space_id = ${spaceId} and j.space_id = ${spaceId}
      and a.source_job_id = ${binding.source_job_id} and a.job_id = ${binding.source_job_id}
      and a.area = 'work' and a.path = ${binding.path}
    order by a.created_at desc, a.id desc limit 1`;
  return row ?? null;
}

type Release = {
  id: string;
  artifact_id: string;
  content_hash: string;
  size: number;
  written_at: Date;
};

/** The newest version let through for this binding as it is now named, or null. */
async function newestRelease(
  q: Query,
  appId: string,
  name: string,
  binding: AppDataBinding,
): Promise<Release | null> {
  const [row] = await q<Release[]>`select id, artifact_id, content_hash, size, written_at
    from app_data_release
    where app_id = ${appId} and binding = ${name} and path = ${binding.path}
      and source_job_id = ${binding.source_job_id}
    order by approved_at desc, id desc limit 1`;
  return row ?? null;
}

const TEXT_FILE = /\.(?:txt|csv|tsv|md|markdown)$/i;

/** How a file's bytes are given to an app: JSON parsed, other text as a string. */
export function interpretData(
  path: string,
  bytes: Uint8Array,
): { format: 'json' | 'text'; value: JsonValue } {
  if (bytes.byteLength > APP_LIMITS.max_data_bytes)
    throw new DataUnavailable(
      `${path} is larger than the 2 MiB an app can read; write a smaller file for it.`,
    );
  const json = /\.json$/i.test(path);
  if (!json && !TEXT_FILE.test(path))
    throw new DataUnavailable(`${path} is not JSON or text, so an app cannot read it.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DataUnavailable(`${path} is not UTF-8 text, so an app cannot read it.`);
  }
  if (!json) return { format: 'text', value: text };
  try {
    return { format: 'json', value: JSON.parse(text) as JsonValue };
  } catch {
    throw new DataUnavailable(`${path} is not valid JSON in the version written last.`);
  }
}

/**
 * Bytes already read and checked, by their hash. A hash names its bytes, so
 * serving from here is serving the recorded version itself. Bounded by size.
 */
const CACHE_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, Uint8Array>();
let cached = 0;

function remember(hash: string, bytes: Uint8Array): void {
  if (bytes.byteLength > APP_LIMITS.max_data_bytes || cache.has(hash)) return;
  cache.set(hash, bytes);
  cached += bytes.byteLength;
  for (const [key, value] of cache) {
    if (cached <= CACHE_BYTES) break;
    cache.delete(key);
    cached -= value.byteLength;
  }
}

/**
 * A recorded version's bytes from the conversation's workspace. A file whose
 * bytes are no longer the ones recorded (written outside a checked write, and
 * not yet recorded again) is not served: only recorded versions are.
 */
async function recordedBytes(
  roots: ArtifactRoots,
  spaceId: string,
  binding: AppDataBinding,
  row: Recorded,
): Promise<Uint8Array> {
  const hit = cache.get(row.content_hash);
  if (hit) return hit;
  const content = await readArtifactContent(roots, {
    jobId: binding.source_job_id,
    spaceId,
    area: 'work',
    path: binding.path,
  }).catch(() => null);
  if (!content || content.hash !== row.content_hash)
    throw new DataUnavailable(
      `${binding.path} is being written; its newest version is not readable yet.`,
    );
  const bytes = new Uint8Array(content.bytes);
  remember(row.content_hash, bytes);
  return bytes;
}

async function releasedBytes(blobs: BlobStore, release: Release): Promise<Uint8Array> {
  const hit = cache.get(release.content_hash);
  if (hit) return hit;
  const bytes = await readBlob(blobs, blobKey(release.content_hash));
  remember(release.content_hash, bytes);
  return bytes;
}

export type DataDeps = { sql: Sql; blobs?: BlobStore; roots: ArtifactRoots };

const none = (name: string): AppDataValue => ({
  name,
  state: 'none',
  format: null,
  value: null,
  updated_at: null,
});

/** What a viewer of the app gets for one data name of its current version. */
export async function readData(
  deps: DataDeps,
  app: { id: string; space_id: string },
  manifest: AppManifest,
  name: string,
): Promise<AppDataValue | null> {
  const binding = Object.hasOwn(manifest.data, name) ? manifest.data[name] : undefined;
  if (!binding) return null;
  if (binding.review) {
    const release = await newestRelease(deps.sql, app.id, name, binding);
    if (!release) return none(name);
    if (!deps.blobs) throw new Error('released app data needs a blob store');
    const shown = interpretData(binding.path, await releasedBytes(deps.blobs, release));
    return { name, state: 'ready', ...shown, updated_at: release.written_at.toISOString() };
  }
  const row = await newestRecorded(deps.sql, app.space_id, binding);
  if (!row) return none(name);
  const shown = interpretData(
    binding.path,
    await recordedBytes(deps.roots, app.space_id, binding, row),
  );
  return {
    name,
    state: 'ready',
    ...shown,
    updated_at: new Date(row.created_at).toISOString(),
  };
}

const reviewed = (manifest: AppManifest) =>
  Object.entries(manifest.data)
    .filter(([, binding]) => binding.review === true)
    .sort(([a], [b]) => (a < b ? -1 : 1));

/** How many reviewed bindings have a newer version than the one viewers see. */
export async function dataWaiting(
  q: Query,
  app: { id: string; space_id: string },
  manifest: AppManifest,
): Promise<number> {
  let waiting = 0;
  for (const [name, binding] of reviewed(manifest)) {
    const row = await newestRecorded(q, app.space_id, binding);
    if (!row) continue;
    const release = await newestRelease(q, app.id, name, binding);
    if (release?.artifact_id !== row.id) waiting += 1;
  }
  return waiting;
}

const LIST_LIMIT = 20;

/** What changed between two JSON values, at the top level, in words a person reads. */
export function describeChange(
  before: { format: 'json' | 'text'; value: JsonValue } | null,
  after: { format: 'json' | 'text'; value: JsonValue },
  sizes: { before: number | null; after: number },
): { changes: AppDataUpdate['changes']; summary: string } {
  const size =
    sizes.before === null ? `${sizes.after} bytes` : `${sizes.before} → ${sizes.after} bytes`;
  if (!before) return { changes: null, summary: `First version, ${size}` };
  if (before.format !== 'json' || after.format !== 'json')
    return { changes: null, summary: `Text changed, ${size}` };
  const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (Array.isArray(before.value) && Array.isArray(after.value)) {
    const from = before.value.length;
    const to = after.value.length;
    return {
      changes: null,
      summary: `${from === to ? `${to} items` : `${from} → ${to} items`}, ${size}`,
    };
  }
  if (!isObject(before.value) || !isObject(after.value))
    return { changes: null, summary: `Value changed, ${size}` };
  const old = before.value;
  const now = after.value;
  const added = Object.keys(now).filter((key) => !Object.hasOwn(old, key));
  const removed = Object.keys(old).filter((key) => !Object.hasOwn(now, key));
  const changed = Object.keys(now).filter(
    (key) => Object.hasOwn(old, key) && JSON.stringify(old[key]) !== JSON.stringify(now[key]),
  );
  const truncated = [added, removed, changed].some((list) => list.length > LIST_LIMIT);
  const parts = [
    added.length ? `${added.length} added` : '',
    changed.length ? `${changed.length} changed` : '',
    removed.length ? `${removed.length} removed` : '',
  ].filter(Boolean);
  return {
    changes: {
      added: added.sort().slice(0, LIST_LIMIT),
      removed: removed.sort().slice(0, LIST_LIMIT),
      changed: changed.sort().slice(0, LIST_LIMIT),
      truncated,
    },
    summary: `${parts.length ? `Keys: ${parts.join(', ')}` : 'No key changes'}, ${size}`,
  };
}

/** The new versions of reviewed data waiting for the publisher, with what each changes. */
export async function dataUpdates(
  deps: DataDeps,
  app: { id: string; space_id: string },
  manifest: AppManifest,
): Promise<AppDataUpdate[]> {
  const updates: AppDataUpdate[] = [];
  for (const [name, binding] of reviewed(manifest)) {
    const row = await newestRecorded(deps.sql, app.space_id, binding);
    if (!row) continue;
    const release = await newestRelease(deps.sql, app.id, name, binding);
    if (release?.artifact_id === row.id) continue;
    let after: ReturnType<typeof interpretData>;
    try {
      after = interpretData(
        binding.path,
        await recordedBytes(deps.roots, app.space_id, binding, row),
      );
    } catch (error) {
      if (!(error instanceof DataUnavailable)) throw error;
      updates.push({
        binding: name,
        path: binding.path,
        artifact_id: row.id,
        written_at: new Date(row.created_at).toISOString(),
        size: Number(row.size),
        size_before: release ? Number(release.size) : null,
        changes: null,
        summary: error.message,
      });
      continue;
    }
    let before: ReturnType<typeof interpretData> | null = null;
    if (release && deps.blobs)
      before = interpretData(binding.path, await releasedBytes(deps.blobs, release));
    const described = describeChange(before, after, {
      before: release ? Number(release.size) : null,
      after: Number(row.size),
    });
    updates.push({
      binding: name,
      path: binding.path,
      artifact_id: row.id,
      written_at: new Date(row.created_at).toISOString(),
      size: Number(row.size),
      size_before: release ? Number(release.size) : null,
      ...described,
    });
  }
  return updates;
}

/** A release that cannot be made as asked. */
export class ReleaseRefused extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

/**
 * Let the newest version of a reviewed binding through to viewers. Only the
 * newest version can be let through, and only while its bytes are the ones
 * recorded, so what viewers get is what the publisher was shown.
 * `allowed` runs inside the transaction that records the release, with the
 * app row locked, and says whether this person may still release.
 */
export async function releaseData(
  deps: DataDeps & { blobs: BlobStore },
  input: {
    appId: string;
    name: string;
    artifactId: string;
    principalId: string;
    allowed: (tx: TransactionSql) => Promise<boolean>;
  },
): Promise<void> {
  const current = async (q: Query) => {
    const [row] = await q<{ space_id: string; manifest: AppManifest }[]>`select a.space_id,
        v.manifest from app a join app_version v on v.id = a.current_version_id
      where a.id = ${input.appId} and a.status = 'active'`;
    if (!row) throw new ReleaseRefused('No such app.', 404);
    const binding = Object.hasOwn(row.manifest.data, input.name)
      ? row.manifest.data[input.name]
      : undefined;
    if (!binding?.review)
      throw new ReleaseRefused('This app has no reviewed data by that name.', 404);
    const newest = await newestRecorded(q, row.space_id, binding);
    if (newest?.id !== input.artifactId)
      throw new ReleaseRefused(
        'A newer version was written since this one was shown. Review the newest one.',
        409,
      );
    return { spaceId: row.space_id, binding, newest };
  };
  const { spaceId, binding, newest } = await current(deps.sql);
  let bytes: Uint8Array;
  try {
    bytes = await recordedBytes(deps.roots, spaceId, binding, newest);
    interpretData(binding.path, bytes);
  } catch (error) {
    if (error instanceof DataUnavailable) throw new ReleaseRefused(error.message, 409);
    throw error;
  }
  for (let attempt = 0; ; attempt++) {
    const stored = await deps.blobs.put(bytes, { sha256: newest.content_hash });
    try {
      await deps.sql.begin(async (tx) => {
        await tx`select 1 from app where id = ${input.appId} for update`;
        if (!(await input.allowed(tx)))
          throw new ReleaseRefused('Only the publisher or the space’s owner can do this.', 403);
        // The same checks again, now that nothing about the app can move.
        const again = await current(tx);
        if (again.newest.content_hash !== newest.content_hash)
          throw new ReleaseRefused('The file changed while it was being let through.', 409);
        const id = recordId('adr');
        const [inserted] = await tx<{ id: string }[]>`insert into app_data_release
            (id, app_id, binding, path, source_job_id, artifact_id, content_hash, size,
             written_at, approved_by)
          values (${id}, ${input.appId}, ${input.name}, ${binding.path}, ${binding.source_job_id},
            ${newest.id}, ${newest.content_hash}, ${bytes.byteLength}, ${newest.created_at},
            ${input.principalId})
          on conflict (app_id, binding, artifact_id) do nothing
          returning id`;
        if (inserted)
          await referenceBlob(tx, deps.blobs, stored, {
            kind: APP_DATA_RELEASE_OWNER,
            id: inserted.id,
          });
      });
      return;
    } catch (error) {
      if (!(error instanceof BlobNotFound) || attempt > 0) throw error;
    }
  }
}
