/**
 * Apps: small web pages the agent builds and publishes for people to use.
 *
 * An app is a static bundle (HTML, scripts, styles, images) the agent wrote in
 * its workspace. Publishing stores each file by its hash and records a version:
 * a manifest naming every file with its hash, size and type. The app points at
 * one version at a time, so rolling back is moving that pointer. Who may open
 * an app is a list of grants, and every change to that list moves the app's
 * grant generation, which is what lets an open view be stopped at once.
 *
 * The agent publishes and rolls back through the `apps` connector, and each of
 * those asks the person first. The person's own changes from the Apps screen
 * (choosing a version, changing who can open it, deleting it) are theirs to
 * make and do not ask.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';

/** What one app version may hold. A bundle over any of these is refused before anything asks. */
export const APP_LIMITS = {
  max_files: 200,
  max_total_bytes: 25 * 1024 * 1024,
  max_file_bytes: 8 * 1024 * 1024,
  /** People one publish or grant change may name. */
  max_people: 50,
  max_data_bindings: 20,
  max_collections: 20,
  /** The largest record a collection may be declared to take. */
  max_collection_record_bytes: 16 * 1024,
} as const;

/**
 * The file types a bundle may contain, by extension, and the type each is
 * served as. The type is decided here, never sniffed from the bytes.
 */
export const APP_FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
  wasm: 'application/wasm',
});

/** The type a bundle file is served as, or null when its extension is not allowed. */
export function appFileType(path: string): string | null {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return APP_FILE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The file every bundle must have at its top level. */
export const APP_ENTRY = 'index.html';

export const appId = z.string().regex(/^app_[0-9A-Za-z]{1,64}$/);
/** A version is named by the sha256 of its app and its manifest. */
export const appVersionId = z.string().regex(/^[0-9a-f]{64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const bindingName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

/** Where one data binding reads from. Only the newest version of a file a conversation wrote, for now. */
export const appDataBinding = z.strictObject({
  kind: z.literal('artifact'),
  path: z.string().min(1).max(1024),
  /** The conversation whose newest file at `path` is read. */
  source_job_id: z.string().min(1).max(200),
});
export type AppDataBinding = z.infer<typeof appDataBinding>;

export const appCollection = z.strictObject({
  max_bytes: z.number().int().min(1).max(APP_LIMITS.max_collection_record_bytes),
});

export const appManifestFile = z.strictObject({
  sha256,
  size: z.number().int().min(0).max(APP_LIMITS.max_file_bytes),
  mime: z.string().min(1).max(100),
});

export const appManifest = z.strictObject({
  entry: z.literal(APP_ENTRY),
  files: z.record(z.string().min(1).max(512), appManifestFile),
  data: z.record(bindingName, appDataBinding),
  collections: z.record(bindingName, appCollection),
});
export type AppManifest = z.infer<typeof appManifest>;

export const appRole = z.enum(['view', 'manage']);
export type AppRole = z.infer<typeof appRole>;

const person = z.strictObject({ id: z.string(), email: z.string() });

export const appVersionSummary = z.strictObject({
  id: appVersionId,
  created_at: timestamp,
  created_by: person.nullable(),
  file_count: z.number().int().min(0),
  total_bytes: z.number().int().min(0),
});
export type AppVersionSummary = z.infer<typeof appVersionSummary>;

export const appSummary = z.strictObject({
  id: appId,
  name: z.string(),
  description: z.string().nullable(),
  publisher: person,
  /** What the person asking may do with it. */
  role: appRole,
  current_version: appVersionSummary.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type AppSummary = z.infer<typeof appSummary>;

export const appGrantView = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('principal'),
    principal: person,
    role: appRole,
    granted_at: timestamp,
  }),
  z.strictObject({
    kind: z.literal('installation'),
    role: z.literal('view'),
    granted_at: timestamp,
  }),
]);

const changedPaths = z.strictObject({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  /** True when a list was cut at its limit. */
  truncated: z.boolean(),
});

export const appDetail = z.strictObject({
  app: appSummary,
  /** The current version's files, as published. */
  files: z.array(z.strictObject({ path: z.string(), size: z.number().int(), mime: z.string() })),
  data: z.array(
    z.strictObject({ name: z.string(), kind: z.literal('artifact'), path: z.string() }),
  ),
  collections: z.array(z.strictObject({ name: z.string(), max_bytes: z.number().int() })),
  /** Every version, newest first, with what changed from the one before it. Managers only. */
  versions: z
    .array(appVersionSummary.extend({ current: z.boolean(), changes: changedPaths }))
    .nullable(),
  /** Who can open it besides its publisher. Managers only. */
  grants: z.array(appGrantView).nullable(),
});
export type AppDetail = z.infer<typeof appDetail>;

export const appListResponse = z.strictObject({ apps: z.array(appSummary) });

export const appCurrentRequest = z.strictObject({ version_id: appVersionId });

export const appGrantRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('principal'),
    email: z.email().max(320),
    role: appRole.default('view'),
  }),
  z.strictObject({ kind: z.literal('installation'), role: z.literal('view').default('view') }),
]);
export const appGrantsRequest = z.strictObject({
  /** The whole list of who may open the app besides its publisher; it replaces the current one. */
  grants: z.array(appGrantRequest).max(APP_LIMITS.max_people + 1),
});
export type AppGrantsRequest = z.infer<typeof appGrantsRequest>;

export const appDeleted = z.strictObject({ id: appId, deleted: z.literal(true) });

/**
 * A view of an app's current version for the person asking. `view_path` is
 * relative to the API's own address. The page loads there, framed, with an
 * opaque origin, and each of its files is served under the same path. The
 * view ends when it expires, when who may open the app changes, or when the
 * app moves to another version; the viewer then asks for a new one.
 */
export const appView = z.strictObject({
  view_path: z.string().regex(/^\/apps\/view\/[A-Za-z0-9._-]+\/index\.html$/),
  version_id: appVersionId,
  expires_at: timestamp,
});
export type AppView = z.infer<typeof appView>;
