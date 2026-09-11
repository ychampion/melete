import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { acquireTestServer } from './database.ts';

export type PostgresFixture = DatabaseHandle & {
  url: string;
  mode: 'embedded' | 'external';
};

export type PostgresFixtureOptions = {
  /** The initial frozen schema always runs before these additional migrations. */
  migrations?: Array<string | URL>;
};

const initialMigration = new URL('../../drizzle/0000_initial_schema.sql', import.meta.url);
/**
 * The frozen initial schema, plus the later migrations the broker's own
 * invariants live in. A fixture that stops at 0000 cannot exercise a unique
 * index that was added in 0009, and a test that cannot exercise the index is
 * not evidence of anything.
 */
const brokerMigrations = [
  new URL('../../drizzle/0012_effect_identity.sql', import.meta.url),
  new URL('../../drizzle/0018_tool_catalog.sql', import.meta.url),
];

/**
 * Every fixture owns a newly created database, including when DATABASE_URL is
 * supplied. Keeping the frozen migration's public-qualified foreign keys in an
 * isolated database prevents tests from migrating or clearing existing data.
 */
export async function createPostgresFixture(
  options: PostgresFixtureOptions = {},
): Promise<PostgresFixture | null> {
  const databaseName = `melete_w2_${randomUUID().replaceAll('-', '')}`;
  const configuredUrl = process.env.DATABASE_URL;
  const shared = await acquireTestServer();
  if (!shared) return null;
  const adminUrl = shared.url;

  const admin = postgres(adminUrl, { max: 2, connect_timeout: 10, onnotice: () => {} });
  let handle: DatabaseHandle | undefined;
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await handle?.close();
      // Only the database created successfully by this fixture is eligible for removal.
      if (created) await admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`;
    } finally {
      try {
        await admin.end({ timeout: 5 });
      } finally {
        await shared.release();
      }
    }
  };

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    handle = openDatabase(url.toString(), 2);
    for (const migration of [
      initialMigration,
      ...brokerMigrations,
      ...(options.migrations ?? []),
    ]) {
      await handle.sql.unsafe(await readFile(migration, 'utf8'));
    }
    return {
      ...handle,
      url: url.toString(),
      mode: configuredUrl ? 'external' : 'embedded',
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
