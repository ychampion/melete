/**
 * Computers a person connected, and the one-time codes that connect them.
 *
 * A paired computer is also an ordinary `connection` row with provider
 * `device`, so the broker admits what the agent asks of it exactly as it admits
 * any other connection: approvals, rules, receipts and revocation all follow
 * that row. This table keeps what only a computer has: the hash of the token
 * its companion presents, what Settings allows, what the companion itself
 * allows, and the folders the person chose on that computer.
 *
 * A pairing code is kept only as a hash, is usable once, and expires.
 */

import type { DeviceCapabilities, DeviceFolder } from '@melete/contracts';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { connection, space } from '../db/schema.ts';

export const pairedDevice = pgTable(
  'paired_device',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    /** SHA-256 of the device token. The token itself is shown to the companion once. */
    tokenHash: text('token_hash').notNull(),
    /** What the person allows from Settings. */
    capabilities: jsonb('capabilities').$type<DeviceCapabilities>().notNull(),
    /** What the companion on the computer allows, as it last said. */
    localCapabilities: jsonb('local_capabilities').$type<DeviceCapabilities>().notNull(),
    folders: jsonb('folders').$type<DeviceFolder[]>().notNull().default([]),
    companionVersion: text('companion_version'),
    pairedBy: text('paired_by').notNull(),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('paired_device_token_idx').on(t.tokenHash),
    uniqueIndex('paired_device_connection_idx').on(t.connectionId),
    index('paired_device_space_idx').on(t.spaceId),
  ],
);

export const devicePairing = pgTable(
  'device_pairing',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    codeHash: text('code_hash').notNull(),
    capabilities: jsonb('capabilities').$type<DeviceCapabilities>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    deviceId: text('device_id'),
  },
  (t) => [
    uniqueIndex('device_pairing_code_idx').on(t.codeHash),
    index('device_pairing_space_idx').on(t.spaceId),
  ],
);
