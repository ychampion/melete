import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTemplateDatabase, type TestDatabase } from './database.ts';

export type PostgresFixture = TestDatabase;

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
const brokerMigrations = [new URL('../../drizzle/0012_effect_identity.sql', import.meta.url)];

/**
 * Each call owns a database while cluster startup and pg-boss initialization
 * are shared. SQL content identifies the template, including optional migrations.
 */
export async function createPostgresFixture(
  options: PostgresFixtureOptions = {},
): Promise<PostgresFixture | null> {
  const migrations = await Promise.all(
    [initialMigration, ...brokerMigrations, ...(options.migrations ?? [])].map((migration) =>
      readFile(migration, 'utf8'),
    ),
  );
  const key = `broker:${createHash('sha256').update(JSON.stringify(migrations)).digest('hex')}`;
  return createTemplateDatabase(
    key,
    async (handle) => {
      for (const migration of migrations) await handle.sql.unsafe(migration);
    },
    2,
  );
}
