# Upgrading between releases

An upgrade moves a running Compose installation from one tagged release to a
later one. `deploy/scripts/upgrade.ts` carries out the procedure on this page;
`--dry-run` prints every command it would run, and the rollback, without
executing any of them.

Read the target release's [changelog](../CHANGELOG.md) entry first. Releases are
upgraded in order of their tags; moving to an older tag is a
[rollback](#rolling-back), not an upgrade.

## What an upgrade changes

- **The source tree** is checked out at the tag.
- **The images** are rebuilt from it. Each is tagged with the release version
  as well as `:local`, which is the name Compose starts. The images that were
  running are kept under the previous version's name.
- **The database schema** is migrated by the service itself. At every boot,
  before the API listens, the service takes a Postgres advisory lock and applies
  whatever its migration journal has that the database has not recorded. A
  second boot, or the slower of two services starting at once, finds nothing to
  do. Because the API does not listen until this finishes, a health check cannot
  pass ahead of the migrations.

Migrations only go forward. There is no down migration: returning to the
previous release means restoring the database backup taken before the upgrade.
That is why the backup comes first and is never skipped.

The volumes (`spaces`, `artifacts`, `work`, `runtime-home`, `restrictions`) and
`deploy/.env` are not changed by an upgrade. No step removes a volume.

## Before you start

You need what the [install](../README.md#install-on-a-linux-docker-host) needs:
Docker Engine 28.0 or newer, Docker Compose 2.33.1 or newer, Bun, and an account
that can use the Docker socket. The stack must be running and healthy, because
the database is dumped from the running `postgres` service.

```bash
cd melete
git fetch --tags origin
bun run deploy/scripts/upgrade.ts v0.2.0 --dry-run
```

The dry run performs the read-only preflight and prints the plan. It exits
non-zero when the preflight found a problem; the plan is printed either way.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print the preflight result, the plan and the rollback. Execute nothing. |
| `--backup-dir /absolute/parent` | Parent directory for this run's backup. Default: `~/melete-backups`. It must exist. |
| `--browser` | Include `deploy/docker-compose.browser.yml` in every Compose command and stop the browser worker with the other writers. Use it if you start the stack with that override. |
| `--wait-timeout seconds` | How long `up --wait` may take. Default 300. Image builds are not bounded by it. |

## Preflight

Nothing is stopped or written until every check passes:

- **A clean working tree.** Local edits are refused, except under
  `deploy/config/`, which holds your connection configuration. Edits there are
  refused only when the target release also changes that directory; merge the
  release's version by hand and run the upgrade again. `deploy/.env` is ignored
  by git and is never touched.
- **The tag exists** in this clone, is not the commit already running, and
  descends from it.
- **Docker Engine and Compose versions**, judged the same way the service and
  the configuration generator judge them.
- **The stack**: the `postgres` service is running and the `melete` service has
  a container to archive from.
- **Disk space**: at least 8 GiB free on Docker's data filesystem for the
  rebuild, and room in the backup directory for the measured size of the
  database, `/data` and `/work` plus a fifth. The archives are not compressed.
  The sizes are read from the running `postgres` and `melete` services; if
  either cannot be measured, the upgrade does not start.

## What the script does

1. Creates a private directory, `upgrade-<tag>-<UTC time>`, under the backup
   parent.
2. Stops `melete`, `runtime` and `web`, so the database and the volumes describe
   the same moment. Postgres keeps running.
3. Takes the backup described [below](#the-backup), checks that the dump is a
   readable archive, records checksums, and makes every file private.
4. Tags the running images with the version being left, so a rollback does not
   need a rebuild.
5. Checks out the tag, installs its locked dependencies, and runs its own
   `bun run compose:check`.
6. Builds the images and tags each with the release version as well as `:local`.
7. Starts the stack with `up -d --wait`, which waits for every health check. The
   `melete` health check requires a reachable database, and the API it asks does
   not listen until the migrations have been applied.
8. Reads the migration count from the database until it equals the number of
   entries in the release's journal, and fails if it does not get there.
9. Prints the rollback for this run, with this run's paths and versions.

## The backup

| File | Contents |
| --- | --- |
| `database.dump` | `pg_dump --format=custom` of the whole database, including the queue schema |
| `database.contents` | The archive's table of contents; it exists only if the dump is readable |
| `deploy.env` | `deploy/.env`. It holds the master key: without it the sealed credentials in the database cannot be opened |
| `config/` | `deploy/config/` |
| `data.tar` | `/data`: spaces, artifacts and the restriction journal as it was |
| `work.tar` | `/work`: job workspaces |
| `restrictions.tar` | The restriction journal alone |
| `SHA256SUMS` | Checksums of the files above |

The restriction journal is archived on its own because it has a different
lifetime from the database snapshot. It is the append-only record of what was
forgotten. Keep the newest copy you have independently of any database backup:
an old database is always paired with the newest journal, never with the journal
of its own age, or restoring it would bring back what was removed since. See
[backup and restore](DEPLOYMENT.md#backup-and-restore).

Backup files are created exclusively and are never overwritten; a second run
uses a new directory. The directory contains secrets. Keep it private, and keep
it until the release has run to your satisfaction.

## If the upgrade fails

**Before the checkout** (a failed stop, dump, archive, image tag, or the checkout
itself): the tree,
the `:local` images and the database are untouched. The script starts the
previous release again and says so. Any partial backup stays in its directory.

**After the checkout** (dependencies, the Compose check, the build, startup or
the migration wait): the script changes nothing further. It prints the commands
that were not completed, then the rollback. It does not start the previous
release by itself, because the new release may already have migrated the
database and the old code must not run against a newer schema. Fix the cause and
run the remaining commands yourself, each of which is safe to run again, or roll
back.

## Rolling back

The script prints these steps with the real paths and names; this is their
shape. `<project>` is `COMPOSE_PROJECT_NAME`, `melete` unless you changed it.

```bash
cd melete
# Stop the release. Never add --volumes: the volumes are the installation.
docker compose -f deploy/docker-compose.yml down
# Return the tree, its dependencies and the preserved images to the old release.
git checkout <branch or commit you upgraded from>
bun install --frozen-lockfile
docker tag melete-service:<old version> melete-service:local
docker tag melete-web:<old version> melete-web:local
docker tag melete-runtime:<old version> melete-runtime:local
cp -p <backup>/deploy.env deploy/.env
# Replace only the database volume.
docker volume rm <project>_pgdata
docker compose -f deploy/docker-compose.yml up -d --wait postgres
docker compose -f deploy/docker-compose.yml exec -T postgres sh -c \
  'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' \
  < <backup>/database.dump
# Start only after the restore has finished.
docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 300
docker compose -f deploy/docker-compose.yml ps
```

Three rules make this safe:

- **Restore into an empty database volume.** Do not use `pg_restore --clean`
  over the live schema; the queue's partition foreign keys make that a
  different, unsupported path.
- **Keep the `restrictions` volume as it is now.** It is newer than the dump.
  At startup the service replays the retained journal into the restored
  database before it serves memory or starts job workers, so nothing forgotten
  after the backup comes back. Do not unpack `restrictions.tar`, or the
  `restrictions` directory of `data.tar`, over it.
- **Keep every other volume too.** `data.tar` and `work.tar` are for a damaged
  volume, not for an ordinary rollback. If you do restore `/data` from the
  archive, exclude its `restrictions` directory.

After a rollback, check health, then look at any job that was waiting for an
approval before deciding it. Work done by the new release after the backup is
not in the restored database.

## What is verified, and what is not

- The plan's order, the preflight judgement, the rollback text, the behaviour on
  failure before and after the checkout, the bounded migration wait and the
  redaction of secrets are unit-tested with an injected command runner
  (`deploy/scripts/upgrade.test.ts`). The real runner is tested for binary
  output, file input and refusing to overwrite.
- A database migrated with exactly the journal the `v0.1.0` tag shipped is
  upgraded to the current journal, and a second boot changes nothing; two
  services booting at once apply a newer journal exactly once; and no migration
  released in `v0.1.0` has been edited since
  (`apps/melete/test/integration/migration-upgrade.test.ts`).
- The restore boundary itself, an old database with the newer journal, is the
  [restore proof](DEPLOYMENT.md#backup-and-restore).
- **Not verified:** a run of this script against a live Docker host. The
  commands are the ones the deployment guide documents, but the script as a
  whole has only run against the injected runner.
