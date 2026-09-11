import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { migrateDatabase } from '../../src/db/migrate.ts';

export type TestDatabase = DatabaseHandle & { url: string };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test Postgres port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Each fixture owns a disposable database; an operator's existing tables are never reused. */
export async function testDatabase(): Promise<TestDatabase | null> {
  let url = process.env.DATABASE_URL;
  let stop: () => Promise<void> = async () => {};
  if (!url) {
    let EmbeddedPostgres: typeof import('embedded-postgres').default;
    try {
      EmbeddedPostgres = (await import('embedded-postgres')).default;
    } catch (error) {
      process.stdout.write(`embedded Postgres unavailable: ${String(error)}\n`);
      process.stdout.write(
        'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
      );
      return null;
    }
    const databaseDir = await mkdtemp(join(tmpdir(), 'melete-w1-pg-'));
    const port = await unusedPort();
    const password = randomBytes(24).toString('hex');
    const embedded = new EmbeddedPostgres({
      databaseDir,
      port,
      user: 'postgres',
      password,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=40'],
      onLog: () => {},
      onError: () => {},
    });
    try {
      await embedded.initialise();
      await embedded.start();
    } catch (error) {
      await embedded.stop();
      // Only absent binary downloads can skip tests; startup and migration errors fail.
      if (!/ENOENT|Cannot find package|download/i.test(String(error))) throw error;
      process.stdout.write(`embedded Postgres unavailable: ${String(error)}\n`);
      process.stdout.write(
        'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
      );
      return null;
    }
    stop = () => embedded.stop();
    url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  }
  const admin = openDatabase(url, 2);
  const name = `melete_test_${randomBytes(10).toString('hex')}`;
  await admin.sql`create database ${admin.sql(name)}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  const handle = openDatabase(target.toString(), 4);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
    await admin.sql`drop database ${admin.sql(name)} with (force)`;
    await admin.close();
    await stop();
  };
  try {
    await migrateDatabase(handle);
    return { ...handle, url: target.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
