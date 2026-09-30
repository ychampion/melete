import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { connection, owner, principal, space } from './schema.ts';

/** Only a digest is stored, so a database read cannot recover a session cookie. */
export const session = pgTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    principalId: text('principal_id').references(() => principal.id, { onDelete: 'cascade' }),
    spaceId: text('space_id').references(() => space.id, { onDelete: 'cascade' }),
    /** The membership generation a shared space was selected under; a regrant never matches it. */
    membershipGeneration: integer('membership_generation'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('session_expires_idx').on(table.expiresAt)],
);

/** Single-use digests bind a login to the mailbox connection that delivered it. */
export const magicLink = pgTable(
  'magic_link',
  {
    tokenHash: text('token_hash').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    connectionGeneration: integer('connection_generation').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('magic_link_owner_created_idx').on(table.ownerId, table.createdAt)],
);

/**
 * An assistant registered to reach Melete's MCP endpoint: by dynamic
 * registration, where the id is issued here, or by a client ID metadata
 * document, where the id is the https address the document was read from.
 */
export const mcpClient = pgTable('mcp_client', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  /** Set for a client identified by its metadata document. */
  metadataUrl: text('metadata_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A single-use authorization code, bound to its client, redirect, challenge, resource and person. */
export const mcpAuthorization = pgTable(
  'mcp_authorization',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpClient.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    membershipGeneration: integer('membership_generation'),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('mcp_authorization_expires_idx').on(table.expiresAt)],
);

/**
 * Access and refresh tokens, stored as digests. Every token of one sign-in
 * shares a family, so a refresh token presented twice ends the whole family.
 */
export const mcpToken = pgTable(
  'mcp_token',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    family: text('family').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => mcpClient.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    membershipGeneration: integer('membership_generation'),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mcp_token_family_idx').on(table.family),
    index('mcp_token_principal_idx').on(table.principalId),
    index('mcp_token_expires_idx').on(table.expiresAt),
  ],
);

/**
 * A one-time way back in after a forgotten password. Only a digest is stored.
 * `via` says who asked for it: the operator's command on the host, or a
 * message to the account's own mailbox.
 */
export const passwordReset = pgTable(
  'password_reset',
  {
    tokenHash: text('token_hash').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    via: text('via').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('password_reset_principal_created_idx').on(table.principalId, table.createdAt)],
);
