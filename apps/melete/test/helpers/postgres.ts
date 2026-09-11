import { readFile } from 'node:fs/promises';
import type { DatabaseHandle } from '../../src/db/client.ts';
import { testDatabase } from './database.ts';

export type PostgresFixture = DatabaseHandle & { url: string; mode: 'embedded' | 'external' };
export type PostgresFixtureOptions = { migrations?: Array<string | URL> };

/** All broker boundaries run against the current schema, in an isolated disposable database. */
export async function createPostgresFixture(
  options: PostgresFixtureOptions = {},
): Promise<PostgresFixture | null> {
  const fixture = await testDatabase();
  if (!fixture) return null;
  try {
    for (const migration of options.migrations ?? [])
      await fixture.sql.unsafe(await readFile(migration, 'utf8'));
    return { ...fixture, mode: process.env.DATABASE_URL ? 'external' : 'embedded' };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
