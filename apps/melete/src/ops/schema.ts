/**
 * State that several service instances on one database share: request limits,
 * sign-ins waiting for the browser to come back, and which instances are
 * running. One instance alone behaves exactly as it did with this state in
 * its own memory.
 */
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One limiter's state for one key: a client address, an account, a known
 * browser or a connection. The key is stored as a digest, so the table names
 * no address or account. Rows past `expires_at` mean nothing and are deleted.
 */
export const rateLimitWindow = pgTable(
  'rate_limit_window',
  {
    /** sha256 of the limiter's scope and the key, hex. */
    key: text('key').primaryKey(),
    /** Which limiter, for whoever reads the table: `login.address`, `mcp.register`, ... */
    scope: text('scope').notNull(),
    state: jsonb('state'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_window_expires_idx').on(t.expiresAt)],
);

/**
 * A sign-in between its start and the browser's return, or a finished one the
 * app may still ask about. The payload holds a PKCE verifier and sometimes a
 * client secret, so it is sealed with the master key and bound to its row.
 */
export const signinPending = pgTable(
  'signin_pending',
  {
    /** sha256 of the kind and the sign-in's id or state, hex. */
    stateHash: text('state_hash').primaryKey(),
    kind: text('kind').notNull(),
    /** What a whole group is found by, such as a provider's name; never secret. */
    subject: text('subject'),
    sealedPayload: text('sealed_payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('signin_pending_subject_idx').on(t.kind, t.subject),
    index('signin_pending_expires_idx').on(t.expiresAt),
  ],
);

/** A running service instance. A row whose heartbeat stopped belongs to one that ended. */
export const opsInstance = pgTable('ops_instance', {
  id: text('id').primaryKey(),
  host: text('host').notNull(),
  /** The running process's own mark, so two processes under one name are noticed. */
  nonce: text('nonce').notNull().default(''),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});
