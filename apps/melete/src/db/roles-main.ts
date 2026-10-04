/**
 * The `database-roles` step of deploy/docker-compose.yml: runs once before the
 * service on every start, with the operator's DATABASE_URL, and leaves the
 * service's two database addresses in MELETE_DATABASE_ACCESS_DIR, a volume
 * only the service mounts. See db/roles.ts.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RolesRefusal, setUpDatabaseRoles } from './roles.ts';

/** Writes `value` to `path` whole: a reader sees the old file or the new one, never part. */
function writeWhole(path: string, value: string) {
  const next = `${path}.next`;
  rmSync(next, { force: true });
  writeFileSync(next, `${value}\n`, { mode: 0o400 });
  chmodSync(next, 0o400);
  renameSync(next, path);
}

if (import.meta.main) {
  const operatorUrl = process.env.DATABASE_URL?.trim();
  const directory = process.env.MELETE_DATABASE_ACCESS_DIR?.trim();
  if (!operatorUrl || !directory) {
    process.stderr.write('DATABASE_URL and MELETE_DATABASE_ACCESS_DIR are required.\n');
    process.exit(2);
  }
  const given = (name: string) => process.env[name]?.trim() || undefined;
  try {
    const urls = await setUpDatabaseRoles({
      operatorUrl,
      testConnector: process.env.MELETE_ENABLE_TEST_CONNECTOR === 'true',
      provided: {
        migrate: given('MELETE_MIGRATE_DATABASE_URL'),
        api: given('MELETE_API_DATABASE_URL'),
        effects: given('MELETE_EFFECTS_DATABASE_URL'),
      },
    });
    mkdirSync(directory, { recursive: true });
    writeWhole(join(directory, 'api.url'), urls.api);
    writeWhole(join(directory, 'effects.url'), urls.effects);
    process.stdout.write(
      'The database roles are in place, every migration has run, and the service role may not read the secret table.\n',
    );
  } catch (error) {
    if (error instanceof RolesRefusal) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `The database setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
