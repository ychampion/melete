/**
 * The database roles a Compose installation runs under (src/db/roles.ts): the
 * service's own role cannot read sealed secrets, the effects role can, and an
 * installation that ran everything as the operator upgrades in place with its
 * data and its secrets still readable by the code that dispatches effects.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  PostgresSecretRepository,
  SealedSecretStore,
  useEffectsPool,
} from '../../src/connectors/secrets.ts';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { assertMigrated, migrateDatabase } from '../../src/db/migrate.ts';
import { checkRoles, ROLES, roleUrl, setUpDatabaseRoles } from '../../src/db/roles.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { sweepPrincipals } from '../../src/spaces/plan.ts';
import { acquireTestServer } from '../helpers/database.ts';

const MASTER_KEY = randomBytes(32).toString('base64');
const PROVIDER_ADMIN = 'l3_provider_admin';

let server: Awaited<ReturnType<typeof acquireTestServer>> = null;
let admin: DatabaseHandle | undefined;
const databases: string[] = [];
const open: DatabaseHandle[] = [];

beforeAll(async () => {
  server = await acquireTestServer();
  if (server) admin = openDatabase(server.url, 2);
}, 240_000);

afterAll(async () => {
  useEffectsPool(undefined);
  for (const handle of open.splice(0)) await handle.close().catch(() => {});
  if (admin) {
    for (const name of databases)
      await admin.sql`drop database if exists ${admin.sql(name)} with (force)`;
    for (const role of [
      ...Object.values(ROLES),
      PROVIDER_ADMIN,
      'l3_api',
      'l3_effects',
      'l3_migrate',
    ])
      await admin.sql.unsafe(`drop role if exists ${role}`).catch(() => {});
    await admin.close();
  }
  await server?.release();
});

/** A new, empty database on the test server, owned by `owner` when given. */
async function freshDatabase(owner?: string): Promise<string> {
  if (!admin || !server) throw new Error('no test server');
  const name = `melete_roles_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  if (owner) await admin.sql.unsafe(`create database ${name} owner ${owner}`);
  else await admin.sql.unsafe(`create database ${name}`);
  const url = new URL(server.url);
  url.pathname = `/${name}`;
  return url.toString();
}

function connect(url: string): DatabaseHandle {
  const handle = openDatabase(url, 2);
  open.push(handle);
  return handle;
}

const code = async (query: Promise<unknown>) =>
  query.then(
    () => 'allowed',
    (error: { code?: string }) => error.code,
  );

/** What an installation on the current main holds: everything made and owned by the operator. */
async function currentMainDeployment(operatorUrl: string) {
  const operator = connect(operatorUrl);
  await migrateDatabase(operator);
  const queue = await startQueue(operatorUrl);
  await queue.stop();
  const spaceId = `spc_${randomBytes(8).toString('hex')}`;
  await operator.sql`insert into space (id, name, git_path) values (${spaceId}, 'Kept', ${`spaces/${spaceId}`})`;
  const store = new SealedSecretStore(new PostgresSecretRepository(operator.sql), () => MASTER_KEY);
  const secretId = await store.put(spaceId, 'a token from before the upgrade');
  return { spaceId, secretId };
}

describe('database roles', () => {
  test('as melete_api, SELECT on secret fails', async () => {
    if (!server) return;
    const operatorUrl = await freshDatabase();
    const urls = await setUpDatabaseRoles({ operatorUrl });
    const api = connect(urls.api);
    const effects = connect(urls.effects);
    expect(await code(api.sql`select * from secret`)).toBe('42501');
    expect(await code(api.sql`select ciphertext from secret`)).toBe('42501');
    expect(await code(api.sql`select count(*) from secret`)).toBe('42501');
    expect(await code(api.sql`delete from secret`)).toBe('42501');
    expect(await code(effects.sql`select ciphertext from secret`)).toBe('allowed');
    // Everything else is the service's to read and write.
    expect(await code(api.sql`select count(*) from job`)).toBe('allowed');
    expect(
      await code(
        api.sql`insert into space (id, name, git_path) values ('spc_roles', 'R', 'spaces/spc_roles')`,
      ),
    ).toBe('allowed');
    // Nor can it make itself a table or take the schema.
    expect(await code(api.sql`create table public.escape (id int)`)).toBe('42501');
    expect(await code(api.sql`grant select on secret to current_user`)).toBe('42501');
    await assertMigrated(api);
    await checkRoles(urls);
  });

  test('the service role runs the wake queue in its own schema, which it installs', async () => {
    if (!server) return;
    const urls = await setUpDatabaseRoles({ operatorUrl: await freshDatabase() });
    const queue = await startQueue(urls.api, { createSchema: false });
    try {
      await queue.boss.send(QUEUES.recoveryScan, { probe: true });
      const [job] = await queue.boss.fetch(QUEUES.recoveryScan);
      expect(job?.data).toEqual({ probe: true });
    } finally {
      await queue.stop();
    }
  });

  test("an upgrade from the current main's deployment, with data, works and keeps secrets readable for effects", async () => {
    if (!server) return;
    const operatorUrl = await freshDatabase();
    const { spaceId, secretId } = await currentMainDeployment(operatorUrl);
    const urls = await setUpDatabaseRoles({ operatorUrl });
    const api = connect(urls.api);
    const effects = connect(urls.effects);
    // The operator's tables went to the schema's owner; the queue's to the service.
    const byDatabase = openDatabase(operatorUrl, 1);
    try {
      const rows = await byDatabase.sql<{ schemaname: string; tableowner: string }[]>`
          select distinct schemaname, tableowner from pg_tables
          where schemaname in ('public', 'drizzle', 'pgboss') order by 1, 2`;
      expect(rows.map((row) => `${row.schemaname}:${row.tableowner}`)).toEqual([
        'drizzle:melete_migrate',
        'pgboss:melete_api',
        'public:melete_migrate',
      ]);
    } finally {
      await byDatabase.close();
    }
    // The data is all there, and the service's role reads it.
    const [kept] = await api.sql`select name from space where id = ${spaceId}`;
    expect(kept?.name).toBe('Kept');
    // The secret opens through the effects role, and only through it.
    const store = new SealedSecretStore(new PostgresSecretRepository(api.sql), () => MASTER_KEY);
    useEffectsPool(effects.sql);
    try {
      expect(await store.withSecret(secretId, spaceId, async (value) => value)).toBe(
        'a token from before the upgrade',
      );
      // A secret sealed after the upgrade is written and read the same way.
      const later = await store.put(spaceId, 'a token from after');
      expect(await store.withSecret(later, spaceId, async (value) => value)).toBe(
        'a token from after',
      );
    } finally {
      useEffectsPool(undefined);
    }
    await expect(store.withSecret(secretId, spaceId, async (value) => value)).rejects.toThrow();
    // The queue the old deployment made keeps working under the service's role.
    const queue = await startQueue(urls.api, { createSchema: false });
    await queue.boss.send(QUEUES.recoveryScan, { after: 'upgrade' });
    await queue.stop();
    // A second start changes nothing.
    expect(await setUpDatabaseRoles({ operatorUrl })).toEqual(urls);
    await assertMigrated(api);
  });

  test('a space removal takes its secrets through the effects role', async () => {
    if (!server) return;
    const operatorUrl = await freshDatabase();
    const { spaceId } = await currentMainDeployment(operatorUrl);
    const urls = await setUpDatabaseRoles({ operatorUrl });
    const api = connect(urls.api);
    const effects = connect(urls.effects);
    useEffectsPool(effects.sql);
    try {
      await sweepPrincipals(api.sql, spaceId);
      expect(await new PostgresSecretRepository(api.sql).countSpace(spaceId)).toBe(0);
    } finally {
      useEffectsPool(undefined);
    }
  });

  test('a service role that can read secrets is refused at start', async () => {
    if (!server) return;
    const operatorUrl = await freshDatabase();
    const urls = await setUpDatabaseRoles({ operatorUrl });
    const operator = connect(operatorUrl);
    await operator.sql.unsafe(`grant select on secret to ${ROLES.api}`);
    await expect(checkRoles(urls)).rejects.toThrow(/can read secret/);
    // The next start takes the grant back.
    await setUpDatabaseRoles({ operatorUrl });
    await checkRoles(urls);
  });

  test('a managed database whose administrator is not a superuser upgrades the same way', async () => {
    if (!server || !admin) return;
    const password = randomBytes(12).toString('hex');
    await admin.sql.unsafe(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${PROVIDER_ADMIN}') then
           create role ${PROVIDER_ADMIN} login createrole nosuperuser password '${password}';
         else alter role ${PROVIDER_ADMIN} login createrole nosuperuser password '${password}'; end if; end $$`,
    );
    // Roles the earlier tests' superuser made own their databases' schemas; with
    // those gone, this administrator makes its own.
    for (const name of databases.splice(0))
      await admin.sql`drop database if exists ${admin.sql(name)} with (force)`;
    for (const role of Object.values(ROLES)) await admin.sql.unsafe(`drop role if exists ${role}`);
    const superUrl = await freshDatabase(PROVIDER_ADMIN);
    const operatorUrl = roleUrl(superUrl, PROVIDER_ADMIN, password);
    const { spaceId, secretId } = await currentMainDeployment(operatorUrl);
    const urls = await setUpDatabaseRoles({ operatorUrl });
    const api = connect(urls.api);
    const effects = connect(urls.effects);
    expect(await code(api.sql`select * from secret`)).toBe('42501');
    useEffectsPool(effects.sql);
    try {
      const store = new SealedSecretStore(new PostgresSecretRepository(api.sql), () => MASTER_KEY);
      expect(await store.withSecret(secretId, spaceId, async (value) => value)).toBe(
        'a token from before the upgrade',
      );
    } finally {
      useEffectsPool(undefined);
    }
  });

  test('roles the administrator made are used as given', async () => {
    if (!server || !admin) return;
    const operatorUrl = await freshDatabase();
    const made: Record<string, string> = {};
    for (const role of ['l3_migrate', 'l3_api', 'l3_effects']) {
      const password = randomBytes(12).toString('hex');
      await admin.sql.unsafe(`drop role if exists ${role}`).catch(() => {});
      await admin.sql.unsafe(`create role ${role} login password '${password}'`);
      made[role] = roleUrl(operatorUrl, role, password);
    }
    const name = new URL(operatorUrl).pathname.slice(1);
    await admin.sql.unsafe(`grant create on database ${name} to l3_migrate`);
    const urls = await setUpDatabaseRoles({
      operatorUrl,
      provided: {
        migrate: made.l3_migrate ?? '',
        api: made.l3_api ?? '',
        effects: made.l3_effects ?? '',
      },
    });
    expect(urls.api).toBe(made.l3_api ?? '');
    const api = connect(urls.api);
    expect(await code(api.sql`select * from secret`)).toBe('42501');
    await checkRoles(urls);
  });
});
