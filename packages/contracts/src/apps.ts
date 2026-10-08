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
import { jsonObject, jsonValue, timestamp } from './common.ts';

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
  /** The largest file a data binding serves. */
  max_data_bytes: 2 * 1024 * 1024,
  /** Responses one person may send one app in a minute. */
  submissions_per_minute: 30,
  /** Responses one app keeps at most; past this, new ones are refused until some are deleted. */
  max_submissions_per_app: 10_000,
  /** Responses one app keeps from any one person, so nobody can fill it for everyone else. */
  max_submissions_per_person: 500,
  /** Responses one page of the list, or one read by the agent, holds at most. */
  max_submission_page: 100,
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
export const appBindingName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const bindingName = appBindingName;

/** Where one data binding reads from. Only the newest version of a file a conversation wrote, for now. */
export const appDataBinding = z.strictObject({
  kind: z.literal('artifact'),
  path: z.string().min(1).max(1024),
  /** The conversation whose newest file at `path` is read. */
  source_job_id: z.string().min(1).max(200),
  /**
   * Present when the publisher reviews each new version of the file before
   * viewers see it. Left out, viewers see each new version as it is written.
   */
  review: z.literal(true).optional(),
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
    z.strictObject({
      name: z.string(),
      kind: z.literal('artifact'),
      path: z.string(),
      /** Whether each new version waits for the publisher before viewers see it. */
      review: z.boolean(),
    }),
  ),
  /**
   * How many new data versions wait for review. Null unless this person can
   * release them: the publisher while they belong to the space, or its owner.
   */
  data_waiting: z.number().int().min(0).nullable(),
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
 * view ends when it expires, when the browser session that asked signs out,
 * when who may open the app changes, or when the app moves to another
 * version; the viewer then asks for a new one.
 */
export const appView = z.strictObject({
  view_path: z.string().regex(/^\/apps\/view\/[A-Za-z0-9._-]+\/index\.html$/),
  version_id: appVersionId,
  expires_at: timestamp,
});
export type AppView = z.infer<typeof appView>;

/**
 * One data binding's value, as a viewer of the app gets it. A JSON file is
 * returned parsed and any other text file as a string. `state` is `none`
 * before the file has been written, or, when the publisher reviews updates,
 * before they have let a version through.
 */
export const appDataValue = z.strictObject({
  name: appBindingName,
  state: z.enum(['ready', 'none']),
  format: z.enum(['json', 'text']).nullable(),
  value: jsonValue,
  /** When the version shown was written. */
  updated_at: timestamp.nullable(),
});
export type AppDataValue = z.infer<typeof appDataValue>;

/** A new version of a reviewed data file, waiting for the publisher. */
export const appDataUpdate = z.strictObject({
  binding: appBindingName,
  path: z.string(),
  /** The recorded version waiting; releasing names it. */
  artifact_id: z.string(),
  written_at: timestamp,
  size: z.number().int().min(0),
  /** The size of the version viewers see now; null when they see none yet. */
  size_before: z.number().int().min(0).nullable(),
  /** For JSON: top-level keys (or, for a list, its length) added, removed and changed. */
  changes: z
    .strictObject({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      changed: z.array(z.string()),
      truncated: z.boolean(),
    })
    .nullable(),
  /** One line a person reads: what changed, in words. */
  summary: z.string(),
});
export type AppDataUpdate = z.infer<typeof appDataUpdate>;

export const appDataUpdates = z.strictObject({ updates: z.array(appDataUpdate) });
export type AppDataUpdates = z.infer<typeof appDataUpdates>;

export const appDataReleaseRequest = z.strictObject({
  binding: appBindingName,
  artifact_id: z.string().min(1).max(200),
});

/** A response a viewer sends from an app, for a collection its version declares. */
export const appSubmissionRequest = z.strictObject({
  collection: appBindingName,
  record: jsonObject,
  /**
   * What an app keeps for its viewer, such as a tracker's ticks: this record
   * replaces the viewer's earlier ones in the collection, so only the newest
   * is kept and read back (`GET /apps/{id}/submissions/mine`).
   */
  replace: z.boolean().optional(),
});
export type AppSubmissionRequest = z.infer<typeof appSubmissionRequest>;

export const appSubmissionAccepted = z.strictObject({
  id: z.string(),
  created_at: timestamp,
});

export const appSubmission = z.strictObject({
  id: z.string(),
  collection: appBindingName,
  version_id: appVersionId,
  /** Who sent it; null once their account is gone. */
  by: person.nullable(),
  data: jsonObject,
  created_at: timestamp,
});
export type AppSubmission = z.infer<typeof appSubmission>;

export const appSubmissionList = z.strictObject({
  submissions: z.array(appSubmission),
  /** Pass as `before` for the next, older page; null on the last page. */
  next_before: z.string().nullable(),
});
export type AppSubmissionList = z.infer<typeof appSubmissionList>;

export const appSubmissionDeleted = z.strictObject({ id: z.string(), deleted: z.literal(true) });

/** The newest record the viewer sent in one collection, or null when they sent none. */
export const appSubmissionMine = z.strictObject({
  record: jsonObject.nullable(),
  created_at: timestamp.nullable(),
});
export type AppSubmissionMine = z.infer<typeof appSubmissionMine>;

/** Every response one person sent an app, deleted at once. */
export const appSubmissionsDeleted = z.strictObject({
  from: z.string(),
  deleted: z.number().int().min(0),
});
