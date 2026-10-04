/**
 * The database roles the service runs under, and the step that sets them up.
 *
 * - `melete_migrate` owns the schema and runs the migrations. Only the setup
 *   step uses it; the service is never given it.
 * - `melete_api` is the service's own role. It reads and writes every table
 *   except the sealed secrets (`SECRET_TABLES`), which it cannot read at all.
 *   It owns the wake queue's schema, whose tables the queue manages itself.
 * - `melete_effects` is the role of the code that dispatches effects, the only
 *   code that opens a sealed secret. It reads and writes the secrets and
 *   nothing else.
 *
 * `setUpDatabaseRoles` runs before the service starts (deploy/docker-compose.yml,
 * `database-roles`), on every start, with the operator's database address: the
 * one deploy/.env already holds. It is idempotent, so an upgrade from an
 * installation that ran everything as the operator is the same call: it creates
 * the roles, hands the operator's tables to `melete_migrate`, migrates, grants,
 * and writes the service's two addresses. A restore with `--no-owner` leaves
 * the operator owning everything again, and the next start hands it back.
 *
 * Each role's password is derived from the operator's address, so every host
 * of one installation derives the same ones, and a new host after a restore
 * needs nothing copied. Where the operator cannot create roles (some managed
 * databases), the operator creates them and gives their addresses instead.
 */
import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { initializeTestLedger } from '../connectors/test.ts';
import { openDatabase } from './client.ts';
import { migrateDatabase } from './migrate.ts';

export const ROLES = {
  migrate: 'melete_migrate',
  api: 'melete_api',
  effects: 'melete_effects',
} as const;

export type RoleUrls = { migrate: string; api: string; effects: string };

/** The tables only `melete_effects` may read: each row is a credential sealed under the master key. */
export const SECRET_TABLES = ['secret'] as const;

/** The schema the wake queue keeps its tables in (jobs/queue.ts). */
export const QUEUE_SCHEMA = 'pgboss';

/** A reason the step stopped that the operator acts on; printed as is. */
export class RolesRefusal extends Error {}

/**
 * The operator guide for a database whose administrator cannot create roles.
 * `melete check` prints the same lines.
 */
export const OPERATOR_ROLES_GUIDE = [
  'Create three login roles as the database administrator, each with its own password:',
  '  create role melete_migrate login password <first>;',
  '  create role melete_api login password <second>;',
  '  create role melete_effects login password <third>;',
  '  grant melete_migrate, melete_api to <the user DATABASE_URL names>;',
  '  grant create on database <database> to melete_migrate;',
  '  grant create on schema public to melete_migrate;',
  'Then set MELETE_MIGRATE_DATABASE_URL, MELETE_API_DATABASE_URL and MELETE_EFFECTS_DATABASE_URL in deploy/.env to those roles at the same server and database as DATABASE_URL.',
];

