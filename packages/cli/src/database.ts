/**
 * How the melete command reaches the installation's database. The bundled one
 * is reached inside its own postgres container. An external one
 * (`database.external`, deploy/docker-compose.external-db.yml) is reached from
 * a one-off database-client container, the stack's own Postgres image with
 * DATABASE_URL in its environment, so the address and its password never
 * appear on a command line.
 */
import type { DeployConfig } from './deploy-config.ts';

/** The external-database file's client service. */
export const DATABASE_CLIENT = 'database-client';

/**
 * The root certificates libpq checks the server against, set only when the URL
 * asks for verification: the file MELETE_DATABASE_CA_FILE names (handed to the
 * container as PGSSLROOTCERT), or else the image's own public authorities. For
 * any other mode it is unset, because a root file turns libpq's `require` into
 * `verify-ca`. deploy/docker-compose.external-db.yml runs the same line.
 */
export const CLIENT_TLS =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template.
  'case "$DATABASE_URL" in *sslmode=verify-*) export PGSSLROOTCERT="${PGSSLROOTCERT:-system}" ;; *) unset PGSSLROOTCERT ;; esac; ';

/** The addresses an administrator gives when database-roles may not create the roles itself. */
export const ROLE_SETTINGS = [
  'MELETE_MIGRATE_DATABASE_URL',
  'MELETE_API_DATABASE_URL',
  'MELETE_EFFECTS_DATABASE_URL',
] as const;

/**
 * Of the role addresses deploy/.env gives, the ones that name another server
 * or database than DATABASE_URL. The service runs on what they name, so after
 * DATABASE_URL moves to a new database they must move with it.
 */
export function rolesElsewhere(env: Record<string, string>): string[] {
  const parse = (value: string | undefined) => {
    try {
      return new URL(value?.trim() ?? '');
    } catch {
      return null;
    }
  };
  const operator = parse(env.DATABASE_URL);
  if (!operator) return [];
  return ROLE_SETTINGS.filter((name) => {
    if (!env[name]?.trim()) return false;
    const url = parse(env[name]);
    return !url || url.host !== operator.host || url.pathname !== operator.pathname;
  });
}

/** How many tables the database holds outside Postgres's own schemas: none in an empty one. */
export const TABLE_COUNT_SQL =
  "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog', 'information_schema')";

/**
 * Loads the custom-format dump on stdin into the database DATABASE_URL names,
 * run in the database-client container. It loads only into a database that
 * holds no table yet, so it never mixes the backup's tables with tables
 * already there (`pg_restore --clean` would drop only the backup's own, and
 * leave a newer release's behind). It loads in one transaction, so a load that
 * fails part way leaves the database as empty as it found it, ready for the
 * same load again. A refused or failed load reads the dump to its end before
 * it exits, so the command streaming it in sees no broken pipe. A failed one
 * ends with pg_restore's error and what it left, for the restore's report, all
 * in one write as soon as pg_restore stops: Compose soon stops passing on what
 * a container writes once the stream into it has ended.
 */
export const EXTERNAL_LOAD = `${CLIENT_TLS}n=$(psql --dbname="$DATABASE_URL" -X -At -c "${TABLE_COUNT_SQL}") || exit 1; if [ "$n" != 0 ]; then echo "The database DATABASE_URL names already holds $n table(s), and a restore loads only into an empty one. Nothing was loaded." >&2; cat >/dev/null; exit 1; fi; err=$(pg_restore --dbname="$DATABASE_URL" --single-transaction --no-owner --no-privileges --exit-on-error 2>&1); rc=$?; if [ "$rc" = 0 ]; then [ -z "$err" ] || printf '%s\\n' "$err" >&2; exit 0; fi; printf '%s\\n%s\\n%s\\n' "$err" "$(printf '%s\\n' "$err" | grep -E '(error|ERROR|FATAL|HINT): ' | tail -n 2)" "The load was undone: the database DATABASE_URL names holds nothing of it, and the same load can run again." >&2; cat >/dev/null; exit "$rc"`;

/**
 * The connection arguments a psql, pg_dump or pg_restore line takes, read from
 * the container's environment when it runs.
 */
export const connection = (config: DeployConfig): string =>
  config.database.external ? '--dbname="$DATABASE_URL"' : '-U "$POSTGRES_USER" -d "$POSTGRES_DB"';

/** The Compose arguments that run a command where the database client is. */
export const clientCommand = (config: DeployConfig): string[] =>
  config.database.external
    ? ['run', '--rm', '--no-deps', '-T', DATABASE_CLIENT]
    : ['exec', '-T', 'postgres'];

/**
 * A shell line run where the database client is. `script` receives the
 * connection arguments, so `exec psql ${db} -At -c "..."` reaches the bundled
 * database and an external one alike.
 */
export function databaseShell(
  compose: readonly string[],
  config: DeployConfig,
  script: (db: string) => string,
): string[] {
  const tls = config.database.external ? CLIENT_TLS : '';
  return [...compose, ...clientCommand(config), 'sh', '-c', `${tls}${script(connection(config))}`];
}

/** One SQL statement whose answer is a single line, unaligned. */
export const psqlLine = (compose: readonly string[], config: DeployConfig, sql: string) =>
  databaseShell(compose, config, (db) => `exec psql ${db} -At -c "${sql}"`);
