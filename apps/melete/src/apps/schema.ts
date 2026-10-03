/**
 * Published apps, their versions, and who may open them.
 *
 * An app belongs to the space it was published from and names its current
 * version. A version is immutable: its id is the sha256 of its app and its
 * manifest, and its files are blobs referred to by the version
 * (`blob_ref` owner kind `app_version`). A grant is never edited in place:
 * a revoked grant keeps its row with `revoked_at`, and every change to the set
 * of grants moves the app's `grant_generation`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const app = pgTable(
  'app',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    publisherPrincipalId: text('publisher_principal_id')
      .notNull()
      .references(() => principal.id),
    /** Null only between the app row and its first version, inside one transaction. */
    currentVersionId: text('current_version_id'),
    grantGeneration: integer('grant_generation').notNull().default(0),
    /**
     * The last action that set the current version or the grants from a
     * conversation, so a check of whether one ran asks about that action
     * itself, not about a state another action could also have produced.
     */
    lastActionId: text('last_action_id'),
    status: text('status').notNull().default('active'),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_space_slug_idx').on(table.spaceId, table.slug),
    index('app_publisher_idx').on(table.publisherPrincipalId),
    check('app_status', sql`${table.status} in ('active', 'unpublished')`),
    check('app_grant_generation', sql`${table.grantGeneration} >= 0`),
  ],
);

export const appVersion = pgTable(
  'app_version',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => app.id, { onDelete: 'cascade' }),
    /** sha256 of the canonical manifest alone: what the publish approval was bound to. */
    manifestHash: text('manifest_hash').notNull(),
    manifest: jsonb('manifest').notNull(),
    fileCount: integer('file_count').notNull(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    /** The conversation and the action that published it. Not keys: they outlive their rows. */
    jobId: text('job_id'),
    actionId: text('action_id'),
    createdBy: text('created_by').references(() => principal.id),
    createdAt: created(),
  },
  (table) => [
    index('app_version_app_idx').on(table.appId, table.createdAt),
    check('app_version_id_shape', sql`${table.id} ~ '^[0-9a-f]{64}$'`),
    check('app_version_manifest_hash_shape', sql`${table.manifestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const appGrant = pgTable(
  'app_grant',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => app.id, { onDelete: 'cascade' }),
    granteeKind: text('grantee_kind').notNull(),
    /** A principal id, a room id, or `installation` for everyone with an account here. */
    granteeId: text('grantee_id').notNull(),
    role: text('role').notNull().default('view'),
    grantedBy: text('granted_by').references(() => principal.id),
    createdAt: created(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // One live grant per grantee; revoked rows stay as the record.
    uniqueIndex('app_grant_live_idx')
      .on(table.appId, table.granteeKind, table.granteeId)
      .where(sql`${table.revokedAt} is null`),
    index('app_grant_grantee_idx').on(table.granteeKind, table.granteeId),
    check('app_grant_kind', sql`${table.granteeKind} in ('principal', 'room', 'installation')`),
    check('app_grant_role', sql`${table.role} in ('view', 'manage')`),
  ],
);

/**
 * A response a viewer sent from an app. Kept with who sent it and the version
 * they sent it from; a deleted one keeps its row without its contents.
 */
export const appSubmission = pgTable(
  'app_submission',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => app.id, { onDelete: 'cascade' }),
    versionId: text('version_id').notNull(),
    collection: text('collection').notNull(),
    principalId: text('principal_id').references(() => principal.id, { onDelete: 'set null' }),
    data: jsonb('data').notNull(),
    /** The record's size as JSON, in bytes. */
    size: integer('size').notNull(),
    createdAt: created(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by').references(() => principal.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('app_submission_list_idx').on(table.appId, table.collection, table.id),
    index('app_submission_sender_idx').on(table.appId, table.principalId, table.createdAt),
    check('app_submission_size', sql`${table.size} between 0 and 16384`),
  ],
);

/**
 * A version of a reviewed data file that the publisher let through to
 * viewers. The bytes are kept as a blob (`blob_ref` owner kind
 * `app_data_release`), because the file in the workspace moves on.
 */
export const appDataRelease = pgTable(
  'app_data_release',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => app.id, { onDelete: 'cascade' }),
    binding: text('binding').notNull(),
    /** The binding's file and conversation when it was released; a later version may name others. */
    path: text('path').notNull(),
    sourceJobId: text('source_job_id').notNull(),
    /** The recorded version released. Not a key: it outlives its row. */
    artifactId: text('artifact_id').notNull(),
    contentHash: text('content_hash').notNull(),
    size: integer('size').notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull(),
    approvedBy: text('approved_by').references(() => principal.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('app_data_release_artifact_idx').on(table.appId, table.binding, table.artifactId),
    index('app_data_release_newest_idx').on(table.appId, table.binding, table.approvedAt),
    check('app_data_release_hash_shape', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type AppRow = typeof app.$inferSelect;
export type AppVersionRow = typeof appVersion.$inferSelect;
export type AppGrantRow = typeof appGrant.$inferSelect;
