import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import postgres from 'postgres';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';

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
  // Artifact validation tables and the columns a declared write fills in. A
  // fixture without this cannot record an artifact, and a test that cannot
  // record one proves nothing about the gate that reads them.
  new URL('../../drizzle/0015_artifact_validation.sql', import.meta.url),
];
const tempPrefix = 'melete-w2-postgres-';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port was allocated');
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function removeOwnedTempRoot(root: string): Promise<void> {
  const parent = await realpath(tmpdir());
  const absolute = resolve(root);
  if (
    dirname(absolute) !== parent ||
    !basename(absolute).startsWith(tempPrefix) ||
    (await lstat(absolute)).isSymbolicLink() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error(`Refusing to remove unverified fixture directory: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function binaryUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot find (package|module)|module_not_found|enoent|download|unsupported platform|no binaries/i.test(
    message,
  );
}

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
  let adminUrl = configuredUrl;
  let stopEmbedded: (() => Promise<void>) | undefined;
  let tempRoot: string | undefined;

  if (!adminUrl) {
    try {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      tempRoot = await mkdtemp(join(await realpath(tmpdir()), tempPrefix));
      const port = await availablePort();
      const password = randomUUID();
      const cluster = new EmbeddedPostgres({
        databaseDir: join(tempRoot, 'data'),
        port,
        user: 'postgres',
        password,
        authMethod: 'scram-sha-256',
        persistent: true,
        createPostgresUser: false,
        initdbFlags: ['--encoding=UTF8', '--locale=C'],
        postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=20'],
        onLog: () => {},
        onError: () => {},
      });
      await cluster.initialise();
      await cluster.start();
      stopEmbedded = () => cluster.stop();
      adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    } catch (error) {
      if (stopEmbedded) await stopEmbedded();
      if (tempRoot) await removeOwnedTempRoot(tempRoot);
      if (!binaryUnavailable(error)) throw error;
      process.stdout.write(
        'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
      );
      process.stdout.write(`embedded Postgres binary unavailable: ${String(error)}\n`);
      return null;
    }
  }

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
        if (stopEmbedded) await stopEmbedded();
        if (tempRoot) await removeOwnedTempRoot(tempRoot);
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
