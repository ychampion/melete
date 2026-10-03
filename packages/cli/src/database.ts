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