/** The address `url` with its user and password replaced; the server, database and options stay. */
export function roleUrl(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/**
 * A role's password: a keyed hash of the operator's address. The operator's
 * password cannot be recovered from it, and changing that password changes
 * these at the next start.
 */
export function rolePassword(operatorUrl: string, role: string): string {
  return createHmac('sha256', operatorUrl).update(`melete database role ${role} v1`).digest('hex');
}

/** The role a connection address names. */
export const roleOf = (url: string): string => decodeURIComponent(new URL(url).username);

const ident = (sql: Sql, name: string) => sql.unsafe(`select quote_ident($1) as q`, [name]);
async function quoted(sql: Sql, name: string): Promise<string> {
  const [row] = await ident(sql, name);
  return String(row?.q);
}

/** Postgres refused for lack of a privilege. */
const denied = (error: unknown) =>
  (error as { code?: string } | null)?.code === '42501' ||
  /permission denied|must be (superuser|owner|able to SET ROLE|member)/i.test(String(error));

/**
 * Creates or updates the three roles, in the database the operator's address
 * names, and returns their addresses. `provided` is the operator's own roles,
 * when they made them; nothing is created then.
 */
async function ensureRoles(
  operator: Sql,
  operatorUrl: string,
  provided: Partial<RoleUrls>,
): Promise<RoleUrls> {
  const given = provided.migrate && provided.api && provided.effects;
  if (provided.migrate || provided.api || provided.effects) {
    if (!given)
      throw new RolesRefusal(
        'Set all three of MELETE_MIGRATE_DATABASE_URL, MELETE_API_DATABASE_URL and MELETE_EFFECTS_DATABASE_URL, or none of them.',
      );
    return { migrate: provided.migrate, api: provided.api, effects: provided.effects } as RoleUrls;
  }
  const urls = {} as RoleUrls;
  for (const [key, role] of Object.entries(ROLES) as [keyof RoleUrls, string][]) {
    const password = rolePassword(operatorUrl, role);
    const name = await quoted(operator, role);
    // The password is hex, so it is a literal without quoting concerns.
    const [exists] = await operator`select 1 as found from pg_roles where rolname = ${role}`;
    try {
      if (exists) await operator.unsafe(`alter role ${name} with login password '${password}'`);
      else
        await operator.unsafe(
          `create role ${name} with login nosuperuser nocreatedb nocreaterole password '${password}'`,
        );
    } catch (error) {
      if (denied(error))
        throw new RolesRefusal(
          [
            `The user DATABASE_URL names may not create or change the role ${role}.`,
            ...OPERATOR_ROLES_GUIDE,
          ].join('\n'),
        );
      throw error;
    }
    urls[key] = roleUrl(operatorUrl, role, password);
  }
  return urls;
}

/**
 * Lets the operator act as `role`, which handing objects to it needs when the
 * operator is not a superuser. The operator administers the roles it created.
 */
async function joinRole(operator: Sql, role: string) {
  const [row] = await operator`select
    (select rolsuper from pg_roles where rolname = current_user) as superuser,
    pg_has_role(current_user, ${role}, 'SET') as member`;
  if (row?.superuser || row?.member) return;
  await operator.unsafe(`grant ${await quoted(operator, role)} to current_user`);
}

/** Hands every object in `schemas` that `target` does not own to it. */
async function handOver(operator: Sql, schemas: readonly string[], target: string) {
  await operator`select set_config('melete.owner_target', ${target}, false)`;
  await operator.unsafe(
    `do $$
    declare
      target text := current_setting('melete.owner_target');
      r record;
    begin
      for r in
        select n.nspname, c.relname, c.relkind
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and pg_get_userbyid(c.relowner) <> target
          -- A sequence a column owns goes with its table.
          and not (c.relkind = 'S' and exists (
            select 1 from pg_depend d where d.classid = 'pg_class'::regclass
              and d.objid = c.oid and d.deptype in ('a', 'i')))
          -- An extension's objects stay its own.
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
            and d.objid = c.oid and d.deptype = 'e')
      loop
        execute format('alter %s %I.%I owner to %I',
          case r.relkind when 'v' then 'view' when 'm' then 'materialized view'
            when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end,
          r.nspname, r.relname, target);
      end loop;
      for r in
        select t.oid::regtype::text as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = any($1) and t.typrelid = 0 and t.typelem = 0
          and t.typtype in ('e', 'd', 'r', 'm') and pg_get_userbyid(t.typowner) <> target
          and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass
            and d.objid = t.oid and d.deptype = 'e')
      loop
        execute format('alter type %s owner to %I', r.name, target);
      end loop;
      for r in
        select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1) and pg_get_userbyid(p.proowner) <> target
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
            and d.objid = p.oid and d.deptype = 'e')
      loop
        execute format('alter routine %s owner to %I', r.name, target);
      end loop;
    end $$`.replace(/\$1/g, `array[${schemas.map((schema) => `'${schema}'`).join(', ')}]`),
  );
}

/** Grants made by the schema's owner after every migration, so new tables are covered. */
async function grant(migrate: Sql, urls: RoleUrls) {
  const api = await quoted(migrate, roleOf(urls.api));
  const effects = await quoted(migrate, roleOf(urls.effects));
  await migrate.unsafe(`grant usage on schema public to ${api}, ${effects}`);
  await migrate.unsafe(`grant usage on schema drizzle to ${api}, ${effects}`);
  await migrate.unsafe(`grant select on drizzle.__drizzle_migrations to ${api}, ${effects}`);
  await migrate.unsafe(
    `grant select, insert, update, delete on all tables in schema public to ${api}`,
  );
  await migrate.unsafe(`grant usage, select, update on all sequences in schema public to ${api}`);
  for (const table of SECRET_TABLES) {
    const name = await quoted(migrate, table);
    await migrate.unsafe(`revoke all on table ${name} from public, ${api}`);
    await migrate.unsafe(`grant select, insert, update, delete on table ${name} to ${effects}`);
  }
}

export type SetUpOptions = {
  /** The operator's address: deploy/.env's DATABASE_URL. */
  operatorUrl: string;
  /** Roles the operator made, when it cannot create them here. */
  provided?: Partial<RoleUrls>;
  /** Tests only: a journal other than the service's own. */
  migrationsFolder?: string;
  /** The demonstration's test connector keeps a table of its own, made here as the schema's owner. */
  testConnector?: boolean;
};

/** Sets up the roles, migrates as the schema owner, grants, and returns the service's addresses. */
export async function setUpDatabaseRoles(options: SetUpOptions): Promise<RoleUrls> {
  const operatorHandle = openDatabase(options.operatorUrl, 1);
  const operator = operatorHandle.sql;
  let urls: RoleUrls;
  try {
    urls = await ensureRoles(operator, options.operatorUrl, options.provided ?? {});
    const migrateRole = roleOf(urls.migrate);
    const apiRole = roleOf(urls.api);
    const migrateName = await quoted(operator, migrateRole);
    const apiName = await quoted(operator, apiRole);
    const [database] = await operator`select current_database() as name`;
    const databaseName = await quoted(operator, String(database?.name));
    try {
      await joinRole(operator, migrateRole);
      await joinRole(operator, apiRole);
      await operator.unsafe(
        `grant connect on database ${databaseName} to ${migrateName}, ${apiName}, ${await quoted(operator, roleOf(urls.effects))}`,
      );
      await operator.unsafe(`grant create on database ${databaseName} to ${migrateName}`);
      await operator.unsafe(`grant usage, create on schema public to ${migrateName}`);
      // Everything the migrations made goes to the schema's owner; the queue's schema to the
      // service, which installs and maintains its tables itself.
      const [drizzle] =
        await operator`select 1 as found from pg_namespace where nspname = 'drizzle'`;
      if (drizzle) await operator.unsafe(`alter schema drizzle owner to ${migrateName}`);
      await handOver(operator, ['public', 'drizzle'], migrateRole);
      await operator.unsafe(`create schema if not exists ${QUEUE_SCHEMA} authorization ${apiName}`);
      await operator.unsafe(`alter schema ${QUEUE_SCHEMA} owner to ${apiName}`);
      await handOver(operator, [QUEUE_SCHEMA], apiRole);
    } catch (error) {
      if (error instanceof RolesRefusal || !denied(error)) throw error;
      throw new RolesRefusal(
        [
          `The user DATABASE_URL names could not hand the schema to ${migrateRole}: ${error instanceof Error ? error.message : String(error)}.`,
          'It must own the database, or be its administrator.',
          ...OPERATOR_ROLES_GUIDE,
        ].join('\n'),
      );
    }
  } finally {
    await operatorHandle.close();
  }

  const migrateHandle = openDatabase(urls.migrate, 2);
  try {
    await migrateDatabase(migrateHandle, options.migrationsFolder);
    if (options.testConnector) await initializeTestLedger(migrateHandle.sql);
    await grant(migrateHandle.sql, urls);
  } finally {
    await migrateHandle.close();
  }
  await checkRoles(urls);
  return { migrate: urls.migrate, api: urls.api, effects: urls.effects };
}

/**
 * What each of the service's roles may do with the secrets, read from
 * Postgres itself: the API's role must not read them, the effects role must.
 * Throws with what is wrong.
 */
export async function checkRoles(urls: Pick<RoleUrls, 'api' | 'effects'>): Promise<void> {
  const check = async (url: string) => {
    const handle = openDatabase(url, 1);
    try {
      const rows = await handle.sql<{ table: string; readable: boolean; superuser: boolean }[]>`
        select t.name as table, has_table_privilege(t.name, 'select') as readable,
          (select rolsuper from pg_roles where rolname = current_user) as superuser
        from unnest(${SECRET_TABLES as unknown as string[]}::text[]) as t(name)`;
      return rows;
    } finally {
      await handle.close();
    }
  };
  for (const row of await check(urls.api))
    if (row.readable || row.superuser)
      throw new Error(
        `The service's database role (${roleOf(urls.api)}) can read ${row.table}; it must not. Run the database setup again, or give DATABASE_URL a role without that grant.`,
      );
  for (const row of await check(urls.effects))
    if (!row.readable)
      throw new Error(
        `The effects database role (${roleOf(urls.effects)}) cannot read ${row.table}, so no connected account would work.`,
      );
}
