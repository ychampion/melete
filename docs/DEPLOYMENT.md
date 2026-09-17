# Linux deployment operations

Start with the literal [README install procedure](../README.md#install-on-a-linux-docker-host).
The [deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records the tested revision, image sizes,
build and startup times, conformance results, and clean-host timing. Timings
depend on the host and network; the startup timeout does not bound image builds.

## Configuration and browser access

Configuration lives in `deploy/.env`, generated once by
`bun run deploy/scripts/configure.ts --fake`. The file is private and is not
committed. Its default Compose project is `melete`; change `COMPOSE_PROJECT_NAME`
before first startup when using another project. Use that value consistently
so the supervisor finds the project's networks and work volume.

The default listeners bind to host loopback:

| Address | Service |
| --- | --- |
| `http://localhost:3101` | Web client and same-origin `/api` proxy |
| `http://localhost:3100` | Direct API |
| No host port | Postgres, broker, and runtime API |

Inside Melete, the owner API binds only to the IPv4 address resolved by
`MELETE_API_BIND=melete-api`. Compose assigns that alias only on the edge network;
the API does not listen on runtime or database interfaces. Its transport guard
also rejects requests outside the edge interface's subnet before reaching
`/setup`, `/login`, `/health`, or any other API route. The rejection is a fixed
403 without account state, based on the socket source rather than forwarded
headers. The runtime network can reach the broker/model listener on port 8788.

Login accepts a burst of five attempts per socket source and process, then
requires 1, 2, 4, up to 60 seconds between attempts. A rejection returns 429 and
`Retry-After`; success or 15 idle minutes resets the source's burst. The source
map is bounded. Browsers behind the web proxy share that proxy's bucket;
untrusted forwarding headers cannot create fresh buckets. Restarting Melete
resets these in-memory limits.

Use the SSH tunnel in the README for a remote host. For a public hostname,
terminate TLS in your reverse proxy and forward the whole site to
`http://127.0.0.1:3101`, preserving the request Host and Origin headers. Preserve
streaming responses without buffering or a short idle timeout. Set the exact
external origin in `deploy/.env`, for example:

```dotenv
MELETE_WEB_ORIGIN=https://assistant.example.net
```

Apply a changed environment with:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate web
```

`docker compose restart` does not apply changed environment values. The web
server rejects foreign Origins before proxying to its fixed upstream
`http://melete:8787`; it does not use request forwarding headers to select an
upstream or relax the origin check. Keep production cookies secure. An HTTP
URL on a remote IP address is not the localhost installation path.

## Providers

The `--fake` configuration is the reproducible local demonstration: no provider
key is required, and sends go to the test destination. To configure a real
provider, edit `MELETE_DEFAULT_PROVIDER`, `MELETE_DEFAULT_MODEL`, and the matching
credential in `deploy/.env`. Disable `MELETE_ENABLE_FAKE_PROVIDER` and
`MELETE_ENABLE_TEST_CONNECTOR` when those fixtures are no longer wanted.

`MELETE_DEFAULT_PROVIDER` is one of exactly these names:

| Provider | Credential | Protocol the runtime is told to speak |
| --- | --- | --- |
| `fireworks` | `FIREWORKS_API_KEY` | chat completions |
| `anthropic` | `ANTHROPIC_API_KEY` | messages |
| `openai` | `OPENAI_API_KEY` | responses |
| `google` | `GOOGLE_API_KEY` | chat completions |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY` | chat completions; responses for `gpt-6` models |

Any other name stops the service at start-up with a message naming the setting,
and so does `openai-compatible` without a usable `OPENAI_COMPAT_BASE_URL`. An
OpenAI-compatible endpoint is always selected as `openai-compatible`, whatever
software serves it; the name of that software is not a provider name. A selected
provider with an empty key starts with a warning on the service log, and the
gateway refuses each model call with `provider_key_unavailable` until the key is
set. `configure.ts` without `--fake` prints the same warning when it writes
`deploy/.env`, because the file it writes selects a real provider with its key
still empty.

`MELETE_DEFAULT_MODEL` is the identifier the provider serves, written exactly as
its API expects it. Fireworks identifiers are full account paths; the default is
`accounts/fireworks/models/deepseek-v4p1-flash`. The gateway admits only the
model a job was started with, so a shortened name is refused by the provider,
not corrected.

`OPENAI_COMPAT_BASE_URL` is the endpoint's version prefix, for example
`https://models.example.net/v1`. It is the only provider address that may be
plain `http://`, for a model server on your own machine or network; every
built-in provider stays HTTPS. Over `http://` the key and every prompt travel
unencrypted, so keep it to a network you trust. Inside Compose, `localhost` is
the Melete container itself, so give an address that container can reach. The
gateway refuses a provider whose key is empty: for a server that checks no key,
set `OPENAI_COMPAT_API_KEY` to any non-empty value. Left empty, an `https://`
endpoint falls back to `OPENAI_API_KEY`; a plain `http://` endpoint never
receives `OPENAI_API_KEY`.

`MELETE_DEFAULT_MAX_OUTPUT_TOKENS` (default `4096`) is the output limit the
gateway gives a model request that names none. The runtime names none unless its
own configuration sets one, so this is the usual ceiling on one reply; a few
hundred tokens truncates ordinary answers. The limit is reserved against the
job's output budget until the call settles at its real usage, and it is lowered
to what the job has left rather than refused. A limit the runtime does name is
never rewritten: it is honoured, or refused when it exceeds the job's budget.

Provider secrets belong to Melete's gateway. Runtime cells receive short-lived
capabilities and surrogate credentials. Do not copy a provider key into a
runtime environment. Configuration fields are listed in
[`deploy/.env.example`](../deploy/.env.example); a configured provider is not
evidence that a live model run passed.

After changing provider settings, recreate Melete and the warm runtime:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

## Memory extraction

Deployment memory can extract structured observations without a model. If
unstructured work has no extraction gateway, it stops at the third total claim
with status `rejected` and error `no_extraction_gateway` in `memory_work`.
Queue repair and duplicate deliveries do not restart that terminal work. This
cap does not configure an extraction gateway or automatically retry rejected
evidence when configuration changes.

## Isolation and image provenance

The trusted `melete` service has the Docker socket so it can supervise attempt
containers. Possession of that socket belongs inside the trusted host boundary.
The runtime cells have no socket, run as UID 10001, and use a read-only root
filesystem, dropped capabilities, and resource limits.

Each attempt mounts only its job's subdirectory from the work volume at `/work`.
It has a separate internal network whose only service peer is Melete's broker
and model proxy, and retains Hermes state on a named volume. The warm `runtime`
service uses the `_probe` subdirectory and has no valid job capability.
Linux's isolated bridge mode removes the bridge's host address; live probes,
not the Compose configuration checker alone, establish the network result.
See the [threat model](THREAT-MODEL.md) for the verified boundary and limits.

The runtime build asserts that Hermes tag `v2026.9.7` resolves to commit
`2237be355906fbe6065ce1815711eee52b2d646e`. It also asserts the plugin content
SHA-256, installs the locked Python dependencies, and records both values in
image labels and `/opt/melete-runtime/build-info.json`. Base images and the uv
binary are pinned by digest. Read the built image's labels and copy its inventory:

```bash
docker image inspect melete-runtime:local --format '{{json .Config.Labels}}'
docker compose -f deploy/docker-compose.yml cp runtime:/opt/melete-runtime/sbom.cdx.json ./runtime-sbom.cdx.json
```

The SBOM is a CycloneDX inventory of the Python and OS packages in that image.
These checks reproduce source identity and enforce dependency locks. They do
not promise byte-identical image digests: OS package repositories, build
timestamps, and build tooling can change the resulting bytes. Compare the
recorded labels and inventories when rebuilding.

## Logs

Docker's default `json-file` log has no size limit. Every Compose service, and
every attempt container the supervisor starts, instead rotates a `json-file` log
at 10 MB and keeps five files, so one container holds at most about 50 MB of
log on the host. Read them with Compose:

```bash
docker compose -f deploy/docker-compose.yml logs --since 1h melete
```

The limits live in the `x-logging` anchor at the top of
`deploy/docker-compose.yml`; a changed limit applies when a container is
recreated, not on restart. `bun run compose:check` and
`bun run browser:compose:check` refuse a service without the bound. Logs that
must outlive rotation belong in a collector you run; none is shipped.

## Backup and restore

Back up `deploy/.env`, Postgres, and the named volumes containing knowledge,
artifacts, workspaces, and restrictions. Preserve ownership and permissions.
Stop Melete and runtime work before taking the database and volume snapshot so
their durable state is consistent. From the repository root:

```bash
backup_dir="$HOME/melete-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup_dir"
docker compose -f deploy/docker-compose.yml stop melete runtime web
docker compose -f deploy/docker-compose.yml exec -T postgres sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$backup_dir/database.dump"
cp -p deploy/.env "$backup_dir/deploy.env"
docker compose -f deploy/docker-compose.yml cp -a melete:/data - > "$backup_dir/data.tar"
docker compose -f deploy/docker-compose.yml cp -a melete:/work - > "$backup_dir/work.tar"
chmod 600 "$backup_dir"/*
docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 180
```

The [Compose copy command](https://docs.docker.com/reference/cli/docker/compose/cp/)
uses archive mode to retain ownership. The `/data` archive includes spaces,
artifacts, and the current restriction
journal. Keep a current independent journal copy as described below. Runtime
attempt homes are disposable; jobs recover from Postgres into fresh attempts.

The `restrictions` volume must be retained **independently of older database
snapshots**. It contains the append-only removal journal. When restoring an old
database, pair it with the newest retained journal; restoring an old journal
alongside the old database would also roll back later removals.

Melete's normal startup replays the retained restrictions before opening memory
serving and starting job workers. Missing or invalid retained restrictions keep
the restore gate closed. A health failure is an error to investigate, not a
reason to recreate an empty journal.

Restore the database archive into an **empty database volume**, while retaining
the other volumes and the original `.env`. Do not use `pg_restore --clean` over
the running queue schema: pg-boss partition foreign keys make that a different,
unsupported restore path. Start the normal Compose service only after the
database restore finishes, then verify its health and any waiting job's approval
before deciding it.

To exercise that restore boundary on the disposable `--fake` installation used
for conformance, run:

```bash
MELETE_CONFORMANCE_COMPOSE=1 bun run deploy/scripts/compose-restore.ts
```

This creates a waiting approval and two memory facts, takes a `pg_dump`, forgets
one fact after the snapshot, stops the stack, and replaces only its verified
Postgres volume. It restores the dump into an empty database while keeping the
other volumes, including the newer restriction journal. Before startup, its
verification command rejects the database because replay is missing. It then
starts Melete normally and verifies that the
forgotten fact stays absent, the unrelated fact remains, and the waiting job
finishes with exactly one destination receipt.

Each run writes a private directory under `/tmp/melete-compose-restore` containing
`database.dump` and `evidence.json`. Use `--output-dir /path/to/private-backups`
to choose another parent directory. The [deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records
the measured run and its evidence.
