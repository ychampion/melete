import { type TestDatabase, testDatabase } from './database.ts';

export type PostgresFixture = TestDatabase;

/**
 * Use the committed journal so fixture setup survives migration renumbering.
 * Each caller still owns an isolated database with a real pg-boss schema.
 */
export async function createPostgresFixture(): Promise<PostgresFixture | null> {
  return testDatabase();
}
