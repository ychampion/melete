# Deployment operations

Start with [Install on a Linux Docker host](#install-on-a-linux-docker-host),
or on a Windows machine with [Windows (Docker Desktop)](#windows-docker-desktop).
On a Linux server, [Using prebuilt images](#using-prebuilt-images) is the
recommended way to run it: the host pulls finished images and never builds.
[Deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records image
sizes, build and startup times, conformance results and clean-host timing from a
measured installation. Timings depend on the host and network; the startup
timeout does not bound image builds.

## Docker Engine and Compose versions

Melete requires **Docker Engine 28.0 or newer** and **Docker Compose 2.33.1 or
newer**. The supervisor speaks Engine API 1.48, which
[Engine 28.0](https://docs.docker.com/engine/release-notes/28/) introduced
together with the `isolated` bridge gateway mode each attempt network uses.
[Compose 2.33.1](https://github.com/docker/compose/releases/tag/v2.33.1) added
`gw_priority` and needs Engine 28.0; volume `subpath` mounts are older, so
`gw_priority` sets the Compose floor.

The requirement is checked in three places, each with one message naming both
versions:

- The service, when `MELETE_RUNTIME_ADAPTER=docker`, asks the engine's
  unversioned `/version` endpoint over the mounted socket before it opens the
  database or anything else. An older engine, an engine that has dropped API
  1.48, or an unreachable socket stops startup; `docker compose logs melete`
  shows the message.
- `bun run deploy/scripts/configure.ts`, and the release's `upgrade.ts` run
  from its copy as [Upgrading](UPGRADING.md#before-you-start) shows, run
  `docker version` and `docker compose version` on the host and refuse an
  unsupported pair before writing or changing anything.
- `bun run doctor --docker` reports the same judgement on demand, and nothing
  else, so it suits a host that only runs the stack. `bun run doctor` judges
  the test prerequisites, and adds the Docker judgement whenever
  `MELETE_CONFORMANCE_COMPOSE=1` is set.

The same three places also judge the machine around the engine. An engine
running Windows containers is refused, and so, on Docker Desktop, is a VM with
less than 4 GB of memory. On Windows they add the checks in
[Windows (Docker Desktop)](#windows-docker-desktop).

The engine may also be on another machine, such as a rented Linux host reached
through `DOCKER_HOST` or a Docker context over `ssh://` or `tcp://` with TLS.
The three places then name that machine in one line. Compose mounts that
machine's `/var/run/docker.sock` and resolves bind mounts such as
`deploy/config` on it, so `configure.ts` measures the socket's group from a
container there, and the upgrade measures free space there.

## Install on a Linux Docker host

Use Docker Engine **28 or newer** and Docker Compose **2.33.1 or newer**, with
the local Docker socket at `/var/run/docker.sock`. Engine 28 introduced the
[isolated bridge gateway mode](https://docs.docker.com/engine/release-notes/28/)
that removes host-network reachability from the sandbox. If Docker is absent,
follow the [Docker Engine installation instructions](https://docs.docker.com/engine/install/)
for your distribution, including the Buildx and Compose plugins.

Run the following in Bash on the Docker host, from an account that can reach
that socket; a root shell works. Have Git, curl and unzip available: as root,
`apt-get update && apt-get install -y git curl unzip ca-certificates` on a
minimal Debian or Ubuntu host, or
`apk add --no-cache bash git curl unzip ca-certificates libstdc++ libgcc` on a
minimal Alpine host, where the Bun binary needs the C++ runtime libraries.

```bash
df -h /
docker version
docker compose version
docker info --format '{{.DockerRootDir}}'
```

Start with at least **10 GB free** on the filesystem holding Docker's data;
20 GB gives room for rebuilds. Ports 3100 and 3101 must be free. Image pulls and
the first build need outbound network access.

Install Bun, clone the repository, and generate the local configuration with
your model provider's key in the environment:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
git clone https://github.com/ychampion/melete.git
cd melete
bun install --frozen-lockfile
read -rs FIREWORKS_API_KEY && export FIREWORKS_API_KEY
bun run deploy/scripts/configure.ts
unset FIREWORKS_API_KEY
```

`configure.ts` writes `deploy/.env` from `deploy/.env.example` with private
permissions, generates independent local secrets, records the Docker socket
group, and writes the key it read into the file without printing it; it refuses
to replace an existing `.env`, and refuses to write one without the key.
Compose reads `deploy/.env`; keep it with your backups. With nothing named it
configures the default provider and model; `--provider` and `--model` choose
another, as [Providers](#providers) lists. For a demo that needs no key, run
`configure.ts --fake` instead: it turns on a scripted provider and a test
connector, which you switch off later as [Providers](#providers) describes.
Then check the configuration and start the stack:

```bash
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 300
docker compose -f deploy/docker-compose.yml ps
```

All four services — `postgres`, `melete`, `runtime` and `web` — come up healthy.
If startup fails, `docker compose -f deploy/docker-compose.yml logs --tail=100`
names the reason. `bun run deploy/scripts/status.ts` prints a readable report of
the whole installation, from Docker and free space to the owner account, with
what to do next for anything that is not ready; it changes nothing and prints no
secret. `bun run deploy/scripts/set-env.ts NAME=value` changes a setting in
`deploy/.env` in place on any platform, and `--from-env NAME` takes a key from
the environment instead of the command line. To pull the published images instead of building them, set
`MELETE_IMAGE_TAG` before starting, as
[Using prebuilt images](#using-prebuilt-images) shows.

Then open **http://localhost:3101** and create the owner account.

Add mail and calendars in **Settings → Connections**. Gmail and iCloud connect
with an app password, and other IMAP and CalDAV accounts with their password.
With your own Google OAuth client set in `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`, Gmail and Google Calendar connect by signing in
with Google instead ([setup](mail-calendar.md#setting-up-your-google-client)).
Outlook.com accepts only its own sign-in: with your own Microsoft app set in
`MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`, Outlook mail and
calendar connect by signing in with Microsoft
([setup](mail-calendar.md#setting-up-your-microsoft-app)).

## The melete command

`bun run melete` looks after an installation from its checkout. Each command
that judges something prints one line per rule, keyed by a stable id such as
`disk.free_mb` or `env.master_key`, with what to do next under any rule that is
not met. `--json` prints the same results as one JSON object for a program
driving the command; `packages/cli/src/schema.ts` describes its shape.

```bash
bun run melete init            # configure.ts, then deploy/melete.deploy.json
bun run melete init --adopt    # describe an installation that is already running
bun run melete check           # the files alone: no Docker, no network
bun run melete doctor          # this machine: Docker, disk in MB, memory, ports, images, registry
bun run melete status          # the running installation, as status.ts reports it
bun run melete set MELETE_PUBLIC_URL=https://melete.example.net
bun run melete logs melete --since 1h
bun run melete backup --estimate && bun run melete backup
bun run melete deploy --checkout --dry-run
bun run melete rollback --dry-run
bun run melete history
```

| Command | What it does |
|---|---|
| `init [configure options]` | Runs `deploy/scripts/configure.ts` with the same options, which writes `deploy/.env`, then writes `deploy/melete.deploy.json` from it. |
| `init --adopt` | Reads the project's containers from the engine (the image the service runs, the overlay files Compose was given, the sandbox profile) and writes `deploy/melete.deploy.json` from them. Only that file is written. |
| `check` | Validates `deploy/melete.deploy.json`, `deploy/.env` against the service's own settings schema with the values Compose would pass it, every variable a Compose file requires, the published ports, the image tag and registry, and the Compose boundary checks. |
| `doctor [--offline]` | Judges the Docker Engine and Compose, free space where Docker keeps its images against `disk.min_free_mb`, the engine's memory, whether each published port is free or already the stack's own, whether each image is present, and whether the registry answers. With an external database it also asks that server for its version and whether the connection is encrypted. `--offline` skips the registry and the database. |
| `status` | The report `deploy/scripts/status.ts` prints, run with the deploy file's overlay files and profiles, with `disk.min_free_mb` as its disk floor. |
| `set NAME=value ...` | Changes settings in `deploy/.env` in place. A key is taken only from the environment, with `--from-env NAME`, and is never printed. Setting `MELETE_IMAGE_TAG`, `MELETE_IMAGE_REGISTRY` or `COMPOSE_PROJECT_NAME` updates `deploy/melete.deploy.json` to match. A new `COMPOSE_PROJECT_NAME` is refused while the current project has containers, since every command would then act on a new, empty installation; `--force` sets it anyway. |
| `logs [service ...]` | `docker compose logs` with the deploy file's overlay files; takes `--since`, `--tail`, `--follow` and `--timestamps`. |
| `deploy [--tag <tag>]` | Updates an installation that runs the published images, in the order [Update](#update) describes. `--dry-run` prints the plan, `--checkout` checks out the commit the images were built from, `--allow-compose-mismatch` runs them with the checkout as it is, and `--skip-backup` or `--backup-to ssh://host:/path` change the backup taken before new migrations. |
| `rollback [--dry-run]` | Goes back to the images the stack ran before the last deploy. When that deploy ran migrations, it prints the database restore instead and exits 3. |
| `backup` | Backs up the database, the restriction journal and the settings into a new private directory under `backup.dir`, as [Backup and restore](#backup-and-restore) describes. `--estimate`, `--with-volumes`, `--dir <path>` and `--to ssh://host:/path` change what and where; `--encrypt-to <age recipient>` or `--encrypt` encrypt every part. The master key is never stored in a backup. |
| `restore <backup> [--plan]` | Checks a backup against its `SHA256SUMS` and prints the steps that restore it. |
| `upgrade <version>` | For an installation that builds its images: runs `deploy/scripts/upgrade.ts` ([Upgrading between releases](UPGRADING.md)) with the deploy file's overlay files. |
| `history [--json]` | The deploys, rollbacks and upgrades recorded in `deploy/.melete/history.jsonl`. |
| `remote <ssh-target> <command>` | Runs any command above on another machine over SSH, in its checkout, as [On a cloud VM](#on-a-cloud-vm) describes. `remote <ssh-target> push` copies this deployment directory's settings there. |

`--deploy-dir <checkout>/deploy` runs a command against another checkout's
deployment directory. The exit code says what happened: 0 done or every check
passed, 1 a check failed, 2 refused with nothing changed, 3 acted but did not
finish, with the next step printed. `init`, `set`, `deploy`, `rollback`,
`backup` and `upgrade` hold a lock, `deploy/.melete/lock`, so two of them never
change the installation at once; a lock left by a process that has ended is
taken over.

### The deploy file

`deploy/melete.deploy.json` records what an installation is beyond what
`deploy/.env` says. It holds no secret, so it can be kept in a repository; the
keys stay in `deploy/.env`. Every key has a default, so `{"contract": 1}` is a
complete file, and `init` writes each one out:

```json
{
  "contract": 1,
  "project": "melete",
  "images": { "registry": "ghcr.io/ychampion", "tag": "main", "channel": "main" },
  "profiles": [],
  "overlays": [],
  "disk": { "min_free_mb": 4096, "pull_margin_mb": 512 },
  "backup": { "dir": "~/melete-backups", "keep": 3 },
  "public_ports": false,
  "database": { "external": false },
  "blobs": { "store": "local" },
  "cells": { "hosts": [] }
}
```

- `project` is `COMPOSE_PROJECT_NAME`. `images.tag` is `MELETE_IMAGE_TAG`, and
  `images.registry` is `MELETE_IMAGE_REGISTRY` or its default. Images built on
  the machine are `"registry": null, "tag": "local", "channel": "local"`;
  `channel` is `main` for `main` or a commit's short sha and `release` for a
  release tag. `check` fails when `deploy/.env` runs something else, or names
  the `local` tag while a registry is set.
- `profiles` takes `sandbox`; `overlays` takes `browser`, `tailscale` and
  `tailscale-kernel` (with `tailscale`), which add their `docker-compose.*.yml`
  files to every Compose command in that order.
- `disk.min_free_mb` is the free space, in MB, below which `doctor` and
  `status` report the machine short of disk. A small host sets its own, below
  1 GB if it must. `pull_margin_mb` is the room an update keeps beyond the
  images it pulls.
- `backup.dir` is where backups are written, and `backup.keep` how many are
  kept there.
- `blobs.store` is `local`, or `s3` with a non-secret `bucket`, an `endpoint`
  (left out for AWS S3) and an optional `region`; the storage keys stay in
  `deploy/.env`. With `s3`, every Compose command adds
  `deploy/docker-compose.blobs-s3.yml`, and `check` fails when `deploy/.env`
  names another bucket or endpoint, or lacks the keys.
- `database.external: true` adds `deploy/docker-compose.external-db.yml` to
  every Compose command: the service uses the server `DATABASE_URL` names, and
  the bundled postgres stays off. `check` requires the URL to ask for TLS.
- `cells.hosts` describes container hosts on other machines; `check` fails
  while the checkout has no `deploy/docker-compose.cells.yml` to run them with.
- `remote.path` is the checkout on the machine `bun run melete remote` reaches,
  absolute or under `~/`, and `remote.cli` the command that runs the melete
  command there, `["bun", "run", "melete"]` by default.
- A contract number the command does not know, or a key it does not know, is
  refused rather than guessed at.

## On a cloud VM

Any Linux virtual machine you reach over SSH can run Melete, and the melete
command drives it from your own computer. The machine needs Docker Engine 28
or newer with the Compose plugin, Bun, a clone of this repository, and an SSH
key or agent that signs in without a prompt (`ssh -o BatchMode=yes <host> true`
works). Put the host name, user, port and key in `~/.ssh/config` and use the
alias.

Name the checkout there in your `deploy/melete.deploy.json`, or pass
`--path` each time:

```json
{ "contract": 1, "remote": { "path": "~/melete" } }
```

```bash
bun run melete remote vm1 init --connect-in-app   # configure there; the model key is pasted in Settings later
bun run melete remote vm1 check
bun run melete remote vm1 doctor
bun run melete remote vm1 status --json
bun run melete remote vm1 deploy --tag main
bun run melete remote vm1 backup --to ssh://backup-host:~/melete-backups
bun run melete remote vm1 logs melete --since 1h
```

Before each command, one SSH call checks that the machine has Bun and a Docker
engine the account can reach, and that no other account there can write the
checkout or its `deploy/`; if any check fails, the command is refused and
nothing on the machine changes. The command then runs in that checkout,
against its `deploy/`, and its output and exit code come back. Quote a path
that starts with `~` (`--path '~/melete'`), so your own shell leaves it for the
remote one.

`bun run melete remote vm1 push` copies the settings that git does not carry:
`deploy/.env`, `deploy/melete.deploy.json` and the files under `deploy/config/`.
`deploy/.env` is streamed into place with mode 0600, and its contents are never
printed or put on a command line. A file that already differs on the machine is
kept, and the push is refused, because a `deploy` or `set` run there changes
`deploy/.env`; `--replace` overwrites it, and `--dry-run` lists what would be
copied. A key belongs in your local `deploy/.env` (`bun run melete set
--from-env NAME`), followed by a push.

### A managed Postgres database

1. Create a Postgres 17 database at your provider, allow the VM through its
   firewall, and copy the connection URL. End it with `?sslmode=verify-full`,
   so the connection is encrypted and the server's certificate is checked.
   A certificate signed by a public authority is checked as it is. When the
   provider signs with an authority of its own (its documentation offers the
   certificate bundle), save that bundle as `deploy/config/database-ca.pem` and
   run `bun run melete set MELETE_DATABASE_CA_FILE=/etc/melete/database-ca.pem`.
   `?sslmode=require` also encrypts, and accepts the server's certificate
   without a check; `check` reports that as a warning.
2. Set it, keeping it out of your shell history, and turn the database on in
   the deploy file:

   ```bash
   read -rs DATABASE_URL && export DATABASE_URL
   bun run melete set --from-env DATABASE_URL
   unset DATABASE_URL
   ```

   ```json
   { "contract": 1, "database": { "external": true } }
   ```

3. `bun run melete check` confirms the URL asks for TLS, and `bun run melete
   doctor` that the server answers, runs Postgres 17 and encrypts the
   connection. Then push and start as usual. `POSTGRES_PASSWORD` stays in
   `deploy/.env` as `init` wrote it, because the base Compose file reads it.

The stack then leaves the bundled postgres off. A one-off `database-client`
container, the stack's own Postgres 17 image, checks that the server accepts
connections before the service starts, and runs `pg_dump` and `psql` for
`backup`, `deploy` and `doctor`. The restriction journal stays on the VM's
volume, and `melete backup` keeps it beside every dump.

### An S3-compatible bucket

Create a bucket and a key limited to it (AWS S3, Cloudflare R2, MinIO and the
like), then:

```bash
bun run melete set MELETE_BLOB_S3_BUCKET=melete-blobs MELETE_BLOB_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
read -rs MELETE_BLOB_S3_ACCESS_KEY_ID && export MELETE_BLOB_S3_ACCESS_KEY_ID
read -rs MELETE_BLOB_S3_SECRET_ACCESS_KEY && export MELETE_BLOB_S3_SECRET_ACCESS_KEY
bun run melete set --from-env MELETE_BLOB_S3_ACCESS_KEY_ID MELETE_BLOB_S3_SECRET_ACCESS_KEY
unset MELETE_BLOB_S3_ACCESS_KEY_ID MELETE_BLOB_S3_SECRET_ACCESS_KEY
```

```json
{ "contract": 1, "blobs": { "store": "s3", "bucket": "melete-blobs", "endpoint": "https://<account>.r2.cloudflarestorage.com" } }
```

### Replacing the VM

With the database and the bucket at a provider, the VM holds only the
settings, the restriction journal and the spaces' files, so a new one takes
over from a backup:

1. On the old VM, or from your computer through `remote`: `bun run melete
   backup` (or `--to ssh://host:/path` when the VM is short of disk). Note the
   image tag `bun run melete history` shows.
2. On the new VM, clone the checkout at the same commit, and copy the backup's
   `deploy.env` to `deploy/.env` (mode 0600) and its `melete.deploy.json`, or
   push your local copies.
3. `bun run melete restore <backup> --plan` checks the backup and prints the
   steps. On a new machine they put the newest restriction journal back before
   the service starts. With an external database that already holds the data,
   skip the `pg_restore` line; to restore into a new database, point
   `DATABASE_URL` at it first.
4. `bun run melete deploy --tag <the same tag>` pulls the images and starts the
   stack, and `bun run melete status` reports it.

## Using prebuilt images

Every push to `main` builds the four Melete images in GitHub Actions and
publishes them to the GitHub Container Registry, so a host can pull finished
images rather than build them. This is the recommended way to run a server: it
needs no build cache, no compilers and far less free disk than a build.

| Image | Built from |
| --- | --- |
| `ghcr.io/ychampion/melete-service` | `deploy/Dockerfile.melete` |
| `ghcr.io/ychampion/melete-web` | `deploy/Dockerfile.web` |
| `ghcr.io/ychampion/melete-runtime` | `packages/runtime-hermes/Dockerfile` |
| `ghcr.io/ychampion/melete-sandbox` | `deploy/Dockerfile.sandbox` |

Each image carries these tags:

- `main`: the latest commit on `main` for which all four images built. The
  tag moves on all four together, only after every one of them is published.
- the commit's first seven characters, such as `023df46`: one build, kept.
- a release's version, such as `v0.3.0`, when that tag is pushed.

The images are built for `linux/amd64`. On another architecture, build from
source as [Install on a Linux Docker host](#install-on-a-linux-docker-host)
shows. They hold no keys or configuration: `deploy/.env` and everything under
`deploy/config` stay on the host. Each image is labelled with the repository
it came from and the commit it was built from:

```bash
docker image inspect ghcr.io/ychampion/melete-service:main \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

### Start from prebuilt images

Install Bun, clone the repository and run `configure.ts` exactly as
[Install on a Linux Docker host](#install-on-a-linux-docker-host) shows; the
checkout still provides the Compose file, the configuration and the scripts.
Then choose the images in `deploy/.env`:

```bash
sed -i 's/^MELETE_IMAGE_TAG=.*/MELETE_IMAGE_TAG=main/' deploy/.env
grep -q '^MELETE_IMAGE_TAG=main$' deploy/.env || echo 'MELETE_IMAGE_TAG=main' >> deploy/.env
```

and pull and start them, without building:

```bash
bun run compose:check
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d --no-build --wait --wait-timeout 300
```

With a docker sandbox ([Sandboxes](#sandboxes)), add `--profile sandbox` to
both `docker compose` lines, or set `COMPOSE_PROFILES=sandbox` in
`deploy/.env`; the computer image is then pulled with the others.

`MELETE_IMAGE_TAG` set to a version, such as `v0.3.0`, stays on that release;
check out the same tag (`git checkout v0.3.0`) so the Compose file matches the
images. `MELETE_IMAGE_REGISTRY` pulls the same names from another registry,
such as a mirror; empty, it is `ghcr.io/ychampion`. Leave `MELETE_IMAGE_TAG`
empty to build from source again: `up -d --build` builds and tags the images
`melete-*:local` as before.

### Update

```bash
bun run melete init --adopt              # once, to write deploy/melete.deploy.json
bun run melete deploy --checkout --dry-run
bun run melete deploy --checkout         # the newest main; --tag v0.3.0 for a release
```

`deploy` reads the profiles, overlay files and disk floors from
`deploy/melete.deploy.json`. Until the new images are all on the machine, each
step either passes or stops with exit 2 and the running stack as it was:

1. It takes the lock and runs `check`.
2. It asks the registry, without pulling, which commit the tag was built from.
   A moving tag such as `main` is pinned to that commit's own tag, so nothing
   moves while the update runs. The Compose file must come from the same
   commit: `--checkout` checks that commit out once the images are here
   (refusing a checkout with changes outside `deploy/config/`), and
   `--allow-compose-mismatch` runs the images with the checkout as it is.
3. It plans: the images whose content differs from what the engine has, and
   the layers they need. The disk it takes is their compressed size times 2.2
   plus `disk.pull_margin_mb`, and the plan is refused unless
   `disk.min_free_mb` is still free after it.
4. When the new release adds migrations, it dumps the database into
   `backup.dir` first, or streams it with `--backup-to ssh://host:/path`.
5. It pulls one image at a time, measuring the disk after each, and stops at
   the first failure or at the floor. Images already pulled are kept, unused.
6. It checks out the commit, if asked, and writes `MELETE_IMAGE_TAG`.

Then it starts the new images with `up -d --no-build --pull never --wait`,
restarts the `melete` service, which looks up the engine image's ID when it
starts, and waits for health again. It checks `/api/health`, that the database
has recorded every migration in the new journal, and that no line of
`bun run melete status` fails that passed before. Only then does it remove the
stack's own images that no tag names any more; an image another project uses,
or one a container still runs, is left alone. A failure after the switch exits
3 and names the way back. Every run is recorded in
`deploy/.melete/history.jsonl`.

The history line for a run is written the moment `MELETE_IMAGE_TAG` changes,
so a run that fails or is cut short after that point is on record too. Compose
reads the shell before `deploy/.env`, so `deploy` and `rollback` are refused in
a shell that exports `MELETE_IMAGE_TAG` at all, since they write it, and every
command that acts on the stack is refused when the shell exports
`MELETE_IMAGE_REGISTRY`, `COMPOSE_PROJECT_NAME` or `MELETE_SANDBOX_DOCKER_IMAGE`
with a value other than `deploy/.env`'s. With the `sandbox`
profile, `melete-sandbox:local` follows the new computer image only when it
was the previous release's published image; an image of your own under that
name is left alone.

To go back, `bun run melete rollback` undoes the newest run that changed the
image tag, finished or not: it deploys the images from before that run, and
returns the checkout with them. When the database records a migration that the
earlier release does not know, because that run or anything since applied it,
the older release cannot run on the newer database, so rollback prints the
restore from the backup taken before the run, and checks that backup is still
there and whole. It refuses when `deploy/.env` names an image tag other than
the one that run switched to. A rollback is itself a run, so a second rollback
goes forward again.

After `melete deploy`, `MELETE_IMAGE_TAG` names the commit's own tag rather
than `main`. `deploy/scripts/update.sh` does an update in the same order with
whole-GB floors and a `git pull --ff-only`, for a checkout without the melete
command; it pulls the tag `deploy/.env` names, so to go back to it, first run
`bun run melete set MELETE_IMAGE_TAG=main`. `melete deploy` supersedes it.

### Switch an installation from source builds

Run `bun run melete set MELETE_IMAGE_TAG=main`, then
`bun run melete deploy --checkout` (list `sandbox` in the deploy file's
`profiles` if the installation uses a docker sandbox). After it reports the
stack healthy, the images built here are no longer used; remove
them and the build cache to recover the space:

```bash
docker builder prune -af
docker image rm melete-service:local melete-web:local melete-runtime:local
```

Keep `melete-sandbox:local` when spaces already have a **Computer**: their
connections name that image, and `melete deploy` (with the `sandbox` profile)
and `update.sh` point it at the pulled sandbox image on every update so those
computers stay current.

### Package visibility

The repository is public, and the published packages are meant to be pulled
without signing in. If a pull answers `denied` or `unauthorized`, a package is
still private. Its owner makes it public once per package: on GitHub, open the
package (the repository's **Packages** list, or the profile's **Packages** tab),
then **Package settings → Danger Zone → Change visibility → Public**, for each
of `melete-service`, `melete-web`, `melete-runtime` and `melete-sandbox`. Until
then, `docker login ghcr.io` with a token that has `read:packages` lets a host
pull them.

## Windows (Docker Desktop)

A Windows machine running Docker Desktop hosts Melete with the same Compose
files, images and commands as a Linux host. You use it from a browser, on that
machine or, through the [Tailscale](#tailscale) override, from your other
devices.

### What the machine needs

- **Docker Desktop with the WSL 2 backend**, on a Windows version
  [Docker supports for it](https://docs.docker.com/desktop/setup/install/windows-install/),
  bringing Docker Engine 28.0 and Compose 2.33.1 or newer.
- **Linux containers**, Docker Desktop's default. Melete's images are Linux
  images; if Docker Desktop was switched to Windows containers, choose
  **Switch to Linux containers** from its menu.
- **At least 4 GB of memory for Docker Desktop's VM**, 6 GB with the browser
  worker: the warm runtime cell and each attempt may each use up to 2 GiB. Under
  the WSL 2 backend the VM's memory is set in `%UserProfile%\.wslconfig`, not in
  Docker Desktop:

  ```ini
  [wsl2]
  memory=6GB
  ```

  Run `wsl --shutdown` afterwards and start Docker Desktop again. Under the
  Hyper-V backend it is **Settings > Resources > Advanced**
  ([Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)).
- **10 GB free** on the drive that holds Docker Desktop's disk image
  (**Settings > Resources > Advanced** shows its location), 20 GB for rebuilds.
- **Git for Windows**, which includes Git Bash, and **Bun**.
- **A short path for the clone**, such as `C:\melete`. Windows limits a path to
  260 characters unless long paths are enabled, and the deepest file
  `bun install` writes sits about 175 characters below the clone's root. If the
  clone must live deeper, enable long paths from an administrator PowerShell,
  then sign out and in again:

  ```powershell
  New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem `
    -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  git config --global core.longpaths true
  ```

### Install

Run every command on these pages in **Git Bash**. They are Bash, and Git Bash
runs them unchanged, including the backup, restore and removal commands, and
provides the `mkdir`, `cp`, `sha256sum`, `chmod` and `df` programs that
`deploy/scripts/upgrade.ts` runs; started from PowerShell, the upgrade names
them and stops before changing anything. Install Bun from PowerShell once, then
open a new Git Bash window:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
git clone https://github.com/ychampion/melete.git /c/melete
cd /c/melete
bun install --frozen-lockfile
bun run doctor --docker
read -rs FIREWORKS_API_KEY && export FIREWORKS_API_KEY
bun run deploy/scripts/configure.ts
unset FIREWORKS_API_KEY
# Or --provider and --model with that provider's key, as Providers lists; --fake for a demo.
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 300
docker compose -f deploy/docker-compose.yml ps
```

Then open **http://localhost:3101** on the Windows machine and continue with the
README's [Run it yourself](../README.md#run-it-yourself).

`bun run doctor --docker` names anything on the list above that is missing:
Docker Desktop not running (nothing answers on its named pipe,
`//./pipe/docker_engine` by default, or the one `DOCKER_HOST` or the current
context names), Windows containers, too little memory for the VM, and a clone
too deep for the path limit, with the setting that lifts it. `configure.ts` and
`upgrade.ts` refuse on the same judgement.

Git Bash rewrites a command-line argument that starts with `/` into a Windows
path before a Windows program sees it: `/var/lib/x` reaches `docker` as
`C:/Program Files/Git/var/lib/x`. The commands on these pages pass container
paths only after a service name (`melete:/data`) or inside quotes, which it
leaves alone. For a command of your own that passes a container path on its own,
prefix it with `MSYS_NO_PATHCONV=1`.

### How the stack reaches Docker Desktop

The Compose files are unchanged. The `melete` service mounts
`/var/run/docker.sock`, and Compose passes that path to the engine as written
([compose-go](https://github.com/compose-spec/compose-go/blob/main/paths/unix.go)
keeps an absolute Unix path for a Windows client talking to a Linux engine).
Docker Desktop resolves it inside its VM, where the socket is
`srwxrw---- root root`: a process may use it when its user or one of its groups
is root ([Docker Desktop's socket permissions](https://github.com/docker/for-win/issues/13898#issuecomment-1934625891)).
The Windows host has no such file, so `configure.ts` starts one container from
the stack's pinned Postgres image, with no network, reads the socket's group and
mode as a container sees them, and writes that group as `DOCKER_GID`: `0` on
current Docker Desktop releases. The service is added to that group and
otherwise runs as its own unprivileged user. A socket only root may write to is
refused, because the service could not use it. On Linux with Docker Engine,
`configure.ts` reads the host's own socket as before.

The other host path in the Compose file, `./config`, is a Windows folder that
Docker Desktop shares into the VM; the service mounts it read-only. The
repository's `.gitattributes` keeps every script, Dockerfile and file the images
run with LF line endings on a Windows checkout, whatever `core.autocrlf` says,
and the images set the execute bit on their entrypoints when they are built, so
a Windows file system's modes never reach a container.

On Windows, `deploy/.env` takes the permissions of its folder rather than
owner-only ones. A clone under `C:\` or your user folder is readable by your
account and by administrators.

### Upgrade, backup and removal

`bun run deploy/scripts/upgrade.ts <tag> --dry-run` works as described in
[upgrading](UPGRADING.md). Its `mkdir -p -m 700 ~/melete-backups` creates the
default backup parent, `C:\Users\<you>\melete-backups`, in Git Bash as on Linux;
`--backup-dir` also takes a Windows path such as `C:/melete-backups`. Docker Desktop keeps images and
volumes on its VM's disk, so the upgrade measures the free space there, from
beside the database volume, rather than on a Windows drive.
[Backup and restore](#backup-and-restore) and
[Remove it completely](#remove-it-completely) run as written in Git Bash.

## Configuration and browser access

Configuration lives in `deploy/.env`, generated once by
`bun run deploy/scripts/configure.ts`, which configures a real model provider as
[Providers](#providers) describes, or with `--fake` for a demo that needs no
model key. The file is private and is not
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

Sign-in and setup attempts are limited per client address, per account and per
known device; [Sign-in limits](#sign-in-limits) gives the exact rules, the one
header the API believes and from whom, and what a restart clears.

On a remote Linux host, tunnel from your own computer and open the same address
there:

```bash
ssh -N -L 3101:127.0.0.1:3101 user@your-linux-host
```

For a public hostname,
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
upstream or relax the origin check. Session cookies are `Secure` in production,
which browsers honour over HTTPS and on localhost, so reach a remote
installation through the SSH tunnel or a TLS proxy rather than over plain HTTP
to its address.

## Tailscale

Reach your installation from your own devices over your tailnet, with no
published port. An optional override runs one Tailscale node beside the stack.
The node joins your tailnet, answers HTTPS at its own tailnet address, and
forwards to the web client on the internal network. It publishes nothing on a
host interface, and Funnel stays off, so the address answers the devices on your
tailnet and nothing else.

The base Compose file is unchanged and the loopback ports stay published. The
tailnet address does replace the one you sign in at, though: a browser is
accepted at the address `MELETE_WEB_ORIGIN` names and at no other, so once that
holds the tailnet address, `http://localhost:3101` and the SSH tunnel
answer the sign-in page but refuse the requests behind it with 403
`origin_rejected`. One address at a time, and the step below chooses it. To go
back to the tunnel, empty `MELETE_WEB_ORIGIN` and recreate the web service with
the command below.

### Prerequisites

- **MagicDNS**, enabled for the tailnet. It publishes the node under a name, and
  that name is the address you open.
- **HTTPS certificates**, enabled for the tailnet. The node terminates TLS
  itself with a certificate issued for that name; without this the node joins
  but has no address to answer HTTPS on.
- **An auth key**, to join the node the first time.
- **A decision about who may reach the node**, if anyone else is on the tailnet:
  the default policy lets every member reach every device, so settle
  [restricting the node to yourself](#restricting-the-node-to-yourself) before it
  joins.

The first two settings are per tailnet and are turned on once, in the Tailscale
admin console under DNS.

### Create an auth key

In the Tailscale admin console, under Settings, generate an auth key. A reusable
key is not needed: the node stores its own key afterwards and rejoins with that.
Make the key **not ephemeral**, so the node keeps its name and its certificate
across restarts.

Paste it into `TS_AUTHKEY` in `deploy/.env`. It is a credential for joining your
tailnet, not for this installation, so treat it as you treat the other values in
that file: keep the file private, and do not paste the key into a shell where it
would be kept in history. Nothing in Melete logs or echoes it, and
`deploy/scripts/upgrade.ts` redacts it from command output like the other keys
in the file.

An OAuth client secret works in place of an auth key. It requires a tag, which
is given through `TS_EXTRA_ARGS`, for example
`TS_EXTRA_ARGS=--advertise-tags=tag:melete`.

### Configure and start

```bash
bun run deploy/scripts/configure.ts --tailscale
```

With the provider's key in the environment as [Providers](#providers) describes,
or with `--fake` beside `--tailscale` for the demonstration, that writes
`TS_HOSTNAME=melete` and leaves `TS_AUTHKEY` empty for you to fill
in. Pass `--tailscale-hostname` to choose another name; it becomes the node's
name and so the host part of the address. On an installation that already has a
`deploy/.env`, set `TS_HOSTNAME` and `TS_AUTHKEY` in that file by hand instead —
`configure.ts` never replaces an existing one.

Then start the stack with the override beside the base file:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml up -d --wait
```

Once the node reports healthy, record the address it answers on:

```bash
bun run deploy/scripts/tailscale-origin.ts
```

That asks the node for its certificate domain, writes
`MELETE_WEB_ORIGIN=https://<node>.<tailnet>.ts.net` into `deploy/.env`, and
prints the one command that gives the running web service the new value:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml up -d --no-deps --force-recreate web
```

This step is not optional. The web client accepts a browser whose `Origin` is
the address the installation is reached at and refuses any other, so until
`MELETE_WEB_ORIGIN` holds the tailnet address, signing in from that address is
refused — and once it does, signing in from `http://localhost:3101` is refused
instead. `docker compose restart` does not apply a changed environment value.

Name both files on every later Compose command for this installation, including
`deploy/scripts/upgrade.ts --tailscale`.

### From a phone or a laptop

Install Tailscale on the device and sign in to the same tailnet. Then open
`https://<node>.<tailnet>.ts.net` and sign in to Melete as usual. There is no
port to forward, no tunnel to keep open, and nothing to expose: the device
reaches the node over the tailnet, and the node reaches only the web service.

Sign-in is unchanged — a password, and a device cookie afterwards. Tailscale
identity is not a sign-in here; see [sign-in](#sign-in-limits) for what the
limits count, and [identity](#tailnet-identity) for why the tailnet name on a
request is not treated as one.

With the override in place each device on the tailnet is counted separately by
the per-address sign-in limits, rather than sharing one bucket as browsers
behind the SSH tunnel do. The node states the device's tailnet address, and the
web server believes it only on a connection from the node itself, which the
override names in `MELETE_WEB_TRUSTED_UPSTREAM`. A browser that sends the same
header from anywhere else is attributed to its own socket, as before.

### Restricting the node to yourself

A tailnet's default policy lets every member reach every device. If other people
are on the tailnet, restrict this node in the tailnet policy file. Tag the node
with `TS_EXTRA_ARGS=--advertise-tags=tag:melete`, then allow only yourself to
reach its HTTPS port:

```json
{
  "tagOwners": {
    "tag:melete": ["autogroup:owner"]
  },
  "grants": [
    {
      "src": ["autogroup:owner"],
      "dst": ["tag:melete"],
      "ip": ["tcp:443"]
    }
  ]
}
```

A tagged node is owned by the tag rather than by the person who joined it, so
the auth key or OAuth client that adds it must be allowed to use the tag.

### Kernel networking

The node runs userspace networking by default. It needs no `/dev/net/tun` and no
added capability, its root filesystem is read only, and it drops every
capability. Throughput is lower than kernel networking, which matters for large
transfers rather than for the client.

Kernel networking is a deliberate opt-in, added as a third file:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml \
  -f deploy/docker-compose.tailscale-kernel.yml up -d --wait
```

That file sets `TS_USERSPACE=false`, maps `/dev/net/tun` and adds `NET_ADMIN`.
It changes nothing else, and `bun run tailscale:compose:check` fails if it ever
grants more than those.

### What the node can reach

The node joins the `edge` network only. It cannot reach the database network or
the runtime network, and it has no Docker socket. The serve configuration in
`deploy/config/tailscale-serve.json` forwards the root of one host to
`http://web:3000` and proxies nothing else, so a device on the tailnet reaches
the sign-in page and whatever a signed-in browser can reach through it. The
[threat model](THREAT-MODEL.md) states this boundary.

`bun run tailscale:compose:check` asserts each of those properties from the
YAML: one added service, the `edge` network only, no published port, no
privilege or device outside the kernel-mode file, a pinned image, bounded logs,
sized temporary filesystems, the health endpoint on the container's own
loopback, the node key on a named volume, the auth key from the environment,
and Funnel off. It runs in the same continuous-integration job as the other
Compose checks.

### Streaming and idle connections

A transcript and a live browser view are long-lived event streams through
`/api`. Both hops keep them open: the node terminates HTTPS without a read,
write or idle timeout of its own and forwards an event-stream response as it
arrives rather than buffering it, and the web server disables its own timeout
for `/api` and passes the response through unchanged. A conversation left open
and quiet stays connected.

### Tailnet identity

Tailscale states the requesting user on a proxied request. Melete does not read
it: the sign-in is a password and a device cookie, and nothing about the tailnet
grants an account. The web server removes every `Tailscale-` header from every
request before it reaches the API, whichever socket it arrived on. Serve
rewrites the fixed set of names it owns and passes any other `Tailscale-`
header on as the browser sent it, so arriving through the node is not evidence
that the node wrote one.

Treating a tailnet identity as a sign-in is a possible later option. It would
mean deciding which tailnet user maps to which account, and what happens when a
device is shared, so it is a separate decision rather than a setting.

### Troubleshooting

**The node is healthy but there is no address.**
`bun run deploy/scripts/tailscale-origin.ts` reports no certificate domain while
the control plane has not issued one. Check that HTTPS certificates are enabled
for the tailnet, then wait for the node to finish joining and run it again. The
node's own view is:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml exec tailscale tailscale status
```

**Signing in is refused with `origin_rejected` and status 403.**
`MELETE_WEB_ORIGIN` does not match the address in the browser's address bar.
Run `tailscale-origin.ts` and recreate the web service with the command it
prints. `http://` instead of `https://`, or a short name instead of the full
tailnet name, is a mismatch; a trailing slash on the setting is not. On `http://localhost:3101`
this is the expected answer once `MELETE_WEB_ORIGIN` holds the tailnet address:
the setting names one address, and that one is now the tailnet's.

**The address resolves but nothing answers.** The node forwards to the `web`
service by name, which needs Docker's resolver, so the override sets
`TS_ACCEPT_DNS=false`. Check that both files were named on the `up` command and
that `web` is healthy.

**The node asks to authenticate again after a restart.** Its state volume is
missing. `tailscale-state` holds the node key; recreating the installation
without it means joining again with a fresh auth key. The
[upgrade](UPGRADING.md) notes that keeping it is optional.

**Funnel.** Confirm it is off with:

```bash
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.tailscale.yml exec tailscale tailscale funnel status
```

## Sign-in limits

Every limit below is counted in Postgres, in `rate_limit_window`, so it holds
across a restart and across every service instance on the same database: a
caller who spreads attempts over several instances meets one limit. Each row is
keyed by a SHA-256 digest of the limiter and its key, so the table names no
address, account or device, and rows are deleted once their limit has expired.
Each limited request is one short write transaction, and a sign-in up to three;
the per-address limit, checked first, bounds how many rows one source can add.
A service started without a database keeps the limits in its own memory, where
each limiter holds at most 1024 keys; further keys share one overflow bucket, so
new keys can neither evict a live wait nor grow memory.

**Whose address counts.** The web proxy sets `X-Melete-Client-Address` on every
request it forwards to the API. The value is the proxy's own socket peer and
replaces anything the browser sent; the proxy still drops `Forwarded` and
`X-Forwarded-*`. The API believes that header only when the connection itself
comes from the peer named by `MELETE_TRUSTED_PROXY`, and only when it holds one
well-formed address. Compose sets `MELETE_TRUSTED_PROXY=web`, the web service on
the edge network, and `bun run compose:check` fails if it names anything else or
if `web` joins another network. The name is resolved when needed and remembered
for 30 seconds (5 seconds while it does not resolve, as before the web
container has started), so a recreated web container is followed without a
restart. From every other peer, including the direct API port 3100, the header
is ignored and the socket source is used; no other forwarding header is read.
Left unset, as in local development, no peer is believed. A spoofed header
therefore cannot mint fresh buckets.

With the default loopback ports, the SSH tunnel, or a TLS reverse proxy
on the host, the web server's socket peer is the Docker gateway, so all browsers
still arrive as one address and the per-address limit below is shared between
them. The known-device rule is what keeps a sign-in available in that case.

**Per client address.** A burst of five attempts, then 1, 2, 4, up to 60
seconds between attempts. A refusal is 429 `login_rate_limited` with
`Retry-After`. For a request without a valid device cookie it is returned
before the body is read; every refusal described here comes before the database
is read or a password is checked. A successful sign-in, or 15 minutes after the
last admitted attempt, restores the burst. A refused request changes nothing: it
neither lengthens the wait nor postpones the reset.

**Per account, for browsers that are new to it.** Every browser without a known
device for the account shares one limiter per account: a burst of ten attempts,
then the same 1 to 60 second backoff and the same 15-minute reset. A successful
sign-in hands back the one attempt it reserved and clears nothing else, so the
limiter counts wrong passwords: correct sign-ins never close it, and one person
signing in does not reopen it for the rest. While it is closed, a correct
password from a new browser also receives 429; at most one attempt per 60
seconds is admitted at the cap.

**Known devices.** A successful sign-in or setup sets `melete_device`
(`HttpOnly`, `SameSite=Strict`, `Secure` in production, 90 days). It holds a
keyed digest of the email, a random identifier, an expiry and an HMAC-SHA-256
signature under a key derived from `MELETE_MASTER_KEY`. It never authenticates
anyone. A browser presenting a valid cookie for the account it is signing in to
skips the address and account limiters and spends its own budget of five
attempts with the same backoff. Requests from other browsers, at the same or any
other address and however many, cannot make that sign-in fail. A cookie for another account, an expired one, or
one that does not verify earns nothing, and the request is limited as a new
browser. Because the key comes from `MELETE_MASTER_KEY`, known devices survive a
restart; changing that key, or running without one as in development where the
key is random per process, makes every browser new again.

**Setup.** `/setup` answers 409 `already_setup` before it parses or hashes
anything once an owner exists. It has its own per-address limiter (burst of
five, the same backoff, 429 `setup_rate_limited`) that spends no sign-in budget.

**Unknown emails.** A sign-in for an email without an account, or an account
without a password, runs the same argon2id verification against a placeholder
hash and returns the same 401, so response time does not reveal which emails
have accounts.

## Forgotten passwords

A signed-in person changes their password under Settings › Account. It asks for
the current password. Every other session of that account is signed out, and
connected apps lose their access and have to be connected again. Wrong current
passwords are limited per account with the same backoff as sign-in.

Someone who has forgotten theirs chooses "Forgot your password?" on the sign-in
page. When the owner's own mailbox is connected, the page can mail a reset link
(30 minutes, at most three an hour). Without one, the person who runs the
install prints a link on the host:

```bash
docker compose exec melete bun run reset-password you@example.com
# Outside Docker, from the checkout, with DATABASE_URL set:
bun run reset-password you@example.com
```

The link uses `MELETE_PUBLIC_URL`; without it the command prints a code to paste
on the reset page instead. A link or code works once, expires after 60 minutes,
and printing a new one cancels the old printed one; asking for a mailed link
leaves a printed one working. Choosing a new password signs the account out
everywhere, connected apps included. Only a digest of each token is stored, and
attempts to use one are limited per client address.

## Providers

`configure.ts` writes a production configuration by default: a real provider,
with its key read from the command's environment and written into `deploy/.env`
without being printed. With nothing named it is the default provider below and
its default model, so only the key is needed:

```bash
read -rs FIREWORKS_API_KEY && export FIREWORKS_API_KEY
bun run deploy/scripts/configure.ts
unset FIREWORKS_API_KEY
```

The key is only needed while `configure.ts` runs, so unset it afterwards; it is
then in `deploy/.env` alone. A key with a space or a line break in it is
refused as mistyped. `--provider` picks another provider and `--model` names its model, which is
required for every provider but the default. Each reads its own variable from
the table below, for example
`bun run deploy/scripts/configure.ts --provider anthropic --model <model id>`
with `ANTHROPIC_API_KEY` exported. An OpenAI-compatible endpoint needs
`OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY`. The `chatgpt` provider
needs no key: the owner signs in once the stack is running, through the
[sign-in routes](#signing-in-to-a-provider). A run whose key is missing is
refused, and nothing is written.

`--connect-in-app` writes the same production configuration with no key at all,
for a key the owner pastes into Settings › Models once the stack is running
([Connecting a model in the app](#connecting-a-model-in-the-app)). The key then
never passes through a shell, which suits a setup run by a coding agent
([SETUP-WITH-AN-AGENT.md](../SETUP-WITH-AN-AGENT.md)).

The `--fake` configuration is the reproducible local demonstration, and only it
turns on the scripted provider and the test connector: no provider key is
required, and sends go to the test destination. To change provider later, edit
`MELETE_DEFAULT_PROVIDER`, `MELETE_DEFAULT_MODEL`, and the matching credential in
`deploy/.env`, and set `MELETE_ENABLE_FAKE_PROVIDER` and
`MELETE_ENABLE_TEST_CONNECTOR` to `false` when those fixtures are no longer
wanted. The service warns at start-up while either of them is on beside a real
provider.

`MELETE_DEFAULT_PROVIDER` is one of exactly these names:

| Provider | Credential | Protocol the runtime is told to speak |
| --- | --- | --- |
| `fireworks` | `FIREWORKS_API_KEY` | chat completions |
| `anthropic` | `ANTHROPIC_API_KEY` | messages |
| `openai` | `OPENAI_API_KEY` | responses |
| `google` | `GOOGLE_API_KEY` | chat completions |
| `chatgpt` | the owner's ChatGPT sign-in | responses |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY`, or OAuth sign-in | chat completions; responses for `gpt-6` models |

Any other name stops the service at start-up with a message naming the setting,
and so does `openai-compatible` without a usable `OPENAI_COMPAT_BASE_URL`. An
OpenAI-compatible endpoint is always selected as `openai-compatible`, whatever
software serves it; the name of that software is not a provider name. A selected
provider with an empty key starts with a warning on the service log, and the
gateway refuses each model call with `provider_key_unavailable` until the key is
set.

Every model request passes the [privacy router](PRIVACY-ROUTER.md), which swaps
sensitive details for placeholders before a cloud provider sees them. Private
conversations use a local model instead: set one under Settings → Privacy, or
with `MELETE_LOCAL_MODEL_URL` (an OpenAI-compatible version prefix on this
machine or a private network, for example `http://127.0.0.1:11434/v1`),
`MELETE_LOCAL_MODEL` and, when the server needs one, `MELETE_LOCAL_MODEL_KEY`.
Listed private values and the vault of swapped details are sealed with
`MELETE_MASTER_KEY`. A configured model whose address is on this machine or
your network is still redacted for, since it may be a proxy to a cloud service,
until the owner confirms under Settings → Privacy that it is a model they run.

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

With `OPENAI_API_KEY` or `OPENAI_COMPAT_BASE_URL` set, the agent can also turn
text into speech. `MELETE_SPEECH_MODEL` names the text-to-speech model it uses;
left empty, it is `gpt-4o-mini-tts`.

`MELETE_DEFAULT_MODEL_VISION` says whether the default model reads images
(`true` or `false`). When it does, the screenshots the agent takes of its own
computer and of paired devices reach it as pictures, scaled to at most 1280
pixels and compressed; the three newest are kept in each request and older ones
are replaced by their text receipt, and compaction starts sooner to leave room
for them. Otherwise the model reads the receipt alone: where the picture was
saved, its size and its digest. Left empty, Melete's model catalog decides,
and an unknown model reads text only. A model chosen in the app carries the
owner's own answer (`supports_vision` on `PUT /model-settings/default`).

`MELETE_DEFAULT_MODEL_NATIVE_SEARCH` says whether the default model searches
the web with its provider's own search tool (`true` or `false`). Left empty,
Melete's model catalog decides: Claude models through the Messages API and
recent OpenAI models through the Responses API do. `false` sends the agent's
searches to Melete's own search instead. Native searches are metered on the job
like any other model call.

`BRAVE_SEARCH_API_KEY` and `TAVILY_API_KEY` are optional. Without either, every
agent still searches the web: with its model's own search where it has one, and
otherwise with a search that needs no key (DuckDuckGo's results page, then
Wikipedia). When a key is set, searches use that API first. The order, the
privacy rules and what each search records are in
[CONNECTORS](CONNECTORS.md#web-search).

The keyless search is not an official API: it reads DuckDuckGo's results page,
which is meant for people, from your server's address, and DuckDuckGo's terms
may not allow automated use. Melete paces it (one request at a time, two
seconds apart, a repeated query reused for ten minutes, nothing sent for
fifteen minutes after DuckDuckGo answers with a robot check), and the service
log says at start when no key is set. DuckDuckGo can still block the address,
and Wikipedia then answers with encyclopedia articles only. For a hosted or
shared installation, set `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY`.

`MELETE_DEFAULT_MAX_OUTPUT_TOKENS` (default `4096`) is the output limit the
gateway gives a model request that names none. The runtime names none unless its
own configuration sets one, so this is the usual ceiling on one reply; a few
hundred tokens truncates ordinary answers. The limit is reserved against the
job's output budget until the call settles at its real usage, and it is lowered
to what the job has left rather than refused. A limit the runtime does name is
never rewritten: it is honoured, or refused when it exceeds the job's budget.

### Connecting a model in the app

The owner can also connect a model from the web app, in Settings › Models, or
in the first-run step that appears while no working model is configured. Pick a
provider, paste its API key (and, for `openai-compatible`, the endpoint's
address), test the connection, choose a model from the provider's list or type
its identifier, and use it. The test makes one small call, the provider's model
list, and says plainly when the key is refused, the address answers 404, or the
provider does not answer in time. Only the setup owner can change a key or the
model; every other account sees which model is active.

A key entered this way is sealed with `MELETE_MASTER_KEY` before it is stored,
so the app refuses to store one while that key is unset. No answer ever carries
a stored key back, only its last four characters, and a change applies from the
next reply without a restart.

The model chosen here, and the keys connected here, are also what Melete's own
background reads use: automatic memory, learning from corrections, the
companies scan, and the auto-review reviewer. `MELETE_MEMORY_PROVIDER` /
`MELETE_MEMORY_MODEL`, `MELETE_COMPANIES_MODEL` and `MELETE_REVIEW_PROVIDER` /
`MELETE_REVIEW_MODEL` still name a model outright for their own use when set.

A key for the `openai-compatible` endpoint is bound to the address it was saved
for, whether the owner typed it or `OPENAI_COMPAT_BASE_URL` named it. If that
address later changes, the stored key is not sent to the new one; paste the key
again for the new address.

Where both are set, the environment wins:

- A provider key in the environment (`FIREWORKS_API_KEY` and the others above,
  or `OPENAI_COMPAT_API_KEY` for the compatible endpoint) is used for that
  provider, shown in the app as set by the operator, and cannot be replaced
  there. Remove it from `deploy/.env` to manage that provider in the app.
- `OPENAI_COMPAT_BASE_URL` fixes the compatible endpoint's address; the app can
  then only add a key for that address.
- `MELETE_DEFAULT_PROVIDER` and `MELETE_DEFAULT_MODEL` are the starting model. A
  model chosen in the app replaces them for new work until the owner picks
  "Use the server default", which goes back to them.

### Signing in to a provider

A sign-in is an alternative to a key for two providers. OpenAI models are
reached either with an API key, as `openai` with `OPENAI_API_KEY` and billed per
use, or with the owner's ChatGPT account, as `chatgpt`, drawing on that
account's plan; pick one with `MELETE_DEFAULT_PROVIDER`. An OpenAI-compatible
endpoint takes either `OPENAI_COMPAT_API_KEY` or, when its OAuth settings are
given, a sign-in. Signing in needs `MELETE_MASTER_KEY`, which seals the tokens the provider
issues. Only the setup owner can sign in or out, and one sign-in serves the
whole installation.

**ChatGPT.** To use it instead of an OpenAI key, set
`MELETE_DEFAULT_PROVIDER=chatgpt` and `MELETE_DEFAULT_MODEL` to a model the
account's plan serves, then sign in with the routes in the table below, as the
owner, from a signed-in session, or with **Sign in with ChatGPT** under **Settings → Models**.
Model access and usage limits
are those of the ChatGPT plan. The sign-in follows the flow of the open-source
Codex CLI and presents its public client, which `MELETE_CHATGPT_CLIENT_ID`
replaces when set. ChatGPT sign-in works for as long as OpenAI keeps this
sign-in open to apps other than its own. It offers two methods:

- **Device code** (the default). Melete shows a short code and a link to
  `auth.openai.com`; open the link on any device, sign in and enter the code.
  Melete checks for completion at the interval the provider asks for.
- **Browser.** Melete returns an address to open. After you approve, the browser
  is sent to `http://localhost:1455/auth/callback`, which does not load, because
  that address is the only one registered for this sign-in. Copy the whole
  address from the address bar and give it to Melete to finish.

**An OpenAI-compatible provider with OAuth.** For an endpoint whose provider
issues OAuth access tokens, register a redirect address with that provider and
set:

| Setting | Value |
| --- | --- |
| `OPENAI_COMPAT_OAUTH_ISSUER` | The issuer; its authorize, token and revocation addresses are read from its metadata |
| `OPENAI_COMPAT_OAUTH_AUTHORIZE_URL`, `OPENAI_COMPAT_OAUTH_TOKEN_URL` | Both, instead of the issuer, for a provider that publishes no metadata |
| `OPENAI_COMPAT_OAUTH_REVOKE_URL` | Optional; where sign-out revokes the grant |
| `OPENAI_COMPAT_OAUTH_CLIENT_ID` | The client registered with the provider |
| `OPENAI_COMPAT_OAUTH_CLIENT_SECRET` | Only for a confidential client |
| `OPENAI_COMPAT_OAUTH_SCOPES` | Space-separated, as the provider names them |
| `OPENAI_COMPAT_OAUTH_REDIRECT_URL` | The registered redirect address |
| `OPENAI_COMPAT_OAUTH_LABEL` | The provider's name on the sign-in button |

Every sign-in uses PKCE and a one-time state. With these set, the signed-in
token is sent to `OPENAI_COMPAT_BASE_URL` in place of `OPENAI_COMPAT_API_KEY`.
Provider addresses must be `https://`, or `http://` on `localhost`. A partial
setting stops the service at start-up with the name of what is missing.

**The sign-in routes.** Each takes the owner's session:

| Route | What it does |
| --- | --- |
| `GET /model-providers/sign-in` | Each provider's name, state (`signed_out`, `pending`, `signed_in` or `sign_in_required`) and, when there is something to do, a sentence saying what |
| `POST /model-providers/{provider}/sign-in` | Starts a sign-in; `{"method": "browser"}` picks the browser method |
| `POST /model-providers/{provider}/sign-in/complete` | Finishes it: `{"sign_in_id": ...}`, plus `"callback_url"` for the browser method. A device sign-in answers `202` until the code is entered |
| `DELETE /model-providers/{provider}/sign-in` | Signs out: removes the tokens and asks the provider to revoke them |

An unfinished sign-in expires after fifteen minutes, and starting another
replaces it. Unfinished sign-ins are held in the service's memory, so a restart
ends them.

**Refresh.** The gateway refreshes the access token before it expires, five
minutes early or at half its lifetime, whichever is sooner, and once per
provider at a time across the whole service. A token the provider refuses is
refreshed on the next call. When the provider refuses the refresh itself, the
tokens are removed, the state becomes `sign_in_required` with a `reason`, the
service log names the provider and the reason, and each model call to that
provider is refused with `provider_sign_in_required` until the owner signs in
again. While the provider cannot be reached, a token that has not yet expired
keeps serving; once it expires, calls are refused with
`provider_credential_unavailable` until a refresh succeeds.

Provider secrets belong to Melete's gateway. Runtime cells receive short-lived
capabilities and surrogate credentials. Do not copy a provider key into a
runtime environment. Configuration fields are listed in
[`deploy/.env.example`](../deploy/.env.example).

After changing provider settings, recreate Melete and the warm runtime:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

### Memory model

Melete reads what each person says in chat and keeps what matters in their
memory. It uses the default provider and model through the same gateway, so the
provider key stays in the gateway. `MELETE_MEMORY_MODEL` names a different model
for this (a smaller one is usually enough), with `MELETE_MEMORY_PROVIDER` when it
is served by another provider; `MELETE_MEMORY_MODEL=off` stops model reads and
keeps structured observations only. `MELETE_MEMORY_DAILY_CALLS` (default `200`)
is how many reads one person's memory may make in a day; raise or lower it for
your provider's cost. A call the provider answers with an error does not count;
a call that was sent and timed out does. When the budget is spent, or the
provider fails, limits or times out, the conversation carries on and the message
waits unread: it is tried again 30 seconds later, then after a gap that doubles
each time, up to 30 minutes, for at most 8 tries or a day. A call that asking
again cannot fix (too large for the model, or a request the provider refuses,
such as a model name it does not serve) ends the message at once. The service
log records each of these as `memory: <reason>`, and `/health` reports
`memory.waiting` and `memory.failed` (messages given up in the last day).

### Voice

`ELEVENLABS_API_KEY` turns on speech, transcription, push-to-talk in chat and
voice mode; speech then uses ElevenLabs in preference to `OPENAI_API_KEY`.
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_SECOND_VOICE_ID`, `ELEVENLABS_SPEECH_MODEL`,
`ELEVENLABS_STREAMING_MODEL` and `ELEVENLABS_TRANSCRIPTION_MODEL` choose voices
and models. `MELETE_VOICE_DAILY_SECONDS` (default `1800`),
`MELETE_VOICE_DAILY_CHARACTERS` (default `20000`) and
`MELETE_VOICE_DAILY_SESSIONS` (default `30`) are what one person may use in a
day. [VOICE](VOICE.md) describes each setting and feature.

### Auto-review

People choose in Settings → Approvals whether an agent's low-risk actions can go
ahead without asking them (see [CAPABILITIES](CAPABILITIES.md#auto-review)). An
action that is reviewed is judged by a separate call to the model new chats use
(the one chosen in Settings → Models, else the default provider and model), made
through the same gateway with the keys connected there. `MELETE_REVIEW_MODEL`
names a different model for this, with `MELETE_REVIEW_PROVIDER` when another
provider serves it.
`MELETE_REVIEW_MODEL=off` runs no reviewer, and every action it would have
reviewed asks the person. `MELETE_REVIEW_TIMEOUT_MS` (default `12000`) is how
long one review may take. `MELETE_REVIEW_HOURLY_LIMIT` (default `60`) is how
many reviews one space may ask for in an hour. A review that times out, fails or
gives an unreadable answer, and any review past the hourly limit, goes to the
person instead, and so does one proposed while the space's other reviews are
still running past the limit. Work inside an agent's own sandbox is decided by a
fixed rule and never calls the model.

## Sandboxes

Sandboxes: connect E2B, Modal or Daytona in Settings → Connections → Sandbox.
The provider's key is entered there and sealed with `MELETE_MASTER_KEY`. Or give
every agent a computer of its own on this host's Docker engine, with no account
and no key: see [sandbox-docker.md](sandbox-docker.md).
`configure.ts` writes `MELETE_SANDBOX_PROJECT`, the label that marks this
installation's sandboxes at the provider; keep it. The other `MELETE_SANDBOX_*`
settings and `MELETE_E2B_PLAN` are optional, with their defaults listed in
`deploy/.env.example`. Set them in `deploy/.env` and recreate the service.

## Storage

Files the service keeps whole and unchanged are stored by their content: each
one is named by its SHA-256, kept once however many things use it, and checked
against that name when it is read back. By default they live on the
`artifacts` volume, under `/data/artifacts`, and need no setting.

To keep them in an S3-compatible bucket instead (AWS S3, Cloudflare R2, MinIO
and the like), set these in `deploy/.env` and recreate the service:

| Setting | Value |
|---|---|
| `MELETE_BLOB_STORE` | `s3` |
| `MELETE_BLOB_S3_BUCKET` | the bucket, which must already exist |
| `MELETE_BLOB_S3_ACCESS_KEY_ID`, `MELETE_BLOB_S3_SECRET_ACCESS_KEY` | keys that may read, write, list and delete in the bucket |
| `MELETE_BLOB_S3_ENDPOINT` | the service's address, such as `https://<account>.r2.cloudflarestorage.com`; empty is AWS |
| `MELETE_BLOB_S3_REGION` | the bucket's region; empty is `us-east-1` |
| `MELETE_BLOB_S3_PREFIX` | optional; every key goes under it, so installations can share one bucket |

The keys are read by the service alone and never reach an agent's computer. The
service stops at start-up with `s3` and a missing bucket or key. Files already
on the volume stay there when the setting changes, so copy each file under
`/data/artifacts/sha256/` into the bucket first, as `<prefix>/sha256/<hash>`.

Each file records what uses it. Once a day the service deletes any file that
nothing uses and that was stored more than seven days ago. Removing a space deletes at once every file
only that space used, and the removal finishes only when the store confirms
they are gone.

## Company map

A scan reads the connected mailbox with the installation's own model, once the
default provider is a real one with its key: the model named by
`MELETE_DEFAULT_MODEL`. `MELETE_COMPANIES_MODEL` names another model for scans
alone, and `MELETE_COMPANIES_PROVIDER` another provider for it. The
demonstration, and an installation whose provider has no key yet, read mail with
the built-in rules instead, which find less and cost nothing.

Model calls are bounded per person: across all their spaces, one person's scans
make at most `MELETE_COMPANIES_DAILY_CALLS` calls in any 24 hours, 500 when it is
unset, and each scan reads at most fifty messages. A message past the allowance
is read on a later scan. Set these in `deploy/.env` and recreate the service.

## Phone notifications

The web app installs to a phone's Home Screen or a desktop as an app, and can
receive Web Push: one push when a decision is waiting, one when a chase
settles, and a weekly "what came back". Pushes are signed with this
installation's own VAPID key pair and encrypted for each browser (RFC 8291), so
no third-party service is involved beyond the browser's own push service, which
sees neither the words nor who they are for.

`configure.ts` writes the key pair to `deploy/.env` as `MELETE_VAPID_PUBLIC_KEY`
and `MELETE_VAPID_PRIVATE_KEY`. An installation configured before push existed
gets a pair with `bun run deploy/scripts/vapid-keys.ts`; add the two lines to
`deploy/.env` and recreate the service. Without the keys the web app does not
offer push and everything else works the same. `MELETE_VAPID_SUBJECT` is who a
push service contacts about this installation, `mailto:` the owner when unset.

A subscription is accepted only for the browser push services (Google, Mozilla,
Apple, Microsoft). `MELETE_PUSH_EXTRA_ORIGINS` adds other origins, comma
separated, for a self-hosted push server; leave it empty otherwise.

Browsers offer push only on a secure origin: `https://`, such as the Tailscale
address in [From a phone or a laptop](#from-a-phone-or-a-laptop), or
`localhost`. On an iPhone or iPad (iOS 16.4 or later), add Melete to the Home
Screen from Safari's Share menu and open it from there; Safari in a tab does not
receive pushes.

Each person chooses under Settings › Notifications what is pushed, at most how
many a day, and how close together events are grouped into one push. Nothing is
sent outside their day hours, in their own time zone, and every push says why
it was sent.

## Engine limits

Three settings bound what one attempt's engine may do. All have working
defaults; change them only for a reason you can name. Set them in `deploy/.env`
and recreate the service with
`docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete`;
each applies from the next attempt started.

`MELETE_ENGINE_MAX_TURNS` (default `150`) is how many iterations one run may
take before the engine stops it. It is a runaway stop, not a cost control: what
an attempt may spend is decided by the job's budget, and a run that has taken
150 turns is looping. Lower it and long legitimate work is cut off in the
middle; raise it and a loop runs longer before anything notices.

`MELETE_COMPACTION_MAX_TOKENS` (default `200000`) is the largest conversation,
in tokens, that may build up before the engine summarises it and carries on with
the summary. The engine would otherwise wait for half the model's context
window, which on a million-token model means every request carries half a
million tokens before the first summary is written. The trigger actually used is
the lowest of this number, the engine's own trigger for that model's window, and
what keeps a request inside the body the gateway accepts — so a number larger
than the model allows changes nothing. Each compaction costs one extra model
call, and a summary is lossy by nature: every durable fact stays on the job's
ledger, not in the conversation.

`MELETE_MODEL_CONTEXT_WINDOW` (no default) is the context window, in tokens, of
the models this deployment serves. Set it when a model is smaller than the
128,000-token figure Melete assumes for a model it does not know: a model with a
32,000-token window would otherwise be told to compact at 96,000, never get
there, and have every request past its own window refused by the provider with
nothing summarised. For a model Melete does know, this may lower the window and
not raise it, because the same catalog figure is what the model gateway's
accounting is keyed on.

`MELETE_RUNTIME_START_TIMEOUT_MS` (default `120000`) is how long, in
milliseconds, an attempt's container may take to start and answer before the
attempt is ended. Raise it on a slow host where the first start after an
upgrade takes longer.

`MELETE_ENGINE_PREWARM` (default `1`; `true` and `false` still read as `1` and
`0`) is how many engine containers are kept loaded ahead of the next attempts.
An engine container takes around ten seconds to load on a small host; a reply
that takes a loaded one starts its model call a second or two after the
message instead. Each spare holds an idle engine's memory. Set `0` on a host
that cannot spare it; replies then wait for their engine to load.

`MELETE_ATTEMPT_CONCURRENCY` (default `4`) is how many attempts run at once,
each in its own engine container. Further work waits for a free slot in a fair
order across chats, routines and quiet work, and the conversation says it is
waiting and how many other tasks are running. Raise it on a host with memory to
spare; each running attempt may use up to 2 GB.

## Spending caps

The engine limits above bound one attempt. Spending caps bound what the whole
installation, and each person on it, may spend on model calls in a day and in a
month. Every model call the service makes counts: agent turns, routines and
background jobs, memory reads, voice asides, the auto-review classifier, the
companies scan, learning proposals, and the model's own web searches with their
per-search fee. Each settled call is recorded in
`model_usage` with its tokens and an estimated cost, and the totals are read
again before every new call.

| Setting | Limit |
| --- | --- |
| `MELETE_SPEND_MONTHLY_USD`, `MELETE_SPEND_DAILY_USD` | Dollars the whole installation may spend in a UTC month or day |
| `MELETE_SPEND_PERSON_MONTHLY_USD`, `MELETE_SPEND_PERSON_DAILY_USD` | Dollars one person may spend |
| `MELETE_SPEND_MONTHLY_TOKENS`, `MELETE_SPEND_DAILY_TOKENS` | Input and output tokens for the whole installation |
| `MELETE_SPEND_PERSON_MONTHLY_TOKENS`, `MELETE_SPEND_PERSON_DAILY_TOKENS` | Tokens for one person |
| `MELETE_SPEND_NOTICE_PERCENT` | When the person is told a limit is close (default `80`) |

Each limit left empty is no limit, which is the default, so an installation
that sets none behaves as before. A call counts against the person who caused
it: in a conversation, whoever wrote the message being answered, so someone at
their limit cannot keep going in another person's conversation and charge it to
them; for a routine or background job nobody has written in, whoever created
it. A memory read counts against the person whose words are read, a voice aside
against the person talking, and a companies scan against the person who started
it.

- At the notice level of any limit, the person sees a quiet line at the top of
  every page, and Settings › Models shows it beside this month's usage. The
  service log records `spending: person warning (month)` once per period.
- At the limit, no new model call is made. The gateway refuses it with
  `402 spending_limit_reached` and a plain sentence: "This month's limit is
  reached; it resets on November 1." A call already answering is never cut
  off; it finishes and is counted. The attempt whose call was refused ends at
  once with that sentence as its result, a conversation shows it as the turn's
  answer, a routine rests until its next run, and no new attempt starts until
  the limit resets.
- While a call runs, the most it can cost (its input and its whole output
  allowance) is held against the limits, so calls running side by side cannot
  all start under one. A call that ends without its usage, cut off part way,
  is counted at what it streamed, estimated.
- A web search past a limit is refused with the same sentence; it is not
  handed to another search backend.
- Memory reads that meet a reached limit wait and are tried again every 30
  minutes until it resets; a voice aside says the limit's sentence.
- Totals are reused for up to two seconds, and holds are kept by each service
  instance, so several instances started at the same moment can overshoot a
  limit by the calls each of them is running.
- To raise a limit, change the setting in `deploy/.env` and recreate the
  service; the new limit applies from the next call.

Dollars are estimates from a price table, per million tokens, keyed
`provider/model` with `*` matching any run of characters. The built-in
estimates cover the providers Melete serves; a model nothing names is charged
at a deliberately high $3 in and $15 out, so it is never counted as free, and
the ChatGPT sign-in and the scripted provider are $0 (their tokens still
count). Give your real prices with `MELETE_MODEL_PRICES`, which is matched
before the built-in table:

```bash
MELETE_MODEL_PRICES='{"fireworks/accounts/fireworks/models/deepseek-v4p1-flash":{"input":0.3,"output":1.2},"anthropic/*sonnet*":{"input":3,"output":15,"cached_input":0.3}}'
```

`cached_input` is the price of input read from the provider's cache; left out,
it is a tenth of `input`. A call answered on the person's own model (the local
model a private conversation uses, an endpoint the owner confirmed is on their
device, or an OpenAI-compatible endpoint at a local address) costs nothing and
is recorded as served by `local` where the privacy router sent it there; its
tokens still count. Give such a model a price (for example `"local/*"` or
`"openai-compatible/*"`) to have it counted in dollars. `GET /usage` returns the signed-in person's totals, their limits, the notice and
this month's calls by model; the installation's totals and limits are included
for its owner alone.

Removing a space keeps its calls' amounts, so a limit is not reset by deleting
a space; which space and job they came from is removed with it.

## Model routing

By default every call uses the model chosen in Settings › Models, else
`MELETE_DEFAULT_PROVIDER` and `MELETE_DEFAULT_MODEL`. Three settings, each
written `provider/model` (the provider name before the first slash), let
Melete pick a better model per call:

| Setting | Used for |
| --- | --- |
| `MELETE_MODEL_FAST` | The service's short calls: reading chat into memory, voice-mode asides, the auto-review classifier and the companies scan |
| `MELETE_MODEL_VISION` | An agent request that carries a picture, when the turn's model does not read images |
| `MELETE_MODEL_FALLBACK` | Comma-separated, tried in order when a provider rate-limits (429), times out, fails (5xx) or cannot be reached, before any of the reply has been sent |

For example:

```bash
MELETE_MODEL_FAST=fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct
MELETE_MODEL_VISION=fireworks/accounts/fireworks/models/qwen2p5-vl-32b-instruct
MELETE_MODEL_FALLBACK=fireworks/accounts/fireworks/models/deepseek-v3
```

The rules, in order:

- A model the owner chose in the app always wins for agent turns: those turns
  are never sent to the vision model or a fallback.
- A model on the owner's own machine or network (the OpenAI-compatible endpoint
  at a local address, or one the owner confirmed is on their device) keeps
  every call: side calls stay on it instead of the fast model, and nothing is
  rerouted or sent to a fallback from it.
- A model pinned for one use (`MELETE_MEMORY_MODEL`, `MELETE_REVIEW_MODEL`,
  `MELETE_COMPANIES_MODEL`) wins over the fast model for that use. Learning
  proposals keep the default model.
- Vision stays off unless it is configured: a turn on a model that reads
  images (by the owner's word in Settings, `MELETE_DEFAULT_MODEL_VISION`, or
  Melete's catalog) keeps its pictures on that model. Otherwise the engine is
  only told to send pictures when `MELETE_MODEL_VISION` is set, and each
  request that carries one goes to that model. A request with a picture never
  takes a fallback, since the fallbacks may not read images.
- The gateway relays a request as the engine wrote it, so a vision model or
  fallback is only taken when it speaks the same protocol as the turn's model
  (chat completions, responses or messages); another is ignored. A fallback
  without a key is passed over.
- A request the provider refuses as written (a 400 or 404) is not sent
  elsewhere. Only the protocol and the context window are checked for a
  fallback; one that does not support the request's tools, or a field a
  provider-specific side call adds, answers 400 and the call fails as it would
  have without it.
- Each model named here is checked at start-up: a provider the gateway does
  not have, or one with no key in the environment, is named in a warning on
  the service log.

Each rerouted call is recorded with the model that served it: the trail's
`model_receipt` carries `route` (`vision` or `fallback`) and `routed_from`, and
`model_usage` has the same columns. The refused call before a fallback has its
own receipt.

### Reasoning effort

`MELETE_REASONING_EFFORT_AGENT` (default `medium`) and
`MELETE_REASONING_EFFORT_SIDE` (default `low`) say how hard a reasoning model
thinks on agent turns and on the service's side calls: `none`, `low`,
`medium`, `high`, or `off` to send nothing and keep the provider's default.
`none` is sent as `none` to the models that take it, as `minimal` to GPT-5,
and not at all to the o-series and Gemini Pro. A model that refuses the
parameter is asked again without it, and is not sent it again until the
service restarts. The parameter is only ever added: structured-output fields
and other reasoning settings in the request are kept.
The gateway adds the provider's own parameter, `reasoning.effort` over the
responses protocol and `reasoning_effort` over chat completions, only for
model families that accept it (OpenAI o-series, GPT-5 and GPT-6; DeepSeek,
Qwen 3 and gpt-oss on Fireworks or a compatible endpoint; Gemini 2.5 and
later), and never over a value the request names itself. Anthropic models get
none: extended thinking needs every earlier tool-use turn to carry its
thinking blocks, which a conversation the engine kept without them does not.

## Alerts

The service checks its own health every `MELETE_ALERT_INTERVAL_SECONDS`
(default `60`) and tells the operator when it turns unhealthy:

- the database does not answer;
- the runtime that runs attempts does not answer within five seconds;
- the job queue is stuck: work due more than ten minutes ago has not started;
- the error rate spikes: over the last fifteen minutes, at least five attempts
  or model calls and half or more of them failed, were lost, or were refused by
  the provider.

| Setting | What it does |
| --- | --- |
| `MELETE_ALERT_WEBHOOK_URL` | Receives a JSON POST: `text` (a sentence chat webhooks show), `status` (`unhealthy` or `recovered`), `service`, `version`, `checks` and `time` |
| `MELETE_ALERT_EMAIL_TO`, `MELETE_ALERT_EMAIL_FROM` | Where alert email goes, and its sender (default: the same address) |
| `MELETE_ALERT_SMTP_URL` | The SMTP server alert email is sent through, for example `smtps://alerts%40example.com:app-password@smtp.example.com:465` |
| `MELETE_ALERT_REPEAT_MINUTES` | While unhealthy, how often the alert is sent again (default `60`) |
| `MELETE_OPERATOR_TOKEN` | A bearer token, at least 24 characters, that opens `GET /health/detail` |

Alerts are off until a webhook or an email address is set. One alert is sent
when the service turns unhealthy, again every repeat interval while it stays
so, and one more when it is healthy again. With several instances on one
database, the instance holding the `health-alerts` lease sends them.

`GET /health/detail` (through the web server, `/api/health/detail`) returns
each check with what it found, `200` while all pass and `503` while any fails:

```bash
curl -fsS -H "Authorization: Bearer $MELETE_OPERATOR_TOKEN" https://melete.example.com/api/health/detail
```

These checks run inside the service, so they cannot report the service itself
being down, the host losing power or the network failing. Add an external
uptime check as well: point a monitor such as UptimeRobot, Better Stack or
Healthchecks.io at `https://<your host>/api/health` every minute, alerting
when it fails twice in a row or when the body's `database` is not `ok`. With
the operator token, a monitor that can send a header can watch
`/api/health/detail` instead and alert on any non-200 answer.

## Memory extraction

Deployment memory can extract structured observations without a model. If
unstructured work has no extraction gateway, it stops at the third total claim
with status `rejected` and error `no_extraction_gateway` in `memory_work`.
Queue repair and duplicate deliveries do not restart that terminal work, and an
extraction gateway configured afterwards applies to new work only: evidence
already rejected stays rejected.

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
Those probes cover a Linux Docker host, which is the host this page describes;
macOS, Windows and rootless Docker hosts are outside them, as is a kernel
exploit. See the [threat model](THREAT-MODEL.md) for the boundary and what
rests on it.

Plugins and other stdio MCP servers run in containers the same service starts
through the same socket, one per connection, with a volume of their own and no
network unless their owner named a destination; [CONNECTORS](CONNECTORS.md#where-a-server-runs)
describes each restriction. The service pulls their images on first use, so
the host needs to reach the registries the catalog names. These settings
change them; the defaults need none. Set them in `deploy/.env` and recreate the
service:

| Setting | Default | What it chooses |
| --- | --- | --- |
| `MELETE_MCP_NODE_IMAGE` | `node:22-alpine`, pinned by digest | The image `npx` plugins run in |
| `MELETE_MCP_PYTHON_IMAGE` | `ghcr.io/astral-sh/uv:0.12.17-python3.12-alpine`, pinned by digest | The image `uvx` plugins run in |
| `MELETE_MCP_EGRESS_PORT` | `8789` | The port, inside the service container, of the proxy a plugin with named destinations uses |
| `MELETE_MCP_IDLE_MS` | `600000` | How long a plugin may sit unused before it is stopped |

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
These checks reproduce source identity and enforce dependency locks. Image
digests can differ between builds, because OS package repositories, build
timestamps and build tooling change the resulting bytes; compare the recorded
labels and inventories when rebuilding.

## Running more than one service instance

Several Melete service containers can serve one installation when they share
one Postgres database and one `MELETE_MASTER_KEY`. A load balancer may send any
request to any of them.

**What every instance shares through Postgres.**

- Sign-in and request limits ([Sign-in limits](#sign-in-limits)), the MCP
  server's limits on registrations, tokens, authorization pages and tool calls,
  and the limit on wrong pairing codes.
- Sign-ins waiting for the browser to come back: model providers, Google and
  Microsoft accounts, and remote MCP servers. A sign-in started on one instance
  finishes on any other. Each one is kept in `signin_pending` for at most 15
  minutes, sealed with `MELETE_MASTER_KEY` and found by a digest of its state.
- The key that signs the MCP server's consent page, derived from
  `MELETE_MASTER_KEY`, so a page shown by one instance is accepted by another.
- Jobs, attempts, events, memory and everything else the service stores.

**Work one instance does at a time.** The sandbox sweep and reconciliation, the
learning proposal drain, removing stdio server data for removed connections,
removing what stopped instances left behind, the blob collector, episode and
egress record retention, the background process monitor and the health alerts
each run on the instance that holds that work's lease. A lease is a Postgres advisory lock on a connection the
instance keeps for leases alone, never recycled by age and with TCP keepalives
of about half a minute. Every check asks Postgres whether that connection holds
the lock; a held lease is checked every five seconds, and the sandbox sweep and
reconciliation stop as soon as a check finds the lease lost. When an instance
stops, its connection to the database ends, or its network to the database
breaks, another instance takes the lease the next time it checks for that
work. Leases need a direct connection to Postgres, or a pooler that keeps one
server connection per client; PgBouncer in transaction mode cannot hold them.

**Instances on one Docker engine.** Each instance records itself in
`ops_instance` with a heartbeat every 30 seconds and labels every attempt
container, network and volume it creates, and every stdio server it starts,
with `com.melete.instance`. At start an instance removes only its own leftovers,
unlabelled ones from before this label existed, and those of instances that
stopped. An instance counts as stopped when it stopped cleanly, when its
heartbeat is older than ten minutes, or when its heartbeat is older than two
minutes and no container by its name runs on the engine; an instance whose
database link stalls keeps its cells while its container runs. A configured
`MELETE_INSTANCE_ID` that names no container on the engine has none to find, so
such an instance counts as stopped two minutes after its heartbeat stops. While they run,
one instance removes what a stopped instance left, once a minute.

The instance name is `MELETE_INSTANCE_ID` when set (lower-case letters, digits
and hyphens), otherwise the container's host name, which Docker keeps across a
restart of the same container. Set `MELETE_INSTANCE_ID` only where each
instance has its own environment; replicas started from one Compose service
share theirs and should use their host names. An instance refuses to start
when another running process already uses its name, including when both start
at the same moment, and says so in its log.
After a crash, a restarted container waits up to 45 seconds at start to tell
its own earlier run from another process.

Upgrade the running instance before starting a second one beside it: cells
started by a release without instance labels count as the starting instance's
own.

**What stays with one instance.**

- A paired computer holds its connection open to one instance, and calls for it
  are queued in that instance's memory. Run one instance, or send every
  `/api/device/*` request to the same instance, when computers are paired.
- Spaces' git repositories and the restriction journal are written from the
  service's volumes; instances on different hosts need those volumes shared.
- A stdio MCP server runs on the instance that started it, and each instance
  counts its own running servers against the limit of 16.
- Docker sandboxes keep the time each was last used in the memory of the
  instance that serves them. Which ones background processes keep awake is read
  from the database on every pass, so a container with running processes is
  never stopped for idleness, whichever instance started them.
- Taking over the agent's computer is kept in the memory of the instance that
  serves it. Run one instance, or send every request for a computer to the same
  instance, when people take over the agent's computer; otherwise another
  instance's sweep can suspend a computer while someone is using it.

## Upgrading

[Upgrading between releases](UPGRADING.md) is its own page: the target
release's `deploy/scripts/upgrade.ts`, taken out of its tag, prints the whole
plan with `--dry-run`. An installation that runs the published images updates
with `bun run melete deploy` instead ([Update](#update)). The service migrates its database at every boot under an advisory lock, so the
procedure is a consistent backup, a checkout, a rebuild and a wait for health;
the backup below is its first half.

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
must outlive rotation belong in a log collector you run beside the stack.

## Backup and restore

```bash
bun run melete backup --estimate     # sizes, against the free space where the backup goes
bun run melete backup                # database, journal and settings, online
bun run melete backup --with-volumes # also /data and /work, with the writers stopped
bun run melete backup --to ssh://backup-host:/srv/melete-backups
bun run melete backup --encrypt-to age1...  # every part encrypted with age to that public key
bun run melete restore ~/melete-backups/melete-20261002T101500Z
```

**Keep the master key apart from the backups.** `MELETE_MASTER_KEY` in
`deploy/.env` seals every credential the database holds: connected accounts,
provider keys added in the app, and the rest. A backup stores `deploy/.env`
without it and records only its fingerprint, so a backup alone, or the machine
it is streamed to, cannot open those credentials. Store a copy of the key
somewhere else you control, such as a password manager. Restoring needs it:
`restore` accepts the key in the installation's `deploy/.env`, or exported as
`MELETE_MASTER_KEY` in the terminal (`read -rs MELETE_MASTER_KEY && export
MELETE_MASTER_KEY`), checks it against the fingerprint, and refuses one that
differs. Without that key, the restored database's credentials cannot be
opened, and each account has to be connected again.

**Encryption.** Unencrypted, a backup holds the database (conversations and
memory) and the other keys in `deploy/.env`, protected by its file modes
(0700 directory, 0600 files); every backup says so when it is made.
`--encrypt-to <recipient>` encrypts each part with [age](https://age-encryption.org)
to an `age1...` public key, or an `ssh-ed25519` or `ssh-rsa` one, before it is
written, here or over SSH. `--encrypt` encrypts each part with gpg (AES-256)
under the passphrase exported as `MELETE_BACKUP_PASSPHRASE`. The tool must be
installed on the machine taking the backup. `SHA256SUMS` lists the encrypted
files, so `restore` checks a set without opening it, and its steps decrypt
each part as it is loaded: for age, export `MELETE_BACKUP_IDENTITY` as the path
of the identity file that opens it; gpg asks for the passphrase.

**The S3 bucket is outside the backup.** With `"blobs": { "store": "s3" }`, the
files the service keeps by their content live in the bucket, and a backup holds
only the database's references to them. Protect the bucket at the provider:
turn on versioning (with a lifecycle rule that expires old versions after the
time you keep backups), or copy it on the same schedule as the backups, for
example with `rclone sync` or `aws s3 sync` to a second bucket. A restored
database expects the files as they were when it was backed up, so keep the
bucket's history at least as long as the oldest backup you would restore.

Each backup is a new directory, `melete-<time>`, under `backup.dir` from the
deploy file (`~/melete-backups` by default), readable only by the account that made it. It
holds the database as a custom-format dump, read back with `pg_restore --list`
while it is written; the restriction journal on its own, under a timestamped
name; `deploy/.env` without the master key, the key's fingerprint
(`master-key.fingerprint`), `deploy/config/` and `deploy/melete.deploy.json`;
and a `SHA256SUMS` list. The newest `backup.keep` backups are kept. The default is
online and small, so the stack keeps running; `--with-volumes` stops the
writers to archive the volumes and starts them again. `--to` streams every part
to another machine over SSH and keeps nothing on this disk, for a host short on
space.

`restore` checks a backup's checksums and prints the steps that restore it,
following the rules below: only the database volume is replaced, and the
newest restriction journal is kept. On a machine that never ran the
installation, the newest journal archive beside the backups goes back before
the service starts, keeping its file ownership. A backup counts as whole only when
`SHA256SUMS` lists every file in it and each matches. `backup.keep` never
removes the backup the last deploy took.

The same backup by hand: back up `deploy/.env`, Postgres, and the named volumes containing knowledge,
artifacts, workspaces, and restrictions. Preserve ownership and permissions.
Stop Melete and runtime work before taking the database and volume snapshot so
their durable state is consistent. An installation started with an override
names the same files on each Compose command below, and one running the browser
worker stops `browser` with the others, since it writes into a space. From the
repository root:

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
to choose another parent directory. [Deployment note 0020](../.agents/notes/0020-deployment-evidence.md)
records a measured run and its evidence.

## Remove it completely

Everything Melete keeps lives in Docker volumes and one configuration file, so
taking it off the machine is one command, a sweep and one deletion. Give the
first command the same `-f` files you started the stack with, so it reaches the
browser worker and the Tailscale node when you use them. It stops the stack and
removes its containers and named volumes: the database, your spaces, artifacts,
the work directory, the removal journal and, with the Tailscale file, the node
key. The sweep catches the containers, networks and volumes the service creates
while it runs, for each attempt and for each packaged plugin: those carry
Melete's own labels rather than Compose's, so they are matched by label and by
the Compose project name, which the sweep reads from `deploy/.env`. Delete `deploy/.env` last, because it holds
the master key that unseals anything you backed up.

```bash
docker compose -f deploy/docker-compose.yml down -v --rmi local --remove-orphans
# Started it with the browser worker or Tailscale? Add the same -f files to that line.
name=$(tr -d '\r' < deploy/.env | sed -n 's/^COMPOSE_PROJECT_NAME=//p')
project=label=com.melete.project=${name:-melete}
for owned in label=com.melete.attempt-supervisor=v1 label=com.melete.mcp-launcher=v1; do
  docker ps -aq --filter "$owned" --filter "$project" | xargs -r docker rm -f
  docker network ls -q --filter "$owned" --filter "$project" | xargs -r docker network rm
  docker volume ls -q --filter "$owned" --filter "$project" | xargs -r docker volume rm
done
rm -f deploy/.env
```

What is left afterwards is the source directory you cloned and the images:
`melete-service:local`, `melete-runtime:local` and `melete-web:local`, which
Docker built (or the `ghcr.io/ychampion/melete-*` images, when the installation
pulled them), and `postgres:17-alpine`, plus `tailscale/tailscale` with
Tailscale, which it pulled. Every installation on a host shares these images,
so remove them only when this was the last one:

```bash
docker image rm melete-service:local melete-runtime:local melete-web:local \
  postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
# With Tailscale, also remove:
#   tailscale/tailscale@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680
# With prebuilt images, remove those instead of the :local ones:
#   docker image ls --format '{{.Repository}}:{{.Tag}}' 'ghcr.io/ychampion/melete-*' | xargs -r docker image rm
```

## Removing a space

The owner of a space removes it over the API, with the owner's session cookie.
The request carries the space's name, typed exactly as it is shown, and a
member of the space receives `403`. The request and response types are in
`openapi.json` and the typed client.

| Request | Answer |
|---|---|
| `GET /spaces/{id}/removal/preview` | What the space holds, the services whose keys it uses, and the sentence to confirm |
| `DELETE /spaces/{id}` with `{"confirm_name": "<name>"}` | `202` and the removal; `400` when the name does not match; `409` for the browser worker's space |
| `GET /spaces/{id}/removal` | How far the removal has got, while the space is there |
| `GET /removals/{id}` | The removal and its account, including after the space is gone, for the person who asked |

The space closes inside the request: its work is cancelled, its triggers stop
and its memory stops serving. The rest runs in the background, one phase at a
time: access for every member ends, the removal is written to the restriction
journal, then the space's files go (the space directory with its repository and
history, and each job's workspace), then its rows (work, artifacts, knowledge
records, skills, the companies map, connections and their sealed keys, and
memory). A final count then checks every table, every path and every provider
the space used. The removal reads `complete` only when that count finds nothing
left, and only then is the space row deleted. The runtime removes each attempt's
home volume when the attempt ends, so a removal finds none of those to clear.

A personal space is emptied rather than removed. It keeps its id, its owner
stays signed in, and it comes back with a fresh, empty repository.

Asking again while a removal runs returns the same removal.

The space named by `MELETE_BROWSER_SPACE` cannot be removed while the browser
worker uses it, because the worker mounts that space's directory. Point the
setting at another space and restart the browser worker first.

The job queue can keep the ids of a removed space's jobs and triggers, with no
content, until its own retention clears them; trigger schedules are resynced
within about a minute.

### A blocked removal

When a phase cannot finish, or the final count finds something left, the removal
reads `blocked`, and `blocked_reason` names the provider, path or table. The space
stays closed. Melete tries again a few seconds later, then at growing intervals of
up to a few minutes, going through the whole sweep again, so a removal finishes by
itself once its cause is gone. Before it removes a job's workspace it stops that
job and waits for it to let go. A path named in the reason is usually held open by
another process; stop that process and the next pass removes it.

A personal space opens again as soon as everything in it has gone, even while a
job that was running still holds its workspace open. The removal then reads
`cleaning`, names that workspace, and removes it once the job lets go; it touches
nothing else, so the space can be used in the meantime.

### Removal and backups

The removal is written to the restriction journal before anything is deleted.
Restoring a database snapshot from before the removal, with the current journal,
brings the space's rows back only until startup: the replay closes the space
again, cancels the work that came back with it, and the removal runs to the end.
This holds for every removed space, and for a personal space emptied after the
snapshot was taken; a personal space emptied before it, and used since, is left
as it is. This is one more reason to keep the journal apart from database
snapshots, as described in [Backup and restore](#backup-and-restore).

### What stays at other services

Messages that were sent, files copied elsewhere and pages published to another
service stay where they went. App passwords and connection keys keep working at
the service that issued them until they are revoked there; the preview names
each of those services.
