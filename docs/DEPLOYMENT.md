# Deployment operations

Start with [Install on a Linux Docker host](#install-on-a-linux-docker-host),
or on a Windows machine with [Windows (Docker Desktop)](#windows-docker-desktop).
On a Linux server, [Using prebuilt images](#using-prebuilt-images) is the
recommended way to run it: the host pulls finished images and never builds.
[Deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records image
sizes, build and startup times, conformance results and clean-host timing from a
measured installation. Timings depend on the host and network; the startup
timeout does not bound image builds.

## One-line install

The quickest way to run Melete on a machine with Docker:

```bash
curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | bash
```

On Windows with Docker Desktop, the PowerShell line runs the same script in Git
Bash, so it needs [Git for Windows](https://git-scm.com/download/win):

```powershell
irm https://raw.githubusercontent.com/ychampion/melete/main/install.ps1 | iex
```

The installer checks for Docker Engine 28.0 and Compose 2.33.1 or newer and a
running daemon. It downloads the Compose file, `deploy/.env.example` and
`deploy/config` from the same branch or tag into `~/melete`, writes
`deploy/.env` with the same settings and fresh secrets `configure.ts` writes,
pulls the [prebuilt images](#using-prebuilt-images) and starts them. It needs no
clone, no Bun and no build. Melete then answers at http://localhost:3101.

With no provider key in the environment it starts with the practice model, as
`configure.ts --fake` does; a key added later in **Settings → Models** replaces
it. With `FIREWORKS_API_KEY` exported it uses Fireworks and its default model.
With `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY`, set
`MELETE_MODEL` to the model id as well. An `ELEVENLABS_API_KEY` turns voice on.
Keys are written into `deploy/.env` and never printed.

Running it again downloads the Compose file again, pulls the newer images and
restarts the stack. `deploy/.env`, the files in `deploy/config` and every
volume are kept. Once your account exists, running it again with
`MELETE_BROWSER=1` turns on the [browser worker](browser-worker.md#one-command),
the agent's own browser, with no Bun on the host:

```bash
curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | MELETE_BROWSER=1 bash
```

From then on every run starts the worker too, from its published image. While
the worker is off, the installer's last lines print this command.

| Variable | Default | Effect |
| --- | --- | --- |
| `MELETE_DIR` | `~/melete` | Where the files and `deploy/.env` go |
| `MELETE_REF` | `main` | The branch, tag or commit the files are downloaded from |
| `MELETE_IMAGE_TAG` | `main` | The image tag to run, such as a release's `v0.3.0`; set on a later run, it switches the installation to that tag |
| `MELETE_MODEL` | | The model id, for an Anthropic, OpenAI or Google key |
| `MELETE_NO_OPEN` | | `1` leaves the browser closed |
| `MELETE_COMPUTER` | `1` for a new installation | Every agent gets a [computer of its own](sandbox-docker.md), a container on this Docker engine; `0` leaves it out, and `1` on a later run turns it on. Its image is a download of about 600 MB and takes about 2.3 GB of disk |
| `MELETE_PROJECT` | `melete` | The Compose project name. Chosen when `deploy/.env` is written; a second installation on one machine needs its own, and its own ports |
| `MELETE_PORT` | `3100` | The service's port on `127.0.0.1` |
| `MELETE_WEB_PORT` | `3101` | The web app's port on `127.0.0.1`; the installer prints the address with it |
| `MELETE_BROWSER` | | `1`, once your account exists, turns on the browser worker |
| `MELETE_BROWSER_SPACE` | the first person's space | With `MELETE_BROWSER=1`, the space the worker works for, `sp_...` |

Pass them on the `bash` side of the pipe, where the installer reads them. Put
before `curl`, they go to `curl` instead, and the installer runs with none of
them:

```bash
curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | MELETE_DIR=/srv/melete bash
```

A second installation on the same machine needs a project name and ports of its
own. The installer refuses to start one under a project name another
installation's containers already use, since Compose would hand it that
installation's containers and volumes:

```bash
curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | MELETE_DIR=~/melete2 MELETE_PROJECT=melete2 MELETE_PORT=3200 MELETE_WEB_PORT=3201 bash
```

The health check is `/api/health` on the web app's port (3101 by default). On
the service's own port (3100) the same check is `/health`; `/api/health` there
answers 401.

Afterwards the stack is managed with Compose, for example
`docker compose -f ~/melete/deploy/docker-compose.yml logs` or `down`. The
`bun run melete` commands below need a clone of the repository.

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

### A second installation on this host

Compose names every container, volume and network after the project, and
`deploy/.env.example` names the project `melete` with ports 3100 and 3101. A
second installation that keeps those values is the first one: its `up` replaces
the first installation's containers and opens its database. With the
[one-line install](#one-line-install), give the second one `MELETE_PROJECT`,
`MELETE_PORT` and `MELETE_WEB_PORT`, as shown there.

From a checkout, clone into a directory of its own and give `init` the project
and ports there:

```bash
bun run melete init --project melete-two --api-port 3110 --web-port 3111
```

`init` takes the other options it always does beside these (`--provider`,
`--connect-in-app`, `--public-url` and the rest), and `deploy/scripts/configure.ts`
takes the same three. `init` refuses, with nothing written, a project name
that containers or volumes on this engine already use: another installation's,
or the data of one that was stopped or removed, which this one would otherwise
start on with new secrets. The containers of another installation are named by
the directory they were started from.

Each project keeps its backups in a folder of its own: `~/melete-backups` for
`melete`, and `~/melete-backups/<project>` for any other, so two installations
never prune each other's backups. `--backup-dir <folder>` chooses another, and
`backup.dir` in `deploy/melete.deploy.json` changes it later. An installation
whose deploy file names the folder another installation uses should be given
its own. `melete upgrade` puts its backup in that folder too; an upgrade made
before it did left a second installation's in `~/melete-backups`.

Keep the `MELETE_SANDBOX_PROJECT` that `configure.ts` wrote: it is random for
each installation and tells apart the agents' computers and attempt containers,
which Compose does not manage. Run every command from that installation's own
directory, so its `deploy/.env` names the project; a `docker compose` command
given a Compose file without that `.env` acts on the project `melete`. Its web
address is then **http://localhost:3111**.

Each installation's stack also takes networks from Docker's address pools,
which the whole machine shares, and its agents' networks come from
`MELETE_NETWORK_POOL`, which installations left at the default share too; with
two or more installations, check [Docker address pools](#docker-address-pools)
first.

### Docker address pools

Every network Docker makes without a subnet of its own takes one block from
the engine's address pools. With no `default-address-pools` in
`/etc/docker/daemon.json`, Docker has 31 blocks for the whole machine: fifteen
/16 blocks between 172.17.0.0 and 172.31.255.255, and sixteen /20 blocks in
192.168.0.0/16. Each installation's stack takes four or more, and every other
Compose project on the machine takes its own. When none is left,
`docker compose up` fails with "all predefined address pools have been fully
subnetted".

The networks of chat attempts, agent computers and plugins do not take those
blocks. The service gives each one a /28 (14 addresses) of its own range,
`MELETE_NETWORK_POOL`, which is 10.215.0.0/16 unless you set it, so a /16 holds
4096 of them. The range must be between /8 and /24 in size, and the service
refuses one that overlaps 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 or anything
from 224.0.0.0 up. Change it when it overlaps a route of this machine, such as
your LAN or a VPN, or when two installations on one engine should each keep to
a range of their own: `bun run melete set MELETE_NETWORK_POOL=10.214.0.0/16`.
Set it to `off` to have those networks take blocks from Docker's own pools
instead, as described above.

`bun run melete doctor` reports `docker.address_pools`, how many networks
Docker can still make, and `docker.network_pool`, how many are left in
`MELETE_NETWORK_POOL` (not reported with `off`). Each warns below 8 and fails
at none. `docker.network_pool` also fails when the setting is one the service
refuses, and `bun run melete set` does not write such a value. A
`MELETE_NETWORK_POOL` set in the shell `doctor` runs in is the one Compose
gives the service, over `deploy/.env`'s, so it is the one judged, and
`docker.network_pool_shell` says so, warning when the two differ. A value in
`deploy/.env` that refers to another setting (`${OTHER}` or `$OTHER`) is filled
in by Compose, not by `doctor`, so it is not judged: `docker.network_pool`
warns instead.
`docker.address_pools` also fails when `daemon.json` names only IPv6 pools:
Docker then has no pool for an IPv4 network that names no subnet, and does not
fall back to its built-in ones. To give Docker more, choose a private range
that nothing on your network, VPN or tailnet uses, and name it in
`/etc/docker/daemon.json` (merged with what the file already holds):

```json
{
  "default-address-pools": [{ "base": "10.216.0.0/14", "size": 24 }],
  "live-restore": true
}
```

That is 1024 networks of 254 addresses each. These pools replace Docker's
built-in ones; networks that exist keep their addresses. Check the file with
`dockerd --validate --config-file /etc/docker/daemon.json`, then restart Docker
(`sudo systemctl restart docker`) while no `docker compose up` is running. With
`live-restore`, running containers keep running through the restart. `doctor`
warns when a pool named there, or `MELETE_NETWORK_POOL`, overlaps a route of
this machine (`ip route`
lists them), since a network made from it would hide those addresses from its
containers.

Networks that no container uses hold blocks too; `docker network ls` lists
them. `doctor` also reports `docker.leftover_sandboxes`: the stopped agents'
computers and empty networks whose sandbox project no installation on this
engine uses, which an installation's own clean-up never reaches. Another
installation's computers are never listed; they are told apart by the
`MELETE_SANDBOX_PROJECT` each installation's service runs with, and by the
`melete.install_project` label each computer and its network carry: the Compose
project of the installation that made them. While that project still has a
container or a volume on this engine they are its own, even with the
installation down (`docker compose down` removes its service container but
keeps its volumes); once it has neither, they are listed. They stay its own
after its `MELETE_SANDBOX_PROJECT` changes, too: an agent's paused workspace is
resumed by the name it was made with, so the earlier project's computers can
still be in use. Computers made before
they carried that label are listed with an unknown owner when their sandbox
project is not in use, since an installation that is down cannot be told from
one that was removed that way; check those before
`bun run melete doctor --remove-leftovers` removes them. It removes only the
listed stopped computers and empty networks, and keeps the computers' volumes.

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
bun run melete doctor          # this machine: Docker, its networks, disk in MB, memory, ports, images, registry
bun run melete status          # the running installation, as status.ts reports it
bun run melete set MELETE_PUBLIC_URL=https://melete.example.net
bun run melete logs melete --since 1h
bun run melete browser enable  # the browser worker, for the first person's space
bun run melete backup --estimate && bun run melete backup
bun run melete deploy --checkout --dry-run
bun run melete rollback --dry-run
bun run melete history
bun run melete account list    # every account, and whether it is signed in anywhere
bun run melete feedback        # problem reports people sent from the app
```

| Command | What it does |
|---|---|
| `init [configure options]` | Runs `deploy/scripts/configure.ts` with the same options, which writes `deploy/.env`, then writes `deploy/melete.deploy.json` from it. `--public-url https://your.domain` writes `MELETE_PUBLIC_URL` and `MELETE_WEB_ORIGIN` together; adding `--hosted` also writes an operator token, starting cost guards and `"hosted": true` ([Hosting for other people](#hosting-for-other-people)). `--project <name> --api-port <port> --web-port <port>` set up [a second installation on this host](#a-second-installation-on-this-host), and `--backup-dir <folder>` where its backups go. A project name that containers or volumes on this engine already use is refused, and so is any name while the engine does not answer, unless `--force`. |
| `init --adopt` | Reads the project's containers from the engine (the image the service runs, the overlay files Compose was given, the sandbox profile) and writes `deploy/melete.deploy.json` from them. Only that file is written. It takes `--backup-dir` too. |
| `check` | Validates `deploy/melete.deploy.json`, `deploy/.env` against the service's own settings schema with the values Compose would pass it, every variable a Compose file requires, the published ports, the image tag and registry, the Compose boundary checks, and what [an installation for other people](#hosting-for-other-people) needs. |
| `doctor [--offline] [--remove-leftovers]` | Judges the Docker Engine and Compose, free space where Docker keeps its images against `disk.min_free_mb`, the engine's memory, whether each published port is free or already the stack's own, whether each image is present, and whether the registry answers. With an external database it also asks that server for its version and whether the connection is encrypted. `--offline` skips the registry and the database. `docker.address_pools` counts the networks Docker can still make, and `docker.network_pool` those left in `MELETE_NETWORK_POOL` ([Docker address pools](#docker-address-pools)), and `docker.leftover_sandboxes` lists the agents' computers and networks that sandbox projects no installation on this engine uses left behind; `--remove-leftovers` removes those, and is the only time `doctor` changes anything. |
| `browser enable [--space <id>]` | Turns on the [browser worker](browser-worker.md#one-command) for one space once its account exists: the space's connection and `browser` directory, `MELETE_BROWSER_SPACE` and `MELETE_BROWSER_TOKEN` in `deploy/.env`, the `browser` overlay in `deploy/melete.deploy.json` and the entry in `deploy/config/connections.json`, then builds the worker and starts the stack with it. Running it again changes nothing. `check` and `doctor` report `browser.worker` with this command as the fix. On a host without Bun: `curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh \| MELETE_BROWSER=1 bash`. |
| `status` | The report `deploy/scripts/status.ts` prints, run with the deploy file's overlay files and profiles, with `disk.min_free_mb` as its disk floor, and the `hosted.*` rules `check` reports. |
| `set NAME=value ...` | Changes settings in `deploy/.env` in place. A key is taken only from the environment, with `--from-env NAME`, and is never printed. Setting `MELETE_IMAGE_TAG`, `MELETE_IMAGE_REGISTRY`, `COMPOSE_PROJECT_NAME` or `COMPOSE_PROFILES` updates `deploy/melete.deploy.json` to match (`COMPOSE_PROFILES=sandbox` turns its `sandbox` profile on). A new `COMPOSE_PROJECT_NAME` is refused while the current project has containers started from this checkout, since every command would then act on a new, empty installation; another installation's containers under that name do not count. `--force` sets it anyway. A name Melete does not read is refused, with the closest one it does (`--force` writes a name of your own). `--clear NAME` empties a setting, a key included. Each change ends with how to apply it: the services that read it, recreated with `up -d --force-recreate`, since `docker compose restart` keeps the old values. |
| `logs [service ...]` | `docker compose logs` with the deploy file's overlay files; takes `--since`, `--tail`, `--follow` and `--timestamps`. `--attempts` lists the containers attempts ran in, and `--computers` the agents' computers, found by this installation's labels; with an attempt id or a container name it shows that one's logs, with the same options. |
| `deploy [--tag <tag>]` | Updates an installation that runs the published images, in the order [Update](#update) describes. `--dry-run` prints the plan, `--checkout` checks out the commit the images were built from, `--allow-compose-mismatch` runs them with the checkout as it is, and `--skip-backup` or `--backup-to ssh://host:/path` change the backup taken before new migrations. |
| `rollback [--dry-run]` | Goes back to the images the stack ran before the last deploy. When that deploy ran migrations, it prints the database restore instead and exits 3. |
| `backup` | Backs up the database, the restriction journal, the settings and the files (the spaces, uploads, the shared `/work` and the agents' computers) into a new private directory under `backup.dir`, as [Backup and restore](#backup-and-restore) describes. `--estimate`, `--database-only`, `--offline`, `--dir <path>` and `--to ssh://host:/path` change what and where; `--encrypt-to <age recipient>` or `--encrypt` encrypt every part. The master key is never stored in a backup. |
| `restore <backup> [--plan \| --verify \| --yes] [--keep-database [--replace-files]]` | Checks a backup against its `SHA256SUMS` and prints the steps that restore it. `--verify` also reads every archive through; `--yes` runs the steps. Neither of the first two changes anything. `--keep-database` keeps an external database that already holds the data, and `--replace-files` lets it replace files already on this machine. |
| `upgrade <version>` | For an installation that builds its images: takes the release's own `deploy/scripts/upgrade.ts` out of its tag with `git archive` (fetching the tag first if this clone lacks it) and runs that copy ([Upgrading between releases](UPGRADING.md)) with every overlay file and profile in the deploy file: the browser and tailnet files, the sandbox profile, an external database and an S3 blob store. |
| `history [--json]` | The deploys, rollbacks and upgrades recorded in `deploy/.melete/history.jsonl`. |
| `account <command>` | The accounts on the installation, run in the service container; [Accounts](#accounts) lists the commands. `--json` prints each answer as one JSON object. |
| `feedback [list\|show <id>]` | The [problem reports](FEEDBACK.md) people sent, as `bun run feedback` prints them, run in the service container. |
| `remote <ssh-target> <command>` | Runs any command above on another machine over SSH, in its checkout, as [On a cloud VM](#on-a-cloud-vm) describes. `remote <ssh-target> push` copies this deployment directory's settings there. |

`--deploy-dir <checkout>/deploy` runs a command against another checkout's
deployment directory. The exit code says what happened: 0 done or every check
passed, 1 a check failed, 2 refused with nothing changed, 3 acted but did not
finish, with the next step printed. `init`, `set`, `deploy`, `rollback`,
`backup` and `upgrade` hold a lock, `deploy/.melete/lock`, so two of them never
change the installation at once; a lock left by a process that has ended is
taken over.

On a host without Bun, such as one that only pulls the prebuilt images, the
service image carries `check`, `doctor` and `status`. Run them in the `melete`
container, from the directory that holds the checkout:

```bash
docker compose -f deploy/docker-compose.yml exec melete bun run melete doctor --offline
docker compose -f deploy/docker-compose.yml exec melete bun run melete status
```

There they judge what the container sees. The container holds no `deploy/.env`,
no Compose files and no Docker socket, so the rules that judge the host, such as
`docker.engine`, `disk.free_mb`, the ports, the images and the Compose files,
report `skip` with "Skipped: run on the host to check this." A skipped rule
never fails the command, so its exit code is 0 unless a rule it can judge fails;
run the command from a checkout with Bun for the host's rules. In the container
`doctor` and `check` report `browser.worker` from the settings and the
connections file the service runs with, and `status` asks the service itself for
its health and whether the owner account exists. With the worker on, add
`-f deploy/docker-compose.browser.yml` after the base file. On a host without
Bun, the installer turns the worker on:
`curl -fsSL https://raw.githubusercontent.com/ychampion/melete/main/install.sh | MELETE_BROWSER=1 bash`.

### The deploy file

`deploy/melete.deploy.json` records what an installation is beyond what
`deploy/.env` says. It holds no secret, so it can be kept in a repository; the
keys stay in `deploy/.env`. This repository's `.gitignore` leaves it out, with
`deploy/.env` and `deploy/.melete/`, so a checkout stays clean for
`deploy --checkout`. Every key has a default, so `{"contract": 1}` is a
complete file, and `init` writes each one out:

```json
{
  "contract": 1,
  "project": "melete",
  "images": { "registry": "ghcr.io/ychampion", "tag": "main", "channel": "main" },
  "profiles": [],
  "overlays": [],
  "compose_files": [],
  "disk": { "min_free_mb": 4096, "pull_margin_mb": 512 },
  "backup": { "dir": "~/melete-backups", "keep": 3, "max_age_days": 30 },
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
- `compose_files` lists Compose files of your own, as paths relative to
  `deploy/` with `/` between folders, such as `"../private/compose.extra.yml"`
  or `"docker-compose.brand.yml"`. Every Compose command reads them after all
  the files the other keys add, in the order listed, so they can add services
  beside the stack or change one of its settings. Each must exist: a missing one
  makes the file invalid, so `deploy` and `upgrade` refuse to run and `status`,
  `doctor` and `check` fail until it is there. Those three name the files on the
  contract line. Each path is written one way (no `./`, `//` or `folder/..`),
  and a file the other keys already choose, or one already listed, cannot be
  listed again, however the path reaches it. See
  [Building on Melete](../FORKING.md).
- `disk.min_free_mb` is the free space, in MB, below which `doctor` and
  `status` report the machine short of disk. A small host sets its own, below
  1 GB if it must. `pull_margin_mb` is the room an update keeps beyond the
  images it pulls.
- `backup.dir` is where backups are written: by default `~/melete-backups`
  for the project `melete` and `~/melete-backups/<project>` for any other, so
  installations on one machine never prune each other's. `backup.keep` is how
  many are kept there, and `backup.max_age_days` the most days any of them is kept
  (`null` keeps them by number alone); see
  [How long backups keep what was removed](#how-long-backups-keep-what-was-removed).
- `blobs.store` is `local`, or `s3` with a non-secret `bucket`, an `endpoint`
  (left out for AWS S3) and an optional `region`; the storage keys stay in
  `deploy/.env`. With `s3`, every Compose command adds
  `deploy/docker-compose.blobs-s3.yml`, and `check` fails when `deploy/.env`
  names another bucket or endpoint, or lacks the keys.
- `database.external: true` adds `deploy/docker-compose.external-db.yml` to
  every Compose command: the service uses the server `DATABASE_URL` names, and
  the bundled postgres stays off. `check` requires the URL to ask for TLS.
- `hosted: true` marks an installation that other people reach over the
  internet; see [Hosting for other people](#hosting-for-other-people). Left
  out, it is false.
- `cells.hosts` describes container hosts on other machines; `check` fails
  while the checkout has no `deploy/docker-compose.cells.yml` to run them with.
- `remote.path` is the checkout on the machine `bun run melete remote` reaches,
  absolute or under `~/`, and `remote.cli` the command that runs the melete
  command there, `["bun", "run", "melete"]` by default.
- A contract number the command does not know, or a key it does not know, is
  refused rather than guessed at.

## Hosting for other people

An installation that other people sign in to needs four things that a private
one can do without: a public `https://` address (`MELETE_PUBLIC_URL`) for
sign-in and reset links, invites, Google, Microsoft and MCP sign-ins and
texting; the web origin that matches it (`MELETE_WEB_ORIGIN`), or the web app
refuses sign-in there; an alert target (`MELETE_ALERT_WEBHOOK_URL`, or
`MELETE_ALERT_EMAIL_TO` with `MELETE_ALERT_SMTP_URL`, see [Alerts](#alerts));
and `MELETE_OPERATOR_TOKEN`, which opens `GET /health/detail`. Say in your
privacy terms how long backups keep what people remove; see
[How long backups keep what was removed](#how-long-backups-keep-what-was-removed).
The logs hold no one's messages, files or secrets
([What the logs hold](#what-the-logs-hold)); to keep them past rotation, set
`MELETE_LOG_SHIP_ENDPOINT` to your log collector and start the shipper in
[Shipping logs](#shipping-logs). It stays off unless you start it.

Mark such an installation with `"hosted": true` in `deploy/melete.deploy.json`.
`check` and `status` then fail, under `hosted.public_url`, `hosted.web_origin`,
`hosted.alerts` and `hosted.operator_token`, until each is set. Without the
mark the same rules only warn.

Because the installation's model key pays for everyone, a hosted installation
also needs its cost guards, and `check` and `status` fail until each is set to
a positive number:

| Rule | Settings | Starting value |
|---|---|---|
| `hosted.spend_person` | `MELETE_SPEND_PERSON_DAILY_USD`, `MELETE_SPEND_PERSON_MONTHLY_USD` | $2 a day, $20 a month |
| `hosted.spend_background` | `MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD`, `MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD` | $0.50 a day, $5 a month |
| `hosted.spend_installation` | `MELETE_SPEND_MONTHLY_USD` | $200 a month |
| `hosted.uploads` | `MELETE_ATTACHMENT_UPLOADS_AT_ONCE`, `MELETE_ATTACHMENT_UPLOADS_PER_WINDOW` | 3 at once, 30 in ten minutes |
| `hosted.storage` | `MELETE_STORAGE_PER_PERSON_MB` | 2048 MB per person |
| `hosted.computers` | `MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION` | 1 computer per person |
| `hosted.spend_alert` | `MELETE_ALERT_SPEND_HOURLY_MULTIPLE` or `MELETE_ALERT_SPEND_PERSON_PERCENT` | an alert at 4 times the usual hour |
| `hosted.network_pool` | `MELETE_NETWORK_POOL` | the default range; it fails only when set to `off` |

These are starting points: tune them to your price and your people (see
[Spending caps](#spending-caps), [Attachments](#attachments) and
[Alerts](#alerts)). The installation's `$200` is used up by ten people at
their own `$20`, after which model calls stop for everyone until the month
resets, so raise it as people join; the `spend_cap` alert fires at 80% of it.
`init --hosted` also writes
`MELETE_ATTEMPT_CONCURRENCY_PER_PERSON=2`, which is not required: free slots
are shared between people either way ([Engine limits](#engine-limits)). They apply only to a hosted installation; a self-hosted
one has no limits unless you set them, and `check` never asks for them.

With a computer limit of one, a person whose computer is busy with another
task, or anyone when every computer is in use, is told so in their
conversation in plain words, and can ask again once it is free. Size
`MELETE_SANDBOX_MAX_CONCURRENT` to the machine: each running computer may use
up to 2 GB.

A new installation gets all of it but the alert target in one step:

```bash
bun run melete init --connect-in-app --public-url https://assistant.example.net --hosted
read -rs MELETE_ALERT_WEBHOOK_URL && export MELETE_ALERT_WEBHOOK_URL   # its address works as its key
bun run melete set --from-env MELETE_ALERT_WEBHOOK_URL && unset MELETE_ALERT_WEBHOOK_URL
```

For an installation that is already running, set the two addresses together,
put `"hosted": true` in the deploy file, give it a token, and set the cost
guards (`check` names each one that is missing, with a starting value):

```bash
bun run melete set MELETE_PUBLIC_URL=https://assistant.example.net MELETE_WEB_ORIGIN=https://assistant.example.net
read -rs MELETE_OPERATOR_TOKEN && export MELETE_OPERATOR_TOKEN   # 24 or more random characters
bun run melete set --from-env MELETE_OPERATOR_TOKEN && unset MELETE_OPERATOR_TOKEN
bun run melete set MELETE_SPEND_PERSON_DAILY_USD=2 MELETE_SPEND_PERSON_MONTHLY_USD=20 \
  MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD=0.5 MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD=5 \
  MELETE_SPEND_MONTHLY_USD=200 MELETE_ATTACHMENT_UPLOADS_AT_ONCE=3 \
  MELETE_ATTACHMENT_UPLOADS_PER_WINDOW=30 MELETE_STORAGE_PER_PERSON_MB=2048 \
  MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION=1 MELETE_ALERT_SPEND_HOURLY_MULTIPLE=4
bun run melete check
```

A hosted installation also needs a daily backup that leaves the machine:
`check` and `status` fail once the newest backup is more than 26 hours old
([Backups on a schedule](#backups-on-a-schedule)).

People you invite should be able to read your terms and privacy notice and
reach you for help. Host those pages yourself and name them; each is linked on
the sign-in page, in setup and in Settings › Account only when it is set:

```bash
bun run melete set MELETE_TERMS_URL=https://example.net/terms \
  MELETE_PRIVACY_URL=https://example.net/privacy MELETE_SUPPORT_URL=mailto:help@example.net
```

Terms and privacy take an `https://` page; support takes an `https://` page or
a `mailto:` address.

A self-hosted installation limits nobody's storage. One that hosts other
people caps how much each person keeps (`hosted.storage` above), so one
account cannot fill the disk or the bucket for everyone:
`MELETE_STORAGE_PER_PERSON_MB=2048` is a reasonable start. See
[How much each person keeps](#how-much-each-person-keeps).

Each person's agent computer has a network of its own in `MELETE_NETWORK_POOL`.
Leave that setting at its default (`10.215.0.0/16`) or another range, not
`off`; a hosted installation fails `hosted.network_pool` while it is `off`.
Requests the agents make through Melete never enter the pool, whatever
`MELETE_PRIVATE_HOSTS` lists, so one person's agent can't reach another
person's computer. With the pool `off`, computers take the engine's own ranges
instead, and a range listed in `MELETE_PRIVATE_HOSTS` that covers them would
open them.

Two settings keep the background work of many people in proportion; both are
empty, and so off, unless set. `MELETE_REST_ROUTINES_AFTER_DAYS` is how many
days a person may go unseen (no sign-in, no use of the app, no message through
a channel) before their routines, watches and other repeating work rest. A
time that comes while they rest is let pass, not kept: the next time the
person is seen, everything comes back on from that moment, nothing missed runs
late, and Home tells them in one line that their routines rested and are back
on. `MELETE_ROUTINES_PER_PERSON_MAX` is how many routines and pieces of
repeating work one person may keep; one more is refused with a sentence the
assistant passes on. For an installation that other people sign in to, `14`
days and `20` routines are a good start:

```bash
bun run melete set MELETE_REST_ROUTINES_AFTER_DAYS=14 MELETE_ROUTINES_PER_PERSON_MAX=20
```

`MELETE_RUNS_ACTIVE_PER_SPACE_MAX` is how many pieces of long work (runs) one
space may have going at once; one more is refused until one finishes or is
stopped. It is empty, and so no limit, unless you set it.

### Running it from the web app

The installation's owner also has **Settings › Installation** in the web app,
which nobody else sees and the service answers to nobody else. It shows the
month's and the day's spending against the installation's caps, how many
people are active, invited or turned off, the agent runs and computers going
now against their limits, the newest backup, free disk, health and the
version.

Under it is everyone with an account: their status, when they were last
seen, and what they spent this month and today against their caps. From
there the owner can invite someone, send a new invite or a password reset,
turn an account off (which signs them out everywhere) or back on, delete an
account by typing its email, and give a person caps of their own. Those are
dollar caps for a day, a month and background work; each stays within the
installation's caps, and a blank one keeps the `MELETE_SPEND_PERSON_*` value.
Token caps stay installation-wide.

Every invite and reset link is shown to copy, whether or not account mail is
set up, so an installation without mail can still bring people in. Every
change made here, and by `melete account create`, `reset`, `disable` and
`enable` on the host, is listed under Changes with who made it and when;
links and codes are never kept there. The newest backup shown is the one
`melete backup` last noted in the database, so backups taken before this
release don't appear until the next one runs.
### How long call records are kept

Every model call writes a row to `model_usage`, and every message, meeting,
file change or process report a connected account sends writes one to `event`.
With many people both grow every day. `MELETE_RETENTION_DAYS` bounds them; it
is unset by default, and then nothing is removed. Use **90** on an
installation that hosts other people:

```bash
bun run melete set MELETE_RETENTION_DAYS=90
```

Once an hour, one instance removes, a small batch at a time and oldest first:

- model calls made before the start of the UTC day that many days back. Each
  day's calls are summed into the daily usage roll-up (`usage_day`) before
  they go, so the usage chart, background cost per day and spending by day
  keep their history. This month's spending, the spending alerts and the
  roll-up read the calls themselves, so the setting is at least 35.
- connector events that no job took in and nothing still holds. A conversation
  and everything its agent reads stay as long as the conversation does, and so
  do the audit log, receipts, approvals and files. An event a job or something
  Melete noticed cites, one a listening trigger has not read, one an open
  "needs you" item points at, and mail an open wait on a reply may still be
  checked against are kept. Each removed event leaves its delivery key, so the
  same message is not delivered twice.

Each batch is its own short transaction. It passes over model calls another
transaction holds, and gives up after five seconds of waiting for anything
else, to try again on the next pass; a large backlog goes over several passes. `MELETE_OBSERVATION_RETENTION_DAYS` (14 by default)
still removes unused mail, calendar and document observations sooner.

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
   Give Melete a separate, empty database of its own, not the provider's
   default one: a default database can already hold the provider's own tables
   (Supabase's `postgres` database does, and so does any database made from a
   `template1` where TimescaleDB or PostGIS is installed), and a restore or a
   rollback loads only into a database that holds no table, so it refuses that
   one. If the provider sets Postgres 17's `transaction_timeout` for the user or
   the database, raise it or set it to `0` for the user `DATABASE_URL` names
   before a restore or a rollback (`alter role <user> set transaction_timeout = 0`):
   the load runs as one transaction, so a timeout shorter than the load cuts it
   off, and the database is left empty again.
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
4. At each start, `database-roles` creates the service's three
   [database roles](#database-roles) on that server, as the user
   `DATABASE_URL` names. That user must be allowed to create roles; a
   provider's administrator user usually is. Where it is not, the database's
   administrator creates them once, and `deploy/.env` names them, as
   [Roles an administrator creates](#roles-an-administrator-creates) shows.
   `bun run melete check` says which of the two the installation uses.

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

With the database and the bucket at a provider, the VM holds the settings, the
restriction journal, the spaces' files, the shared `/work` and the agents'
computers, so a new one takes over from a backup:

1. On the old VM, or from your computer through `remote`: `bun run melete
   backup` (or `--to ssh://host:/path` when the VM is short of disk). Note the
   image tag `bun run melete history` shows.
2. On the new VM, clone the checkout at the same commit, and copy the backup
   directory there. Copy its `deploy.env` to `deploy/.env` (mode 0600) and its
   `melete.deploy.json` to `deploy/`, or push your local copies. The master key
   is not in the backup: `read -rs MELETE_MASTER_KEY && export
   MELETE_MASTER_KEY`, then `bun run melete set --from-env MELETE_MASTER_KEY`.
3. `bun run melete restore <backup> --verify` checks every part and changes
   nothing. `bun run melete restore <backup>` prints the steps; on a new machine
   they put the newest restriction journal back before the service starts.
4. `bun run melete restore <backup> --yes` runs them and starts the stack.
   With an external database that already holds the data, add
   `--keep-database`; to restore into a new database, point `DATABASE_URL` at
   an empty one first. Where the database's administrator made the roles
   ([Roles an administrator creates](#roles-an-administrator-creates)), they
   grant them the new database, and `MELETE_MIGRATE_DATABASE_URL`,
   `MELETE_API_DATABASE_URL` and `MELETE_EFFECTS_DATABASE_URL` are pointed at
   it too; the restore refuses while they name another one. Docker pulls the images the tag names when the steps
   first need them. `bun run melete status` then reports the stack.

If the stack was started on the new VM before the restore, its own start-up
files are in the file volumes (and in an agent computer's, if one was used
there), and `--keep-database` refuses to replace them until you add
`--replace-files`. The restriction journal that start left, which
holds no entry, is replaced by the backup's, as on a VM that never ran.

The agents' computers come back as their volumes, but a new machine has none of
their containers. A release whose service makes a computer's container again on
its kept volumes (see [docs/sandbox-docker.md](sandbox-docker.md)) brings each
computer back with its `/work` and home folder the next time the agent uses it.
An earlier release treats a computer without its container as gone: each agent
gets a new computer, with each chat's files in `/work` back from the shared
`/work` and an empty home folder, so browser sign-ins and tools installed there
are lost. `restore` says which computers have no container before it starts.

## Using prebuilt images

Every push to `main` builds the five Melete images in GitHub Actions and
publishes them to the GitHub Container Registry, so a host can pull finished
images rather than build them. This is the recommended way to run a server: it
needs no build cache, no compilers and far less free disk than a build.

| Image | Built from |
| --- | --- |
| `ghcr.io/ychampion/melete-service` | `deploy/Dockerfile.melete` |
| `ghcr.io/ychampion/melete-web` | `deploy/Dockerfile.web` |
| `ghcr.io/ychampion/melete-runtime` | `packages/runtime-hermes/Dockerfile` |
| `ghcr.io/ychampion/melete-sandbox` | `deploy/Dockerfile.sandbox` |
| `ghcr.io/ychampion/melete-browser` | `deploy/Dockerfile.browser`, the [browser worker](browser-worker.md) |

Each image carries these tags:

- `main`: the latest commit on `main` for which all five images built. The
  tag moves on all five together, only after every one of them is published.
- the commit's first seven characters, such as `023df46`: one build, kept.
- a release's version, such as `v0.3.0`, when that tag is pushed.

A tag belongs to the Docker engine, not to one installation: a pull of `main`
by any installation on the same engine, or by hand, moves it for all of them.
The `melete` service looks up the runtime image's ID once, when it starts, and
starts every attempt's engine from that exact image. `melete-cells` records
the image the service was given and keeps accepting it after the tag moves,
also when `melete-cells` restarts on its own, so a moved tag never stops a
running installation's engines. A newer runtime image is used from the next
start of the `melete` service, which `melete deploy` does once the matching
service image is in place: the service image expects the Hermes commit its
own release's runtime carries, so the two change together, never when the tag
happens to move. `melete deploy` also pins each installation to its commit's
own tag, which keeps installations on one engine from moving each other's.

If the image the service started with is removed from the engine, such as by
`docker image prune` after the tag moved away from it, a new message ends
with “I couldn’t start the engine that does the work … Restart Melete”, and the
service log names the image. Restart the `melete` service to use the image the
tag names now, or run `melete deploy` when that is a newer release than the
service's.

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
`deploy/.env` (`bun run melete set COMPOSE_PROFILES=sandbox` also turns on the
deploy file's `sandbox` profile); the computer image is then pulled with the
others.

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
4. When the new release adds migrations, it first takes a whole backup, the
   database and the files as `melete backup` takes them, into `backup.dir`
   (its disk plan counts both), or streams it with `--backup-to
   ssh://host:/path`.
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

Each space's **Computer** follows `MELETE_SANDBOX_DOCKER_IMAGE` when the
service starts, so its computers are made from the pulled sandbox image from
then on. Keep `melete-sandbox:local` when someone added a docker sandbox by
hand that names it: `melete deploy` (with the `sandbox` profile) and
`update.sh` point that name at the pulled sandbox image on every update so
those computers stay current.

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

The Compose files are unchanged. The `melete-cells` service mounts
`/var/run/docker.sock`, and Compose passes that path to the engine as written
([compose-go](https://github.com/compose-spec/compose-go/blob/main/paths/unix.go)
keeps an absolute Unix path for a Windows client talking to a Linux engine).
Docker Desktop resolves it inside its VM, where the socket is
`srwxrw---- root root`: a process may use it when its user or one of its groups
is root ([Docker Desktop's socket permissions](https://github.com/docker/for-win/issues/13898#issuecomment-1934625891)).
The Windows host has no such file, so `configure.ts` starts one container from
the stack's pinned Postgres image, with no network, reads the socket's group and
mode as a container sees them, and writes that group as `DOCKER_GID`: `0` on
current Docker Desktop releases. `melete-cells` is added to that group and
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
default backup parent, `C:\Users\<you>\melete-backups` (a second
installation's is `melete-backups\<project>` inside it), in Git Bash as on Linux;
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

### Rooms

Rooms, shared spaces, guests and hand-offs are a preview behind
`MELETE_PREVIEW_MULTIPLAYER`, off by default. To turn them on, set it in
`deploy/.env` and recreate the service:

```dotenv
MELETE_PREVIEW_MULTIPLAYER=true
```

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate melete
```

Turning it off again keeps every room and message; their routes answer 404
until it is back on. [Rooms](ROOMS.md#turning-rooms-on) lists what it covers.

### Turn features on or off

Operators can turn whole features on or off, for example on an installation
for a family or a school that has no use for phone texts or the company list.
Each feature has one setting in `deploy/.env`, `on` or `off`; left empty, it
keeps its default, so an installation that sets nothing works as before.

| Setting | Default | What it covers |
| --- | --- | --- |
| `MELETE_FEATURE_MULTIPLAYER` | `MELETE_PREVIEW_MULTIPLAYER` (off) | Rooms, shared spaces, guests, hand-offs and linked chat platform accounts |
| `MELETE_FEATURE_VOICE` | on | Push-to-talk, voice mode, calls and replies read aloud |
| `MELETE_FEATURE_PHONE` | on | Texts and calls to a person's own verified number |
| `MELETE_FEATURE_SMS` | on | Texting the agent through a connected phone number |
| `MELETE_FEATURE_BROWSER` | on | The agent's own browser and the sites it is signed in to |
| `MELETE_FEATURE_COMPUTER` | on | The agent's own computer: its desktop, terminal and programs, and watching it and taking it over |
| `MELETE_FEATURE_COMPANIES` | on | Companies: money and paperwork found in mail, and the replies a person waits on |

```dotenv
MELETE_FEATURE_PHONE=off
MELETE_FEATURE_COMPANIES=off
```

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate melete
```

A feature that is off is refused by the service, not only hidden. Its routes
answer 404 `not_available` with a sentence such as "Voice is turned off on this
server.", including a provider's webhook (a text Twilio delivers is refused and
not kept), and the parts behind it are not started (the agent has no browser
with `MELETE_FEATURE_BROWSER=off`, no texts are sent with
`MELETE_FEATURE_PHONE=off`). The agent is not given its tools either: with
`MELETE_FEATURE_SMS=off` it cannot send a text, and with
`MELETE_FEATURE_COMPUTER=off` it has no computer, though sandboxes it already
had are still stopped when idle. Texting and sandbox connections are not offered
in Settings, and the company tools are not listed to other assistants over MCP
with `MELETE_FEATURE_COMPANIES=off`. The app leaves its screens and buttons out.
`GET /setup` lists every feature
under `features` with whether it is on for whoever asks. Nothing stored is
removed: turning a feature on again brings back what was there.

`MELETE_FEATURE_MULTIPLAYER` wins over `MELETE_PREVIEW_MULTIPLAYER` when both
are set, so either name works.

A feature can also be turned off for one person alone, by code that supplies
each person's values to the service (`personFeatures` in
`apps/melete/src/features.ts`). A person's value can only turn a feature off:
where the installation has it off, it stays off for everyone. Multiplayer is
switched for the whole installation only. A person's value refuses the
feature's routes for them; the agent's tools and background work follow the
installation's setting.

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

## Claiming a new installation

Until its first account exists, an installation belongs to whoever creates
that account. `bun run melete init` (and `deploy/scripts/configure.ts`, which it
runs) therefore makes a one-time setup code, prints it once with a link that
fills it in, and writes only its SHA-256 digest to `deploy/.env` as
`MELETE_SETUP_CODE_HASH`:

```text
Create the first account with this one-time setup code. It is shown only now; keep it until the account exists:

  K7QM-2XRT-9WPC-HV4N-ZD6B

Once Melete is running, open http://127.0.0.1:3101/#/welcome?code=K7QM-2XRT-9WPC-HV4N-ZD6B
```

While the code is configured, the sign-in page asks for it beside the email and
password (the link fills it in), and `POST /setup` answers 403
`setup_code_required` without it and 403 `invalid_setup_code` for a wrong one.
Case, spaces and dashes don't matter. The password is checked first, so a weak
one does not use up a code. The code works once, and lasts 72 hours from the
first time Melete starts with it; after that, or once `account setup-code` has
issued a newer one, it is refused as `invalid_setup_code`. Once the account
exists the code has nothing left to open. `GET /setup` says `code_required`
while it matters.

Lost it, or setting up installations for other people without `init`?

```bash
bun run melete account setup-code
```

prints a new code and link that last 72 hours; each new one cancels the one
before, the code `init` printed included. An operator who provisions an installation for someone else can also
skip the code and create that person's account directly with
`bun run melete account create <email>` (see [Accounts](#accounts)).

### With no code: decided by the address

An installation can have no code configured and none issued: one set up
before codes existed, or one whose `deploy/.env` leaves `MELETE_SETUP_CODE_HASH`
empty or out. An empty value counts as no code. What happens then depends on
the addresses in `deploy/.env`:

- **Every address is on this machine** (`MELETE_PUBLIC_URL` and
  `MELETE_WEB_ORIGIN` unset, or naming `localhost`, a name under it such as
  `melete.localhost`, `127.x.x.x` or `::1`). The first visitor creates the
  account, as before. That is the default loopback setup, where only this
  machine reaches the page.
- **Either names another machine** (a domain, a Tailscale name, a LAN or
  public address). The installation refuses to create the first account:
  `POST /setup` answers 403 `setup_code_required`, `GET /setup` says
  `code_required: true`, and the sign-in page asks for a code. Run
  `bun run melete account setup-code` on the host for one, then open the link
  it prints. The service says so in its log at start, and `melete check` and
  `melete status` say so too.

Only these two settings are read; a reverse proxy or a published port in
front of the installation is not seen. An installation reached that way must
set `MELETE_WEB_ORIGIN` (or `MELETE_PUBLIC_URL`) to the address people use, or
have a setup code, before it is reachable. With neither, its first visitor can
claim it.

Set `MELETE_SETUP_OPEN=true` only if the first visitor should be allowed to
create the owner without a code: it turns that refusal off, and whoever opens
the page first becomes the owner. You'd rarely want this. On an address other
people can reach, a scanner or a stranger can get there before you do, and
they then own the installation and everything you connect to it. It is only
for a page that is reachable but private in practice, such as one behind
your own sign-in proxy, and only until your account exists. While it is on,
the service logs a warning at start, and `melete check` and `melete status`
warn that the claim is open. Set it back to `false` once the account exists.
It never skips a code that exists: with a configured or issued code, the code
is still required.

## Accounts

The person who runs an installation manages its accounts from the checkout, or
from another machine with `bun run melete remote <host> account …`. Each
command runs in the service container and prints a link where one is needed;
links use `MELETE_PUBLIC_URL`, or the web port on this machine.

| Command | What it does |
|---|---|
| `account list` | Every account: email, owner, person or guest, created, disabled, whether it has a password yet, how many browsers are signed in, and the last sign-in. |
| `account create <email>` | A new account with a one-time link, valid for seven days. The link opens as an invite: the person chooses their password and goes straight on to setting up, already signed in. On an installation with no account yet this is the owner, and setup codes stop working. Its own space is made when it first signs in. |
| `account reset <email>` | A one-time link (60 minutes) that sets a new password. Using it signs the account out everywhere. |
| `account disable <email>` | The account can no longer sign in, and its browsers, paired computers, connected assistants, notifications and linked chat accounts are signed out. Its data and routines are kept, but its work does not run, nor use its saved sign-ins, until it is enabled again. |
| `account enable <email>` | Lets a disabled account sign in again. |
| `account link <email>` | For seven days, lets a sign-in through your [identity provider](#sign-in-with-your-identity-provider) with this verified email claim the account even though it has a password (`MELETE_OIDC_EMAIL_LINK=no-password`). Used up by that link. |
| `account setup-code` | A new [setup code](#claiming-a-new-installation), while no account exists. |

The exit code is 0 when it was done, 2 when it was refused (no such account,
an email already in use, a setup code once the owner exists) and 1 when it
failed.

In the app, the account that set Melete up can make another person's account
an admin, or take that away, from Settings › Account › Accounts on this Melete
(`PATCH /principals/{id}` with `admin: true` or `false`). An admin adds
accounts (`POST /principals`), sees the list of them, and chooses the
installation's model and its keys, as the setup owner does. Only the setup
owner makes admins, deletes other people's accounts and sets the secondary
model, and nobody can change the setup owner, who is always an admin. Only a
person's account that can sign in holds admin; a disabled one administers
nothing.

## Sign-in with your identity provider

People can sign in with your own identity provider: any OpenID Connect issuer,
such as Google, Microsoft Entra ID, Okta, Authentik or Keycloak. The sign-in
page then shows a "Continue with …" button, and you can make it the only way in.

1. At the provider, register a web application (a confidential client) whose
   redirect URI is `<MELETE_PUBLIC_URL>/api/signin/oidc/callback`, for example
   `https://melete.example.com/api/signin/oidc/callback`.
2. Put its details in `deploy/.env` and restart the service:

| Setting | What it is |
|---|---|
| `MELETE_OIDC_ISSUER` | The issuer URL, exactly as the provider's `/.well-known/openid-configuration` names it, such as `https://accounts.google.com`. HTTPS, or plain HTTP on this machine only. |
| `MELETE_OIDC_CLIENT_ID`, `MELETE_OIDC_CLIENT_SECRET` | The client the provider issued. All three settings are needed, or none, and so is `MELETE_PUBLIC_URL`. |
| `MELETE_OIDC_LABEL` | What the button says after "Continue with", such as `Google`. Default `single sign-on`. |
| `MELETE_OIDC_SCOPES` | The scopes asked for. Default `openid email profile`; `openid` is always included. |
| `MELETE_OIDC_ACCOUNTS` | `existing` (the default) signs in only accounts that already exist here. `create` also makes a person account the first time someone signs in. |
| `MELETE_OIDC_EMAIL_LINK` | Which existing accounts a verified email may claim at a first sign-in. `any` (the default): every person account with that email. `no-password`: only accounts without a password, such as those made with `account create`, plus an account with a password you open with `account link <email>`. |
| `MELETE_OIDC_REQUIRE_CLAIM` | `name=value`: a claim the ID token must carry, such as `melete_access=true`, or `groups=melete` for a list of groups. A dotted name such as `realm_access.roles=melete` reaches into a nested claim. When it is set, an ID token without that claim is refused. |
| `MELETE_PASSWORD_SIGNIN` | `off` makes the provider the only way in: passwords, emailed sign-in links and password resets are refused, and `account reset` prints no link. Default `on`. |

How someone is matched to an account. The first time they sign in, Melete
looks for the provider account they used, then for a person account with the
email the provider gives. That email has to be verified at the provider
(`email_verified`); otherwise the sign-in is refused. The provider account is
then linked to that Melete account, and later sign-ins follow the link even if
the email changes at the provider. Another provider account with the same email
does not take over an account that is already linked. Guest accounts from room
invites keep signing in the way they were invited. The email has to be a plain
ASCII address, as for every other way in.

Which provider to trust with email matching. With a provider you run yourself
(Okta, Authentik, Keycloak, a company's Entra tenant), a verified email is as
good as the account it names. With a public provider such as Google, it says
only that someone once proved the address: a personal account made with a
work email stays verified after its owner leaves, and so does one made on a
domain that later lapsed and was bought by someone else. With a public
provider, set `MELETE_OIDC_EMAIL_LINK=no-password`, so an account that has a
password is claimed only after you run `account link <email>` for it.

What is checked. The browser leaves with PKCE, a state and a nonce, kept in a
sealed cookie for ten minutes. On the way back, the state has to match that
cookie and can be used only once. The ID token has to be signed with one of the
provider's published keys, using an asymmetric algorithm, and has to name the
provider as issuer and this client as audience. It also has to be unexpired and
carry the nonce. The cookie is sealed with a key derived from
`MELETE_MASTER_KEY`. Without a master key, a sign-in has to come back to the
same service process that started it.

The first account. Sign-in through the provider needs an installation that
already has its first account. Make it in the usual way
([Claiming a new installation](#claiming-a-new-installation)), or with
`bun run melete account create <email>` on the host. Use the email you have at
the provider, then sign in with the button. With `MELETE_PASSWORD_SIGNIN=off`,
that first account still has to be created this way. Under
`MELETE_OIDC_EMAIL_LINK=no-password`, an owner made on the setup page has a
password, so run `account link <email>` for it first; one made with
`account create` has none and needs nothing more.

Getting back in. If the provider is down, its client is deleted, or your email
there no longer matches, nobody can sign in through it. Nothing is lost: set
`MELETE_PASSWORD_SIGNIN=on` (or remove the line) in `deploy/.env`, restart the
service, and run `bun run melete account reset <email>` on the host for a
one-time link that sets your password. Turn password sign-in off again once the
provider works.

Turning someone off. `account disable <email>` works the same for people who
sign in through the provider: the next sign-in is refused, and their browsers
are already signed out. To keep someone out at the provider instead, remove the
claim that `MELETE_OIDC_REQUIRE_CLAIM` names. Deleting an account removes its
link to the provider, so in `create` mode the same person signing in again
starts a new, empty account.

Back-channel logout. If the provider supports OpenID Connect Back-Channel Logout,
set its back-channel logout URI to `<MELETE_PUBLIC_URL>/api/signin/oidc/logout`.
When the person signs out at the provider, every browser signed in to their
Melete account here is signed out too. Each logout token works once. Logout by
session id (`sid`) alone is not supported; the logout token has to name the
subject.

Notes for some providers:

- Google: the issuer is `https://accounts.google.com`. Create an "OAuth client
  ID" of type "Web application" in the Google Cloud console.
- Microsoft Entra ID: use the tenant's own issuer,
  `https://login.microsoftonline.com/<tenant-id>/v2.0`. The shared `common`
  endpoint names no single issuer and isn't supported. Entra ID leaves
  `email_verified` out of its ID tokens by default, so see the last point.
- Okta, Authentik and Keycloak: use the issuer of the authorization server or
  realm the client belongs to.
- Every provider: the ID token has to carry `email` and `email_verified: true`.
  A provider that leaves `email_verified` out of its ID tokens can't sign
  anyone in yet.

## Signing out everywhere

Settings › Account › Where you're signed in lists every browser signed in to the
account, with the system and browser each signed in from, and the paired
computers, browsers that receive notifications, and connected assistants. Any
browser or computer can be signed out on its own. "Sign out everywhere else"
ends all of them except the browser that asked: other browser sessions, unused
sign-in and reset links, connected assistants and their unused codes, unused
computer pairing codes, paired computers (their connections are revoked as a
revoke in Settings › Devices revokes them), notification subscriptions, and
linked chat accounts. Changing the password does the same. A reset link
does it for every browser, the one that used the link included. Signing out of
one browser also stops that browser's notifications.

Expired sessions, and links and codes that expired or were used more than a
day ago, are deleted every six hours.

New passwords need at least 10 characters, and the most common passwords, one
character repeated, a straight run of keys and the account's own email address
are refused (400 `weak_password`). Existing passwords keep working.

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

A reverse proxy on the host can state each browser's address instead. Set
`MELETE_WEB_TRUSTED_UPSTREAM=gateway` and have the proxy set `X-Forwarded-For`
to the one address it accepted the connection from, replacing any value the
browser sent (Caddy's `reverse_proxy` and nginx's
`proxy_set_header X-Forwarded-For $remote_addr` do). The web server reads the
container's default gateway from its routing table and believes the header
only on a connection from that address, and only when it holds one
well-formed address; anything else is attributed to the socket as before. A
proxy on another machine is named by its address instead of `gateway`.
With `gateway`, keep the web port published on `127.0.0.1` only, as
`deploy/docker-compose.yml` does (`127.0.0.1:${WEB_PORT}`), and never on every
address in an override: every program on the host and every SSH tunnel to it
arrives from the gateway and is believed, and with the port published on every
address, Docker's userland proxy can make clients from outside arrive from the
gateway too, so they could name any address they like.

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
page. With [account mail](#account-mail) set up, the page mails any account a
reset link (30 minutes, at most three an hour). Without it, only the owner can
get one, and only when their own mailbox is connected. The page also takes a
reset code, or a whole link, pasted in, and checks it before asking for a new
password. Otherwise the person who runs the install prints a link:

```bash
bun run melete account reset you@example.com
# Without the melete command:
docker compose -f deploy/docker-compose.yml exec melete bun run reset-password you@example.com
# Outside Docker, from the checkout, with DATABASE_URL set:
bun run reset-password you@example.com
```

The page never shows these commands: the person who forgot their password is
told only what they can do.

The link uses `MELETE_PUBLIC_URL`; without it the command prints a code to paste
on the reset page instead. A link or code works once, expires after 60 minutes,
and printing a new one cancels the old printed one; asking for a mailed link
leaves a printed one working. Choosing a new password signs the account out
everywhere, connected apps included. Only a digest of each token is stored, and
attempts to use one are limited per client address.

### Account mail

Sign-in links and password reset links go out through the installation's own
mail sender when one is configured:

```bash
# The URL holds the mail server's password, so it is read, not typed on the command line:
# smtps://user:password@smtp.example.com:465
read -rs MELETE_SMTP_URL && export MELETE_SMTP_URL
bun run melete set --from-env MELETE_SMTP_URL
unset MELETE_SMTP_URL
bun run melete set MELETE_MAIL_FROM='Melete <melete@example.com>' MELETE_PUBLIC_URL=https://melete.example.com
```

Both are needed, or neither; the service refuses to start with one alone. The
links point at `MELETE_PUBLIC_URL`, so email sign-in and mailed resets are
offered only once it is set. Every link signs in to an account, so `smtp://`
must upgrade to TLS with STARTTLS before anything is sent, unless the server
is on this machine; add `?requireTLS=false` to the URL only for a relay on a
network you trust that cannot. Leave `?opportunisticTLS=true` and
`?ignoreTLS=true` out of the URL: the first sends in plain text whenever the
server refuses the upgrade, and the second never asks for it, so either one
turns the requirement off as `?requireTLS=false` does, without saying so.
This sender carries nothing but these two kinds of mail, for any account;
what Melete sends for a person still leaves from their own connected
accounts, after their approval. The answer to a request is the same whether or
not the address has an account, and the mail is sent after the answer.

Without a sender, account mail goes out from the owner's own connected mailbox,
to the owner only, as before. The sign-in page shows "Email me a link instead"
only when one of the two can send (`email_sign_in` in `GET /setup`).

### Room invites

Room invite links work like reset links. A guest's invite link uses `MELETE_PUBLIC_URL`
when it is set; without it, the owner is given a path to open on the address
people use for this installation. Only a digest of each invite's token is
stored, and the token rides in the link's fragment, which no server log sees.
A guest whose invite has run out is taken out of the room within a minute.

## Names and look

An installation can have its own name, an assistant with its own name, and its
own icons, logo and colours: useful when you run it for your family, a school
or a team.

```bash
bun run melete set MELETE_INSTANCE_NAME='Riverside Assistant' MELETE_ASSISTANT_NAME=Juniper
```

- `MELETE_INSTANCE_NAME` is what the installation calls itself: the page title,
  the home-screen title, and the subject and text of sign-in and password reset
  mail, which also ends with `MELETE_PUBLIC_URL` when it is set.
- `MELETE_ASSISTANT_NAME` is what the assistant calls itself. The built-in
  identity begins "You are Melete"; the name takes Melete's place there. Left
  unset, the assistant takes `MELETE_INSTANCE_NAME`, so an installation named
  once reads as one name throughout.
- `MELETE_IDENTITY_FILE` replaces the built-in identity with a file of your own,
  a path the service can read. It is used as written, so it names the assistant
  itself, and it is held to the same cap as the built-in one, about 250 tokens,
  because it is sent with every message. The service will not start with a file
  over the cap.

Both names default to Melete, are one line of at most 60 characters, and are in
`GET /setup` as `instance_name` and `assistant_name`, so a sign-in page can
show them before anyone signs in. The service and the web client read them at
start, so after `melete set`, recreate the services it names. Other words in
the app still say Melete for now.

### A brand folder

`deploy/docker-compose.brand.yml` mounts a folder read-only into the web client
and the service, `deploy/brand` unless `MELETE_BRAND_SOURCE` names another. Add
it to the [deploy file](#the-deploy-file):

```json
{ "contract": 1, "compose_files": ["docker-compose.brand.yml"] }
```

The web client serves these files from the folder ahead of its own, and nothing
else in it:

| File | Replaces |
|---|---|
| `favicon.ico`, `favicon.svg`, `favicon.png` | The tab icon |
| `icons/<name>.png`, `.svg`, `.ico`, `.webp` | The home-screen icons, such as `icons/apple-touch-icon.png` |
| `logo.png` | The mark the app draws (`/melete-logo.png`); `logo.svg` and `logo.webp` are served at their own names |
| `manifest.webmanifest` | The installed app's name, colours and icons |
| `brand.css` | Colours, corners and fonts; see below |

A path that climbs out of the folder, or a symbolic link that points outside it,
is not served. Each file may be up to 2 MiB and `brand.css` up to 64 KiB; a
larger one is not served (the app's own file is, where it has one), and the web
client logs why. An SVG
is served so that, opened on its own, it runs no script and loads nothing. The
service sees the same folder at `/brand`, so an identity file
kept there is `MELETE_IDENTITY_FILE=/brand/identity.md`; the web client never
serves it.

`brand.css` is linked after the app's own styles and may set only the design
tokens the web client declares in
[`apps/web/src/design/tokens.css`](../apps/web/src/design/tokens.css), in the
same rule sets that file uses:

```css
:root { --primary: #0b6e4f; --primary-hover: #095c42; --radius-card: 8px; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --primary: #6fd3a8; }
}
:root[data-theme="dark"] { --primary: #6fd3a8; }
```

The dark rule sets matter: without them, dark appearance keeps the app's own
colours. Any other property, selector or at-rule, `url()`, or a backslash
escape, and the web client neither serves nor links the file and logs why. With
`url()` refused, a font must be one the browser has or one the app ships (DM
Sans, Newsreader). The tokens are:

- surfaces: `--canvas`, `--surface`, `--soft`, `--overlay`, `--chip-bg`, `--hover`, `--row-hover`;
- text: `--text`, `--heading`, `--muted`, `--secondary`, `--placeholder`;
- lines: `--line`, `--line-strong`, `--control`, `--ring`;
- accent: `--primary`, `--primary-hover`, `--primary-fg`, `--blue-soft`, `--blue-ink`, `--blue-line`, `--bubble`, `--bubble-ink`;
- tints: `--travel`, `--travel-ink`, `--sage`, `--sage-ink`, `--sand`, `--sand-ink`, `--lilac`, `--lilac-ink`, `--rose`, `--rose-ink`;
- states: `--success`, `--success-soft`, `--danger`, `--danger-soft`, `--rating`;
- dark panels: `--studio`, `--studio-panel`, `--studio-panel-2`, `--studio-line`, `--studio-text`, `--studio-muted`;
- shape and depth: `--radius-sheet`, `--radius-card`, `--radius-block`, `--radius-button`, `--shadow-sheet`, `--shadow-lift`, `--shadow-pill`, `--elevated`, `--skeleton-a`, `--skeleton-b`;
- fonts: `--font-body`, `--font-voice`, `--font-head`.

These names are the contract: a release that renames one says so in
[UPGRADING.md](UPGRADING.md). Check your colours against the surfaces they sit
on in both appearances; the app's own are set to read at 4.5:1.

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
Only the installation's owner sets one in the app; everyone else's private
conversations use the one in the environment.
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
`https://models.example.net/v1`. It and `ANTHROPIC_BASE_URL` are the only
provider addresses that may be plain `http://`, for a model server or gateway on
your own machine or network; every built-in provider stays HTTPS. Over
`http://` the key and every prompt travel unencrypted, so keep it to a network
you trust. Inside Compose, `localhost` is
the Melete container itself, so give an address that container can reach. The
gateway refuses a provider whose key is empty: for a server that checks no key,
set `OPENAI_COMPAT_API_KEY` to any non-empty value. Left empty, an `https://`
endpoint falls back to `OPENAI_API_KEY`; a plain `http://` endpoint never
receives `OPENAI_API_KEY`.

`ANTHROPIC_BASE_URL` sends the `anthropic` provider's calls through a gateway or
proxy you run, for example one that logs usage or enforces a spend limit. It
covers every call the service makes to Anthropic, agent turns and background
work such as memory and search alike, and the connection test and model list in
Settings › Models. Write it as the Anthropic SDKs read it, the address without
`/v1`, for example `https://gateway.example.net`; Melete calls
`<address>/v1/messages` with `ANTHROPIC_API_KEY`. An address that already ends
in `/v1` stops start-up. Left empty, Melete calls `https://api.anthropic.com`
directly. Over `http://` the key and every prompt travel unencrypted, so keep it
to a network you trust; start-up warns when a plain `http://` address is not on
the machine itself.

Which key goes to the gateway: `ANTHROPIC_API_KEY` when it is set. Without it,
the owner can save a key in Settings › Models, and that key is bound to the
address Anthropic was called at when it was saved. A key saved while Melete
called Anthropic directly is never sent to a gateway set later, and a key saved
for a gateway never goes to another address. Settings › Models then says the
saved key is for another address, shows the address in use, and asks for a key
for it; until one is saved or `ANTHROPIC_API_KEY` is set, Anthropic calls are
refused for want of a key.

A gateway address is never treated as a model on your own machine, even when it
is on your network: Anthropic still answers there. Its calls are priced at
Anthropic's rates and count against the spending limits, take the prompt caching
and fallback models an Anthropic call takes, and follow the privacy rules for a
cloud model. Settings › Privacy does not offer to mark it as your own model.

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

`TAVILY_API_KEY` and `BRAVE_SEARCH_API_KEY` are optional. Without either, every
agent still searches the web: with its model's own search where it has one, and
otherwise with a search that needs no key (DuckDuckGo's results page, then
Wikipedia). When a key is set, searches use that API first, Tavily before Brave.
Tavily's results carry the passages of each page that match the query, and with
its key `web.fetch` also reads, through Tavily Extract, a public page that gave
a direct read no text, at most three pages a turn. Tavily's free plan includes
1,000 credits a month; a search costs one and an extracted page at most two.
Both are charged to the job that made them at $0.008 a credit and count toward
the spending limits. The order, the
privacy rules and what each search records are in
[CONNECTORS](CONNECTORS.md#web-search).

The keyless search is not an official API: it reads DuckDuckGo's results page,
which is meant for people, from your server's address, and DuckDuckGo's terms
may not allow automated use. Melete paces it (one request at a time, two
seconds apart, a repeated query reused for ten minutes, nothing sent for
fifteen minutes after DuckDuckGo answers with a robot check), and the service
log says at start when no key is set. DuckDuckGo can still block the address,
and Wikipedia then answers with encyclopedia articles only. For a hosted or
shared installation, set `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY`.

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
provider does not answer in time. Only the setup owner, or an account they made
an admin, can change a key or the model; every other account sees which model
is active. The secondary model stays the setup owner's own.

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
keeps structured observations only. `MELETE_MEMORY_DAILY_CALLS`
is how many reads one person's memory may make in a day. It is empty by default,
which means no daily limit; set a number to bound your provider's cost. A call the provider answers with an error does not count;
a call that was sent and timed out does. When the budget is spent, or the
provider fails, limits or times out, the conversation carries on and the message
waits unread: it is tried again 30 seconds later, then after a gap that doubles
each time, up to 30 minutes, for at most 8 tries or a day. A call that asking
again cannot fix (too large for the model, or a request the provider refuses,
such as a model name it does not serve) ends the message at once. The service
log records each of these as `memory: <reason>`, and `/health` reports
`memory.waiting` and `memory.failed` (messages given up in the last day).

### Semantic recall

Memory, and the notes the agent keeps for itself, are also recalled by meaning,
so "favourite colour" finds what was said about a color. Melete embeds them with
the default provider's embedding model when it has one (Fireworks
`nomic-ai/nomic-embed-text-v1.5`, OpenAI `text-embedding-3-small`, Google
`gemini-embedding-001`), or with the first of those providers that has a key.
With none, recall stays lexical and nothing fails. `MELETE_EMBEDDING_PROVIDER`
and `MELETE_EMBEDDING_MODEL` name another model, with
`MELETE_EMBEDDING_DIMENSIONS` for a model Melete has no default for (an
`openai-compatible` endpoint, for one); `MELETE_EMBEDDING_MODEL=off` turns it off.
`MELETE_EMBEDDING_PROVIDER=local` embeds on the server at
`MELETE_LOCAL_MODEL_URL`, which must be on this machine or network, and then
needs the model and its dimensions named.

Embeddings follow the privacy settings. A cloud embedder never reads what memory
learned in a private conversation, nor anything in a space marked private, nor a
request from a private or sensitive conversation; that memory is recalled by its
words alone. Everything sent goes through the same redaction as a cloud model
request, what memory learned privately included. A provider that fails three
times in a row is left alone for a minute, and `/health` shows it under
`memory.embedding`. A local embedder reads memory as written. Memory is
embedded as it is written; memory kept before an embedding model was configured
is embedded the next time the service starts. Each call is counted in the
spending caps, charged to the person whose memory it read. Vectors are kept in
Postgres as JSON and compared in the service, so no database extension is needed.

### Voice

`ELEVENLABS_API_KEY` turns on speech, transcription, push-to-talk in chat and
voice mode; speech then uses ElevenLabs in preference to `OPENAI_API_KEY`.
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_SECOND_VOICE_ID`, `ELEVENLABS_SPEECH_MODEL`,
`ELEVENLABS_STREAMING_MODEL` and `ELEVENLABS_TRANSCRIPTION_MODEL` choose voices
and models. `MELETE_VOICE_DAILY_SECONDS`, `MELETE_VOICE_DAILY_CHARACTERS` and
`MELETE_VOICE_DAILY_SESSIONS` cap what one person may use in a day, and
`MELETE_CALL_MONTHLY_MINUTES` caps call minutes over 30 days; each is unset
(no cap) unless you set it. [VOICE](VOICE.md) describes each setting and
feature.

`MELETE_VOICE_DAILY_ASIDES` is how many asides (the short words with the agent
while it works in voice mode) one person may have in a day. It is empty, and so
no limit, unless you set it; asides are counted either way, so a limit set later
holds from the first day.

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

A message Melete sends waits `MELETE_SEND_HOLD_SECONDS` (default `20`, from `0`
to `120`) after it is cleared to go. Its receipt shows Undo for that time, and
cancelling sends nothing. The wait is kept in the database, so a restart during
it still sends the message once.

Work nobody is waiting on (a schedule, a timer or an event woke it) is never
asked about by default when it would reach someone outside Melete. It goes ahead
on its own when what the person said before makes it likely they want it, and is
otherwise left as a quiet suggestion in the conversation. The confidence is a
fixed sum, never the model's opinion: the person's routine or the agent's
instructions asking for it +0.6, something they told Melete about that recipient
+0.3, each similar action to that recipient they asked for or allowed in the last
90 days +0.15 (two at most), each one they said no to or took back -0.5, and 0
when Melete cannot vouch for where the recipient came from.
`MELETE_PROACTIVE_CONFIDENCE` (default `0.6`) is where it goes ahead. An email
also needs the routine or the instructions to ask for it.

Each kind of send (email, chat-app messages, calendar invites, public posts,
anything else outside) has a level the person picks once, on a card in the
conversation or in Settings: `draft`, `when_confident` or `always`. Chat-app
messages start at `MELETE_MESSAGES_TO_OTHERS` (`when_confident` by default,
also written `confidence`; `draft`; `draft_only`, which also keeps them out of
proactive work until the person picks a level; `always`), the rest at
`draft`. A level the person chose wins over the setting. Money moves, the
person's own don't-rules, and sends that also delete or carry a password still
go to the person at every level.

## Sandboxes

Sandboxes: connect E2B, Modal, Daytona or Maritime in Settings → Connections → Sandbox.
The provider's key is entered there and sealed with `MELETE_MASTER_KEY`. Or give
every agent a computer of its own on this host's Docker engine, with no account
and no key: see [sandbox-docker.md](sandbox-docker.md).
`configure.ts` writes `MELETE_SANDBOX_PROJECT`, the label that marks this
installation's sandboxes at the provider; keep it. The other `MELETE_SANDBOX_*`
settings and `MELETE_E2B_PLAN` are optional, with their defaults listed in
`deploy/.env.example`. Set them in `deploy/.env` and recreate the service.

### Computers on Maritime

[Maritime](https://maritime.sh/docs/computers) runs each agent's computer as a
persistent Linux desktop in a micro-VM of its own. It is an option for an
operator who would rather not run computers on their own Docker host.

**Setting it up.** Make a Maritime API key whose only scope is `computers`.
In Settings → Connections → Sandbox, choose *Maritime computers*, paste the key
as the provider key, and set:

- *Image*: `linux` (x86_64) or `linux-arm64`. Maritime runs its own desktop
  image; a custom image is refused.
- *What the sandbox may reach*: *Anything*. Maritime documents no egress
  control for computers, so *Nothing at all* and allow-lists are refused when
  the connection is saved, before any computer is made.
- *What a sandbox keeps*: *Files kept between attempts* to keep one computer per
  agent across attempts, or *Nothing* for a fresh computer each time.
- *Region*: leave it empty. Maritime offers no region choice.

The key is sealed with `MELETE_MASTER_KEY` like any provider key. It is sent
only to `api.maritime.sh` as a bearer token, never into a computer, a command's
environment, a log, a receipt or the model.

**What works.** Commands, with Melete's exit records, so a command whose answer
is lost is never run twice. Commands longer than Maritime's 30-second `exec`
run in the background and are polled until they finish. Files in and out of
the workspace, kept on the computer's `/data` disk. Maritime's desktop user is
not root and cannot make `/work`, so the workspace lives at `/data/work` and the
adapter respells `/work` at its edge: in a command's folder, in file paths, and
in a command's words wherever `/work` stands as a path of its own. A command
that means the text `/work` itself, such as `grep /work notes.txt`, sees
`/data/work` instead, and `pwd` prints `/data/work`. Sleep and wake for a kept
workspace. Each computer is found again by a hash of this installation's ids,
never by a person's name or email, and reconciliation removes only this
installation's own computers.

**What does not.** No egress control, no preview URLs or inbound ports, no
region choice, no custom images, and no live terminal stream. A single file
transfer is at most 8 MiB: a larger upload is refused with a message that says
so, and a larger download is read up to 8 MiB only when the caller asks for no
more than that. Of the desktop tools, `computer.open` is not offered (open an
address by clicking the browser's address bar and typing it), and the screen is
not read as text, so the agent reads the screenshot itself.

**The desktop.** Computers on Maritime can now be driven by the agent and taken
over in the app. The agent's `computer.*` tools (screenshot, click, type,
keys, scroll and batch) run as Maritime actions, with the same receipts as on
Docker: each step ends with a screenshot kept in the job's workspace. The
screen is 1200x750, the frame Maritime's screenshots are taken in; positions
the agent gives are in that frame, and are scaled if a computer's screenshots
come back at another size.

Watching and taking over happen in Maritime's own viewer, which opens in a new
tab, since the app does not frame other sites:

- *Watch in a new tab* asks for a fresh view-only link, valid for ten minutes.
  Watching never stops the agent.
- *Take over* parks the agent's work as on Docker. *Open the desktop* then asks
  for a fresh link that drives the computer, valid for five minutes; *Open a
  fresh link* replaces it, and the old one stops working. While that link is
  out, Maritime refuses the agent's actions, and the agent is told so in a
  plain sentence.
- When you are done, press *Done* in the viewer, or *Hand back* in the app.
  Handing back closes the computer's session, which ends every link it gave
  out, and the agent carries on from a fresh screenshot. Maritime holds the
  desktop for you from the moment a link to drive it is made, opened or not,
  until *Done* or a minute or so after the link runs out. So a hand-back while it
  still holds the desktop first asks for a new 30-second link, given to no one,
  which ends yours; the agent then carries on once Maritime gives the desktop
  back, about a minute and a half later, rather than being refused at every step.
- If your link runs out while you still have the computer, the panel says so;
  open a fresh link to carry on, or hand it back. Asking for links is limited to
  twelve a minute per person and computer, since each one is a call on the
  installation's Maritime key.

Links are asked for each time they are opened and answered with
`cache-control: no-store`. They are never kept, written to the timeline, a
receipt or a log, and never given to the model. Only the person the job belongs
to (or a room's owner) can get a link that drives the computer; a room's
members can watch.

E2B, Daytona and Modal computers have no desktop: the `computer.*` tools are
not offered there, and a call to one is refused in a plain sentence.

**Sizing.** Maritime limits how many computers an account keeps and how many
are awake at once; a sleeping computer counts only toward the first. An account
serves as many agents as it keeps computers, and as many of them as it lets be
awake can run commands at the same moment.

**Caps.** Two settings in `deploy/.env` keep this installation inside the
account's limits, so it never asks for computers the account does not allow.
Both are unset by default, which means no cap:

- `MELETE_MARITIME_MAX_COMPUTERS`: the most computers kept at Maritime, asleep
  or awake. Past it, a new computer is refused, and the agent tells the person
  in a plain sentence. No computer is made.
- `MELETE_MARITIME_MAX_AWAKE`: the most awake at once. A computer that would
  wake past it waits up to 30 seconds for a place, then is refused the same
  way. A sleeping computer is never swapped for a new one to get round it.

Set them to your Maritime account's limits. The counts are kept in the
database, so several service instances share them and concurrent requests
cannot pass a cap. Computers made before the caps were set are counted once
they are next checked or used. Lowering a cap below what is in use refuses new
computers and wakes until enough are deleted or asleep; computers already awake
keep working. A create whose answer was lost keeps its place for up to fifteen
minutes, since Maritime may have made the computer; reconciliation removes such
a computer. Each computer has 2 GB of memory and 5 GB of disk unless the account
raises them.

**How sleep works.** Maritime puts a computer to sleep after five minutes with
no action, keeping its memory and its disk. Melete
wakes it before every command and touches it every four minutes while a
command runs, so a long command is not put to sleep under it. After seven days
asleep the memory snapshot is dropped and the next wake boots fresh on the same
disk: files stay, running programs do not. Deleting the connection's workspaces
deletes their computers and disks.

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

### How much each person keeps

By default nobody is limited. To cap how much one person may keep, set
`MELETE_STORAGE_PER_PERSON_MB` in `deploy/.env` and recreate the service.

What counts, across all of a person's spaces: the files they sent in chat, and
every file their work saved, in their Files or in a chat's own folder,
generated recordings and published files among them. A file a member's request
saved in a shared space counts against that member, not the space's owner, and
so does a file a member copies into a room from their own work; work in a
shared space that nobody asked for counts against its owner. Someone who leaves
a shared space, or is removed from it, stops being charged for what they kept
there, since they can no longer delete it. A file deleted into the trash stops
counting, and counts again if it is put back. Deleting a chat frees what its
folder held and the files sent in it. Files the agent's computer made in its
own `/work` are not counted until they are moved or saved into Files.

The amounts are read from what the service recorded as each file was saved,
moved and deleted, never by walking the disk. They are recorded whether or not
a limit is set, from the version that added this setting on; files saved
before that upgrade are not counted. The limit is checked as each upload
begins and as each step is proposed, so uploads sent at the same moment, or
steps proposed before the others landed, can take a person past it; once they
are past it, nothing more is saved until they free space.

Once a person reaches the limit, an upload is refused with a sentence that says
how much they use and that deleting files in Files, or chats with files sent in
them, frees space. A step that would save a file past the limit is refused the
same way, and the agent passes it on. A step whose size is known only once it
runs, such as a generated recording, goes ahead until the limit is reached.
The Files page shows how much the person uses against the limit, only when one
is set.

## Company map

A scan reads the connected mailbox with the installation's own model, once the
default provider is a real one with its key: the model named by
`MELETE_DEFAULT_MODEL`. `MELETE_COMPANIES_MODEL` names another model for scans
alone, and `MELETE_COMPANIES_PROVIDER` another provider for it. The
demonstration, and an installation whose provider has no key yet, read mail with
the built-in rules instead, which find less and cost nothing.

Each scan reads at most fifty messages. `MELETE_COMPANIES_DAILY_CALLS`, when
set, is how many model calls one person's scans may make in any 24 hours,
across all their spaces; it is empty, and so no limit, unless you set it. Calls
are counted either way. A message past the allowance is read on a later scan.
Set these in `deploy/.env` and recreate the service.

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
many a day, and how close together events are grouped into one push. Nothing
Melete decides to say by itself is sent outside their day hours, in their own
time zone, and every push says why it was sent. What the person asked for at a
time they chose (a reminder coming due, a routine's scheduled run, the report
from a scheduled occurrence of long work) goes at that time, whatever the hour,
and does not count toward the daily limit.

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

A conversation's reply has one more runaway stop, which is fixed rather than a
setting: a reply that writes the same block of prose, at least 600 characters
of it, four times over is stopped there. The person keeps the text up to the
end of the first copy and a line saying why, and the service logs
`runaway_reply_stopped` with the job, the attempt and the number of copies,
never the words. Copies are compared by their words, so spacing, punctuation
and case do not hide one. Code blocks, tables, list items and short paragraphs
never count, and the same letter written out for three people is three copies,
one short of a stop.

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

How much of a model's window an attempt starts with follows that model's
window from the same catalog; there is nothing to set. A 128,000-token model, and
any model Melete does not know, gets the baseline: about 750 tokens of tool
definitions with the rest named for the model to load, three skills, 2,000
tokens of what Melete remembers, and about 8,000 tokens of the conversation. A
larger window gets proportionally more, up to a ceiling: a million-token model
starts with about 5,900 tokens of tool definitions, six skills, 8,000 tokens of
memory and up to 62,500 tokens of the conversation, and the engine summarises in
place beyond that, as above. These follow the smallest window that applies:
`MELETE_MODEL_CONTEXT_WINDOW` and a job's own input limit narrow them (never
below the baseline, and never above the catalog's figure for the model), and
the conversation is also held to four tenths of the compaction trigger, so with
the default `MELETE_COMPACTION_MAX_TOKENS` a million-token model carries about
52,000 tokens of it. Older messages past that are summarised for the agent by
the secondary or fast model, once each, and the chat says "Earlier messages
summarised"; a private conversation with no local model is not summarised, and
the agent is told what it cannot see. Tokens are counted the way the engine counts them, a token
per character in scripts such as Chinese or Japanese, so a conversation in any
language stays inside these numbers and inside the largest request the gateway
accepts.

A tool the model loads part way through a reply is added to that reply's run,
so loading one costs no restart.

Requests are ordered so the parts that stay the same from one turn to the next
come first, and the gateway asks each provider to reuse them: Anthropic through
cache breakpoints, OpenAI and a ChatGPT plan through one cache key per
conversation, Fireworks by keeping a conversation on one server. A key is
derived with the install's own capability key from one conversation, or from
one service call for one space, so no two people, spaces or installs share
one and nobody outside the install can work one out. Cached input is priced
from the same table as spending (see the spending limits below), and each call
also records its input in full-price-equivalent tokens beside the raw counts.
A model on your own machine is never discounted.

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

Slots are shared fairly between people too: within chats, routines and quiet
work alike, the next free slot goes to the waiting person who is running the
fewest, and among equals to the one who started something longest ago, so one
person with many chats or routines cannot keep everyone else waiting.
`MELETE_ATTEMPT_CONCURRENCY_PER_PERSON` (unset by default, which is no limit of
its own) also caps how many one person runs at once, even while slots are
free; `init --hosted` writes `2`. The cap counts everything a person runs on
one service instance; with several, each counts its own (see
[Running more than one service instance](#running-more-than-one-service-instance)).
Their routines and quiet work may use all of it but one slot, which stays free
for their chats, so their own routines never hold back their chat (with a cap
of `1`, a chat waits for their running routine). Work held by its person's cap waits
without taking a queue worker, so other people's work still starts.

## Starter tasks

A new person's Home offers a few one-tap starter tasks once setup is done:
finding well-reviewed places near them, a reminder in ten minutes, a one-page
PDF of the day's news, pulling facts out of a file they attach, watching a
page, and planning a trip. Each works with no apps connected, and none sends a
message, buys anything or needs a sign-in elsewhere. A tap writes the request
into the composer to edit; nothing is sent until the person sends it. They go
away once the person has three chats, or when they choose "Hide these", which
is kept for their account on every device.

`MELETE_STARTERS` replaces the built-in list with your own, as a JSON array of
at most six entries:

```json
[{ "id": "coffee-nearby", "label": "Coffee shops nearby",
   "text": "Find 3 well-reviewed coffee shops near {city} and put them in a short list.",
   "icon": "mapPin", "capability": "research" }]
```

`text` may hold `{city}`, filled with the city of the person's time zone, and
one `[blank]`, whose words are selected in the composer so the first thing the
person types replaces them. `icon` is one of `mapPin`, `bell`, `fileText`,
`upload`, `globe`, `compass`, `sparkles`, `calendar`, `search` or `clock`;
`capability` one of `research`, `reminders`, `files_out`, `files_in`,
`monitoring`, `planning` or `other`. A list that does not parse or fit stops
the service at start with the reason.

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
| `MELETE_SPEND_PERSON_MONTHLY_USD`, `MELETE_SPEND_PERSON_DAILY_USD` | Dollars one person may spend (at most $1,000,000, like the background caps below) |
| `MELETE_SPEND_MONTHLY_TOKENS`, `MELETE_SPEND_DAILY_TOKENS` | Input and output tokens for the whole installation |
| `MELETE_SPEND_PERSON_MONTHLY_TOKENS`, `MELETE_SPEND_PERSON_DAILY_TOKENS` | Tokens for one person |
| `MELETE_SPEND_NOTICE_PERCENT` | When the person is told a limit is close (default `80`) |
| `MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD`, `MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD` | Dollars one person's background calls may spend |
| `MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_TOKENS`, `MELETE_SPEND_PERSON_BACKGROUND_DAILY_TOKENS` | Tokens for one person's background calls |
| `MELETE_JOB_USD_COUNTS_MODELS` | `true` counts each job's model calls against its dollar limit (`max_usd_est`), beside its actions (default `false`) |

Each limit left empty is no limit, which is the default, so an installation
that sets none behaves as before. A call counts against the person who caused
it: in a conversation, whoever wrote the message being answered, so someone at
their limit cannot keep going in another person's conversation and charge it to
them; for a routine or background job nobody has written in, whoever created
it. A memory read counts against the person whose words are read, a voice aside
against the person talking, and a companies scan against the person who started
it.

- At the notice level of any limit, the person sees a quiet line at the top of
  every page, and above the composer in a chat with when the limit starts
  again; Settings › Models shows it beside this month's usage. The service log
  records `spending: person warning (month)` once per period.
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

A model that charges more for a long prompt can name that price as
`long_prompt`, for example
`{"input":0.1,"output":0.5,"long_prompt":{"above":100000,"input":0.5,"output":2.5}}`:
a call whose input, cached input included, is above `above` tokens is charged
at it in full. The built-in table prices Haiku 5.5 this way.

`cached_input` is the price of input read from the provider's cache, and
`cache_write_input` the price of input written to it. Left out, each is the
provider's published share of `input`: a cache read at a tenth for Anthropic,
OpenAI, a ChatGPT plan and Google, a fifth for Fireworks (the highest share it
lists for any model), and an
Anthropic cache write at a quarter more. Any other provider, an endpoint you
add yourself included, is priced as though nothing was cached. A call answered on the person's own model (the local
model a private conversation uses, an endpoint the owner confirmed is on their
device, or an OpenAI-compatible endpoint at a local address) costs nothing and
is recorded as served by `local` where the privacy router sent it there; its
tokens still count. Give such a model a price (for example `"local/*"` or
`"openai-compatible/*"`) to have it counted in dollars. `GET /usage` returns the signed-in person's totals, their limits, the notice and
this month's calls by model; the installation's totals and limits are included
for its owner alone.

Removing a space keeps its calls' amounts, so a limit is not reset by deleting
a space; which space and job they came from is removed with it.

Each call is also recorded as `interactive`, when a person was waiting on it,
or `background`, when nobody was, with the step that made it and the trigger
behind it. The background limits above count a person's background calls alone
and hold back only those: at a background limit, background work starts
nothing new (a run rests until the limit resets, keeping what arrives for it)
and the person reads "Background work has reached today's limit; it starts
again on October 16 at 00:00 UTC. Your own messages still go through.", while
their own messages keep running. Each finished UTC day is rolled
up into `usage_day` within the hour, by one instance, and `GET /usage` adds the
month by purpose and by step, the last 30 days, and, for the owner, background
cost per active person-day over the last week.
[Background work and what it costs](BACKGROUND-COMPUTE.md) covers it in full.

With `MELETE_JOB_USD_COUNTS_MODELS=true`, a model call is charged its
estimated cost against its job's dollar limit as well. A call is admitted while
the limit is not yet spent and charged when it reports, so one call may finish
past the limit; the next is refused, as an action past the limit is. Jobs carry
a $1 limit by default, so turn this on together with the dollar limits your
installation gives its jobs.

## Space rules

Spending caps apply to everyone alike. Space rules are set per space, for an
installation several people share: which models a space's work may run on, and
which kinds of connected app and tool it may not use. Every space starts with
none, so a single-person installation behaves as it always has.

Whoever set up the installation may set the rules of any space; a space's own
owner may set them for that space. Anyone the space admits can read them. They
are in Settings › Space rules, and through the API:

```bash
curl -b cookies.txt https://melete.example.com/spaces/sp_.../policy
curl -b cookies.txt -X PUT https://melete.example.com/spaces/sp_.../policy \
  -H 'content-type: application/json' \
  -d '{"allowed_models":["anthropic/claude-sonnet-4-5"],"denied_connector_kinds":["mcp"],"denied_tool_kinds":["email.send"]}'
```

| Rule | What it does |
| --- | --- |
| `allowed_models` | `provider/model` entries, in order. When the model work would use is not listed, it moves to the first listed model whose provider is connected; with none connected, the attempt stops and the conversation says why. A vision or fallback route to a model not listed is not taken, and the service's own model calls about the space (memory reads, summaries, reviews of its actions, reading its mail for Companies) keep to the list too. A review with no allowed model to use leaves the action for a person to approve. Empty allows any model. |
| `denied_connector_kinds` | Connection providers, such as `imap`, `caldav`, `mcp` or `command_line`. A connection of a listed kind cannot be added to the space, and one added earlier is neither offered to the agent nor used. |
| `denied_tool_kinds` | A tool by its name, such as `email.send`, or a family by the part before its first dot, such as `email`, which covers `email.read` and `email.send`. It covers the tools of connections, the built-in files, web and computer ones included. The agent is not offered them, and is refused if it asks for one anyway. Melete's own tools for asking the person, following up and searching memory are not affected. |

A change applies from the next attempt, catalog and call; an attempt already
running on a model the rules now leave out has its next call refused.

## Attachments

Files sent in chat (pictures, PDFs, Word documents, spreadsheets and text
files) are taken up to a size and a number per message. Nothing limits how
many files one person uploads unless you set a limit, so a self-hosted
installation never turns someone away for uploading; an installation shared
with many people, such as a hosted one, can set the per-person limits.

| Setting | Limit |
| --- | --- |
| `MELETE_ATTACHMENT_MAX_MB` | The largest file, in MB (default `20`, at most `100`) |
| `MELETE_ATTACHMENTS_PER_MESSAGE` | The most files in one message (default `10`, at most `100`) |
| `MELETE_ATTACHMENT_UPLOADS_AT_ONCE` | Uploads one person may have under way at once (default: no limit) |
| `MELETE_ATTACHMENT_UPLOADS_PER_WINDOW` | Uploads one person may start in a window (default: no limit) |
| `MELETE_ATTACHMENT_UPLOAD_WINDOW_MINUTES` | That window, in minutes (default `10`) |
| `MELETE_ATTACHMENT_SERVER_UPLOADS` | Uploads the whole service holds in flight at once, from everyone (default `16`) |
| `MELETE_ATTACHMENT_SERVER_UPLOAD_MB` | The MB those uploads may hold between them (default `384`, never less than one file at the largest size) |

- A file over the size, or a message over the number, is refused with a plain
  sentence before anything is kept: "Files can be up to 20 MB. scan.pdf is
  25 MB."
- Past an upload limit the request gets `429` and a sentence ("You can upload
  3 files at a time. Wait for one to finish, then try again."). The web client
  reads the limits from `GET /attachments/limits` and queues its uploads to
  the number at once, so a person picking many files never sees that refusal.
- The upload window is counted where sign-in limits are, in Postgres, so every
  service instance shares it; the number at once is counted by each instance.
- The last two settings are not limits on people. An upload is held in memory
  while it is read, so each service instance always bounds how many it holds
  and their bytes; past that, an upload gets `503` and "Melete is busy reading
  other files. Try again in a moment."
- So that one person cannot fill those bounds and keep everyone else out, one
  person may hold at most half of each (8 uploads by default, and no more
  files at the largest size than fit in half the bytes), or your
  `MELETE_ATTACHMENT_UPLOADS_AT_ONCE` if it is lower. `GET /attachments/limits`
  gives that number and the web client queues to it, so a person sending ten
  files sees them all finish; only a client that ignores it gets `429`.
- Every way a message arrives (a chat, a chat started from Home, and
  `POST /jobs/{id}/input`) binds its files in one place, which checks the files
  per message and that each is the sender's own, unsent, and in the same space.
- Reading a file stays bounded whatever these are: two reads run at a time
  with a short queue, each with a deadline and a memory ceiling, and archives
  and page counts are capped, so a crafted file cannot take the service down.

## Model routing

By default every call uses the model chosen in Settings › Models, else
`MELETE_DEFAULT_PROVIDER` and `MELETE_DEFAULT_MODEL`. These settings, each
written `provider/model` (the provider name before the first slash), let
Melete pick a better model per call:

| Setting | Used for |
| --- | --- |
| `MELETE_MODEL_FAST` | The service's short calls: reading chat into memory, voice-mode asides, the auto-review classifier, the companies scan, conversation summaries, learning from corrections and the first-line acknowledgement |
| `MELETE_MODEL_VISION` | An agent request that carries a picture, when the turn's model does not read images |
| `MELETE_MODEL_FALLBACK` | Comma-separated, tried in order when a provider rate-limits (429), times out, fails (5xx) or cannot be reached, before any of the reply has been sent |
| `MELETE_MODEL_BACKGROUND` | Everyone's scheduled and background work: routines, watches, standing runs and any turn nobody is waiting on. Unset, that work runs on the default model. A person's own messages never run on it |
| `MELETE_MODEL_TRIAGE` | Sorting new mail and calendar changes for Home's "Needs you" list, or `off`. Unset, the owner's secondary model for scheduled work, else `MELETE_MODEL_FAST`, else the default. See [Sorting what came in](SITUATIONAL-AWARENESS.md#sorting-what-came-in) |

For example:

```bash
MELETE_MODEL_FAST=fireworks/accounts/fireworks/models/llama-v3p1-8b-instruct
MELETE_MODEL_VISION=fireworks/accounts/fireworks/models/qwen2p5-vl-32b-instruct
MELETE_MODEL_FALLBACK=fireworks/accounts/fireworks/models/deepseek-v3
```

`MELETE_ACK_AFTER_MS` (default `0`, off) is how long a chat turn may stay
silent before the person is shown one line saying what the agent is about to
do, written by the fast model from their message alone, with no tools and no
memory. Off, nothing is written and no model is called for it. On, the line is
written as each chat turn with a new message starts, so it is ready by then,
and shown at that time or as soon as it is ready after, only while the agent
has said nothing. That is one short fast-model call for nearly every such turn,
including turns the agent answers before the line is needed; the call is
cancelled once the agent's own words arrive. Once the line is shown, the agent
is told what was said, and its own opening line about what it will do is left
out (an English plan line only; anything else it writes is shown). With
`MELETE_MODEL_FAST` unset, the line is written by the default model, which is
slower; set a small fast model for it. `800` is a good value with one.

The rules, in order:

- A model the owner chose in the app always wins for agent turns: those turns
  are never sent to the vision model or a fallback.
- Background work runs on `MELETE_MODEL_BACKGROUND` when it is set, in every
  person's spaces, even when the owner chose the primary model in the app; it
  keeps the vision model and the fallbacks. In the owner's own spaces, their
  secondary model wins once they move scheduled work to it in Settings ›
  Models. On a hosted installation a cheaper model here, such as
  `anthropic/claude-haiku-5-5`, keeps routines from spending at the primary's
  price, and their cost still counts against the background caps.
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
An agent turn that answers a person's message of 280 characters or fewer
thinks one step less: `medium` becomes `low`, `high` becomes `medium`; once
its tool loop has run four rounds it is multi-step work and thinks at the
agent's effort again. A turn whose message asks for depth ("think it through",
"in depth", "thoroughly") thinks one step more, as does a call after two
failed tool results in a row, up to `high`.
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
- melete-cells, or the container engine behind it, does not answer, so no
  attempt or agent's computer can start (`cells`);
- the disk runs short: less than `MELETE_ALERT_DISK_MIN_FREE_MB` (default
  `2048`) MB free under the spaces, artifacts or work directory (`disk`);
- the job queue is stuck: work due more than ten minutes ago has not started;
- the error rate spikes: over the last fifteen minutes, at least five attempts
  or model calls and half or more of them failed, were lost, or were refused by
  the provider;
- background work is stuck on one item: a pass that walks many spaces or
  accounts, such as the trash sweep, failed on the same one three times in a
  row (`background_work`, which names the pass, the item and the error). Each
  service instance counts only its own passes, so with several instances on one
  database a stuck item shows only on the instance whose pass is stuck: the
  alert comes only when that is the instance holding the `health-alerts` lease,
  and `/health/detail` shows it only when the request reaches that instance;
- where set, spending runs high: the last hour's model calls cost more than
  `MELETE_ALERT_SPEND_HOURLY_MULTIPLE` times the installation's usual hour (the
  median hour of the week before), or one person accounts for more than
  `MELETE_ALERT_SPEND_PERSON_PERCENT` percent of today's spending while others
  spend too. Neither fires below `MELETE_ALERT_SPEND_MIN_USD` (default `1`)
  dollars. These checks are `spend_rate` and `spend_share`;
- where `MELETE_SPEND_MONTHLY_USD` is set, the month's model spending reaches
  `MELETE_SPEND_NOTICE_PERCENT` (default `80`) percent of it (`spend_cap`). At
  the cap itself model calls are refused for everyone until the month resets,
  so this is the time to raise it. The starting `$200` that `init --hosted`
  writes is reached by ten people at their own `$20` cap.

| Setting | What it does |
| --- | --- |
| `MELETE_ALERT_WEBHOOK_URL` | Receives a JSON POST: `text` (a sentence chat webhooks show), `status` (`unhealthy` or `recovered`), `service`, `version`, `checks` and `time` |
| `MELETE_ALERT_EMAIL_TO`, `MELETE_ALERT_EMAIL_FROM` | Where alert email goes, and its sender (default: the same address) |
| `MELETE_ALERT_SMTP_URL` | The SMTP server alert email is sent through, for example `smtps://alerts%40example.com:app-password@smtp.example.com:465`. As with `MELETE_SMTP_URL`, a plain `smtp://` server elsewhere must upgrade to TLS with STARTTLS; add `?requireTLS=false` only for a relay that cannot, and never `?opportunisticTLS=true` or `?ignoreTLS=true`, which send in plain text without saying so |
| `MELETE_ALERT_REPEAT_MINUTES` | While unhealthy, how often the alert is sent again (default `60`) |
| `MELETE_ALERT_DISK_MIN_FREE_MB` | The free space, in MB, below which the `disk` check fails (default `2048`; `0` turns it off) |
| `MELETE_OPERATOR_TOKEN` | A bearer token, at least 24 characters, that opens `GET /health/detail` |
| `MELETE_ALERT_SPEND_HOURLY_MULTIPLE` | Alert when the last hour's spending is above this many times the usual hour (off unless set) |
| `MELETE_ALERT_SPEND_PERSON_PERCENT` | Alert when one person is above this percent of today's spending (off unless set) |
| `MELETE_ALERT_SPEND_MIN_USD` | The fewest dollars either spending alert fires at (default `1`) |

Alerts are off until a webhook or an email address is set. One alert is sent
when the service turns unhealthy, again every repeat interval while it stays
so, and one more when it is healthy again. With several instances on one
database, the instance holding the `health-alerts` lease sends them.

Alert email needs TLS unless the mail server is on this machine
(`localhost`, `127.0.0.1` or `::1`). Releases up to v0.2.1 also sent it in
plain text, so an installation upgraded from one that sends alerts through a
relay on another host without TLS must add `?requireTLS=false` to
`MELETE_ALERT_SMTP_URL`. Otherwise its alert email stops, and the service
logs `alert not sent` each time.

`GET /health/detail` (through the web server, `/api/health/detail`) returns
each check with what it found, `200` while all pass and `503` while any fails.
That includes `background_work`, so one space whose background work is stuck
makes it answer `503` while everything else works:

```bash
curl -fsS -H "Authorization: Bearer $MELETE_OPERATOR_TOKEN" https://melete.example.com/api/health/detail
```

These checks run inside the service, so they cannot report the service itself
being down, the host losing power or the network failing. Add an external
uptime check as well: point a monitor such as UptimeRobot, Better Stack or
Healthchecks.io at `https://<your host>/api/health` every minute, alerting
when it fails twice in a row. `/api/health` answers `503`, with the same body
and `database` `unreachable`, while the database is down, so a monitor that
only reads the status code sees that too. Page on `/api/health`. With the
operator token, a monitor that can send a header can watch
`/api/health/detail` beside it, but its `503` can mean one stuck space as well
as an outage: treat it as a reason to read the checks it lists, not as the
uptime page.

## Memory extraction

Deployment memory can extract structured observations without a model. If
unstructured work has no extraction gateway, it stops at the third total claim
with status `rejected` and error `no_extraction_gateway` in `memory_work`.
Queue repair and duplicate deliveries do not restart that terminal work, and an
extraction gateway configured afterwards applies to new work only: evidence
already rejected stays rejected.

## Isolation and image provenance

The Docker socket is held by one service, `melete-cells`, and by nothing else
in the stack. Possession of the socket is host-root equivalent, so
`melete-cells` holds nothing else: no database address, no master key, no model
or connector key. The `melete` service, which serves the API and holds those,
has no socket. It asks `melete-cells`, on a private network the two share
alone, with a key `melete-cells` writes once into a volume the service mounts
read-only, and `melete-cells` starts only these fixed profiles:

| Profile | Image | Network | Storage |
| --- | --- | --- | --- |
| An attempt's engine | the runtime image the stack names, as it stood when the service started ([prebuilt images](#using-prebuilt-images)) | its own internal network, with the service as its one peer | its job's directory of the work volume, and its own home |
| An agent's computer | `MELETE_SANDBOX_DOCKER_IMAGE` | none, or its own internal network | its two volumes |
| A stdio MCP server | one pulled by digest from any registry that does not point back at the host ([CONNECTORS.md](CONNECTORS.md)), or the runner images below | none, or its own internal network | its own volumes |

Each runs as its profile's non-root user on a read-only root, with every
capability dropped and no privilege escalation. `melete-cells` refuses any
other image, a host path, a volume driver, privileged mode, an added
capability, a device, host networking or another namespace, a Compose or
other profile's label on a container it creates, and any request to change,
start, stop, enter or remove a container, network or volume no profile owns,
the database's included (`melete-cells refuses a container outside its
profiles`). Only the Compose `melete` service, never a profile's container,
may join a cell's network. Any container may be inspected, since the service
finds its own id and labels that way: a profile's container comes back
without its environment, and any other container with only its id, name,
image, state and labels (`an inspection of a container no profile owns keeps
only its state and labels`). `bun run compose:check`
fails if the service has the socket, if any service but `melete-cells` mounts
it, or if `melete-cells` is given a credential or another network.

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

Plugins and other stdio MCP servers run in containers `melete-cells` starts
for the service, under the MCP profile above, one per connection, with a volume of their own and no
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

## Database roles

The service runs under three Postgres roles:

| Role | What it may do |
| --- | --- |
| `melete_migrate` | Owns the schema and runs the migrations. The service is never given it. |
| `melete_api` | The service's own role. It reads and writes every table but `secret`, which holds each connected account's sealed credentials, and cannot read that one at all. It owns the wake queue's schema. Other sealed values (model provider keys and sign-in tokens, the privacy vault, the relay's certificate authority key) are in tables it can read. |
| `melete_effects` | The role of the code that opens a sealed credential to act through an account: it reads and writes `secret` and nothing else. |

`database-roles` sets them up before the service starts, every time the stack
starts. It is given `DATABASE_URL`, the operator's address in `deploy/.env`,
and only it is. It creates the roles (or resets their passwords), hands every
table the operator's user owns to `melete_migrate`, runs the migrations as
`melete_migrate`, grants the other two what the table above says, and writes
the service's two addresses into the `database-access` volume, which the
service mounts read-only. Each role's password is derived from `DATABASE_URL`,
so every host of one installation derives the same ones, and a new host after a
restore needs nothing copied.

Both addresses go to the one service process, which uses the effects role
only for `secret` and still holds the master key; the separation is in what
each query can read, so a query the service runs as itself, however it was
built, cannot return a row of `secret`. The service checks at start that every
migration of its release has run and that its own role cannot read `secret`,
and refuses to start otherwise. An
upgrade needs no change to `deploy/.env`: the first start of the new release
creates the roles and hands over the existing tables, with their data, in the
same step (`an upgrade from the current main's deployment, with data, works
and keeps secrets readable for effects`). A restore loads the dump as the
operator's user with `--no-owner`, and the next start hands the tables over
again. `bun run compose:check` fails if the service is given `DATABASE_URL`,
reads another role's address, or starts without `database-roles` first.

### Roles an administrator creates

Some managed databases do not let their application user create roles. There,
the database's administrator creates them once:

```sql
create role melete_migrate login password '<first password>';
create role melete_api login password '<second password>';
create role melete_effects login password '<third password>';
grant create on database melete to melete_migrate;
grant create on schema public to melete_migrate;
grant melete_migrate, melete_api to <the user DATABASE_URL names>;
```

Then set the three addresses, each to the same server and database as
`DATABASE_URL`, with the same `sslmode`:

```bash
read -rs MELETE_MIGRATE_DATABASE_URL && export MELETE_MIGRATE_DATABASE_URL
read -rs MELETE_API_DATABASE_URL && export MELETE_API_DATABASE_URL
read -rs MELETE_EFFECTS_DATABASE_URL && export MELETE_EFFECTS_DATABASE_URL
bun run melete set --from-env MELETE_MIGRATE_DATABASE_URL MELETE_API_DATABASE_URL MELETE_EFFECTS_DATABASE_URL
```

`database-roles` then uses those roles as given and creates none. A restore
or a rollback into a new database needs the same two grants there, and the
three addresses pointed at it; `restore` refuses while they name another
database than `DATABASE_URL`.
`bun run melete check` refuses the setting when only some of the three are set,
when one names another server or database, or when the service's role is
`DATABASE_URL`'s own user.

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
egress record retention, the background process monitor, the health alerts and
the sweep that ends room guests' places when their time is up each run on the
instance that holds that work's lease. A lease is a Postgres advisory lock on a connection the
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
- Attempt slots (`MELETE_ATTEMPT_CONCURRENCY`) and a person's own cap
  (`MELETE_ATTEMPT_CONCURRENCY_PER_PERSON`) are counted by each instance for
  the attempts it runs, so a person can run up to their cap on every instance,
  and work one instance holds back for its person's cap can be started by
  another. Run one instance where that cap must hold exactly. The spending caps
  and the limits on computers are kept in Postgres and hold across instances.

## Upgrading

[Upgrading between releases](UPGRADING.md) is its own page: the target
release's `deploy/scripts/upgrade.ts`, taken out of its tag, prints the whole
plan with `--dry-run`. An installation that runs the published images updates
with `bun run melete deploy` instead ([Update](#update)). The service migrates its database at every boot under an advisory lock, so the
procedure is a consistent backup, a checkout, a rebuild and a wait for health;
the backup below is its first half.

## Memory limits

Each long-running service has a memory cap, so one runaway process or query
cannot take the whole machine, the agents' computers and the database with it.
The defaults fit a small virtual machine; raise them in `deploy/.env` on a
larger one, then apply the change with `bun run melete deploy` or by recreating
the service (`up -d --force-recreate <service>`).

| Setting | Service | Default |
| --- | --- | --- |
| `MELETE_MEMORY_LIMIT` | `melete` | `2g` |
| `POSTGRES_MEMORY_LIMIT` | `postgres` | `1g` |
| `WEB_MEMORY_LIMIT` | `web` | `256m` |
| `MELETE_CELLS_MEMORY_LIMIT` | `melete-cells` | `512m` |

The `runtime` service keeps its own `2g`; attempt containers and agents'
computers are started with limits of their own. `bun run compose:check`
refuses a long-running service without a cap. CPU is left unlimited: a fixed
CPU count is refused outright by a machine with fewer cores.

## Logs

Docker's default `json-file` log has no size limit. Every Compose service, and
every attempt container the supervisor starts, instead rotates a `json-file` log
at 10 MB and keeps five files, so one container holds at most about 50 MB of
log on the host. Read them with Compose:

```bash
docker compose -f deploy/docker-compose.yml logs --since 1h melete
bun run melete logs melete --since 1h      # the same, with the deploy file's overlays
bun run melete logs --attempts             # the containers attempts ran in
bun run melete logs --attempts att_01... --tail 200
bun run melete logs --computers            # the agents' computers
```

An attempt's container is found by its attempt id, a computer's by its name.
A container that was removed when its work ended has no logs left.

The limits live in the `x-logging` anchor at the top of
`deploy/docker-compose.yml`; a changed limit applies when a container is
recreated, not on restart. `bun run compose:check` and
`bun run browser:compose:check` refuse a service without the bound. Each line
also names its Compose project and service (the json-file driver's `labels`
option), so a shipped line says where it came from.

### What the logs hold

The service and `melete-cells` write ids, codes, counts and short reasons:
which job, attempt, connection or route failed, and why. They never write
what someone wrote, a file's contents, a prompt, a model's answer, a password,
a token or a sign-in secret. `apps/melete/src/log-content.test.ts` reads every
place they write a line and fails on one that writes a value named like
content or a secret. Error messages are written, cut short; before any line
leaves the process, known secret shapes are taken out of it (an address's
user and password, `Bearer` credentials, JWTs, provider keys, private keys,
`password=`-style pairs, long random tokens) and email addresses become
`[email]` (`apps/melete/src/log-guard.ts`). Ids, digests and container names
stay, since the log is read by them. The bundled Postgres writes an error's
reason alone, never the failing row or the statement that hit it.

The containers attempts, agents' computers and connection installs run in are
different: what they print is the agent's own work. Their logs stay on the
machine (`melete logs --attempts`, `--computers`) and are never shipped.

### Shipping logs

Rotation keeps about 50 MB per container. To keep logs longer, or to search
them in one place, send them to a log collector that accepts OTLP over HTTP:
Grafana Loki 3 (its `/otlp` endpoint), Grafana Cloud, an OpenTelemetry
Collector of your own, or any hosted service that takes OTLP logs.
`deploy/docker-compose.log-shipping.yml` runs an OpenTelemetry Collector
(`deploy/config/log-shipping.yaml`) that reads the json-file logs on the
machine from the moment it first starts and sends the lines of the stack's
Compose services, each with its `container.id`, `service.name` (the Compose
service) and `service.namespace` (the Compose project). A line is sent only
when its container's logging labels it with a Compose service, as `x-logging`
in `deploy/docker-compose.yml` does; attempts, computers and other projects'
containers carry no such label. It is a Compose project of its own,
so `deploy`, `upgrade` and `logs` neither start nor need it, and nothing is
sent anywhere until you start it:

```bash
bun run melete set MELETE_LOG_SHIP_ENDPOINT=https://otlp.example.net/otlp   # /v1/logs is added
read -rs MELETE_LOG_SHIP_AUTHORIZATION && export MELETE_LOG_SHIP_AUTHORIZATION   # e.g. "Basic <base64 of user:key>"; leave unset if none
bun run melete set --from-env MELETE_LOG_SHIP_AUTHORIZATION && unset MELETE_LOG_SHIP_AUTHORIZATION
docker compose -p melete-logs --env-file deploy/.env \
  -f deploy/docker-compose.log-shipping.yml up -d
docker compose -p melete-logs --env-file deploy/.env -f deploy/docker-compose.log-shipping.yml logs --tail 20
```

| Setting | Default | Meaning |
|---|---|---|
| `MELETE_LOG_SHIP_ENDPOINT` | none (required) | The collector's OTLP/HTTP base address |
| `MELETE_LOG_SHIP_AUTHORIZATION` | empty | The `Authorization` header it expects, if any |
| `MELETE_LOG_SHIP_MEMORY_LIMIT` | `512m` | The shipper's memory cap |

The shipper runs as root, because Docker's log files are readable by root
alone, with no capabilities, no new privileges and a read-only filesystem; it
mounts the log folder read-only and has no Docker socket. Where each file was
read up to, and batches waiting while the endpoint is unreachable, are kept in
its `log-shipping-state` volume, so a restart neither resends nor skips. A
second installation on the machine is shipped too, under its own
`service.namespace`. Stop it with the same `docker compose -p melete-logs --env-file
deploy/.env -f deploy/docker-compose.log-shipping.yml` prefix and `down`,
adding `--volumes` to forget where it was.

## Backup and restore

```bash
bun run melete backup --estimate      # sizes, against the free space where the backup goes
bun run melete backup                 # everything, with the stack running
bun run melete backup --offline       # everything, with the writers stopped while the files are copied
bun run melete backup --database-only # the database, journal and settings alone
bun run melete backup --to ssh://backup-host:/srv/melete-backups
bun run melete backup --encrypt-to age1...  # every part encrypted with age to that public key
bun run melete restore ~/melete-backups/melete-20261002T101500Z --verify  # read every part; change nothing
bun run melete restore ~/melete-backups/melete-20261002T101500Z           # print the steps; change nothing
bun run melete restore ~/melete-backups/melete-20261002T101500Z --yes     # run them
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
each part as it is loaded. `restore --verify` and `--yes` need what opens it:
for age, export `MELETE_BACKUP_IDENTITY` as the path of the identity file; for
gpg, export the passphrase as `MELETE_BACKUP_PASSPHRASE`. The list of parts,
`contents.json`, stays readable like `SHA256SUMS`: it names volumes, never
their files.

**The S3 bucket is outside the backup.** With `"blobs": { "store": "s3" }`, the
files the service keeps by their content (uploads and Files) live in the
bucket, and a backup holds only the database's references to them; it still
holds the spaces' own files, the shared `/work` and the agents' computers.
Every backup says so when it is made. Protect the bucket at the provider:
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
then the files, one archive per volume, with ownership and modes kept:
`spaces.tar` (each space's files, without its search index, `.index/`, or the
writes staged in `.proposed/`: the index is rebuilt from the files the first
time a restored space is searched, and a restore leaves both out of a backup
made before they were), `artifacts.tar` (uploads and Files, kept by
their content, unless they are in an S3 bucket), `work.tar` (the shared
`/work`), and for each agent computer of this installation its two volumes,
`computer-<name>-work.tar` and `computer-<name>-home.tar` (its `/work` and its
home folder, browser profile included). A computer is this installation's when
its volumes' `melete.install_project` label names this installation's Compose
project, whatever `MELETE_SANDBOX_PROJECT` it was made under, so the computers
an agent still resumes after that setting changes are kept too; one made before
computers carried that label is this installation's when its `melete.project`
is the current `MELETE_SANDBOX_PROJECT` (see
[Computers a backup leaves out](#computers-a-backup-leaves-out)
for the others); `contents.json`, which lists those
archives and each computer volume's labels and names the installation's
Compose project; and a `SHA256SUMS` list. The
`runtime-home` volume, the home folder of the warm runtime container that no
job runs in, and each attempt's own home are left out: they keep no job's
work, and jobs recover from the database into fresh attempts. Each new backup removes the older ones
beyond the newest `backup.keep` (3 by default), and every one older than
`backup.max_age_days` (30 by default), from `backup.dir`; the one just made
always stays. Each holds the files, so the disk they take is at most about
`backup.keep` times what `--estimate` reports. `--to` streams every part to
another machine over SSH and keeps nothing on this disk, for a host short on
space. `backup.keep` and `backup.max_age_days` apply in the folder there in the
same way: the backups in it are listed over SSH, and this installation's beyond
them are removed there, never another installation's or one that does not say
whose it is. The listing reads only the files that name a backup's
installation, and of its `deploy.env` only the `COMPOSE_PROJECT_NAME` line, so
no service key leaves that machine. When the listing fails, nothing is removed
that night and the backup warns (`backup.keep`).

**What "online" means for the files.** By default the stack keeps running. The
database is dumped first and the files are copied after it, so every file the
dump refers to is in the backup; a file written in between is in the backup
without a reference, which is harmless. A file being written while it is
copied can be caught halfway; the backup still passes, and warns
(`backup.files_changed`) naming the archives it happened in. Each agent computer
that is running is paused while its own two volumes are copied, a few seconds
for a typical one, so its files, the browser profile among them, are from one
moment; a command it runs waits meanwhile, and it is resumed even when the
copy fails. `--offline` (formerly `--with-volumes`, still accepted) stops the
service, the runtime, the web app, the browser worker and `melete-cells`, with
the attempt containers it started, while the files are copied, so the database
and the files agree exactly, then starts them again.
`--database-only` leaves the files out, and says so: a restore from it brings
back the database alone and leaves the files on the machine as they are, so on
a new machine the uploads and Files it refers to are missing unless they are in
an S3 bucket.

**Restoring.** `restore <backup>` checks the checksums and the list of parts,
and prints the steps; `--verify` (or `--dry-run`) also reads every archive
through, decrypting an encrypted one, so a damaged or missing part shows before
you need it. Neither changes anything. `--yes` checks every archive the same
way first, then runs the steps in order: it stops the writers, `melete-cells`
and the attempt containers it started, and every agent computer whose container
is on the machine, running or not; takes the stack down without touching its
volumes; replaces the database volume and loads the dump; puts the newest
restriction journal back where the journal volume is missing or holds no entry,
as on a machine that never ran the installation or after a restore that stopped
before that step (keeping its file ownership); empties each file volume and
unpacks its archive into it, after asking the engine that no running container
uses that volume; makes any missing computer volume with its labels; and only
then starts the stack.

A step that fails stops the restore there, and the report says what that left:

- before anything was replaced, nothing was; it gives the command that starts
  the stack as it was. A load into an external database that failed is undone
  as a whole, so that database stays empty; the report ends with the error and
  says to run the same `restore --yes` again once the cause is fixed, without
  starting the stack on that database first, since its first start fills it;
- after something was replaced, the stack stays stopped, never started on a
  half-restored installation; run the same `restore --yes` again once the
  cause is fixed, and it starts over from the backup. With an external
  database whose dump was already loaded, the report says to run it with
  `--keep-database --replace-files` instead: that keeps the loaded database
  and puts back the rest;
- when only the final start fails, every part is back; fix the cause and start
  the stack with the command it gives, without restoring again.

A volume still in use when its turn comes stops the restore the same way, and
names what uses it. On this machine the restriction journal stays as it is,
since it is newer than any backup, and the service replays it at startup, so
nothing forgotten since the backup comes back. With an external database, the
restore loads into an empty one (it refuses one that holds tables, before it
stops anything and again as it loads) in one transaction, so a load that fails
leaves that database empty; or `--keep-database` leaves the database as it is.
Then, if the file volumes or the agents' computers' volumes here already hold
files, which may be newer than the backup's, it refuses unless
`--replace-files` is given too. With the bundled database, `--keep-database` is
refused: the files are put back as the backup's database
knows them, so that database comes back with them. An agent computer whose
container is still on the machine starts on its restored volumes when it is
next used; for one whose container is gone, see
[Replacing the VM](#replacing-the-vm). The computers come back as the backup
holds them, whatever the installation it was taken of was called: each is
made with `melete.install_project` set to this installation's Compose project,
so a restore onto a new machine under another `COMPOSE_PROJECT_NAME` keeps
every computer, and this installation's backups take them from then on.
`contents.json` names the installation the backup is of (`project`; in a
backup from before it did, the backup's unencrypted `melete.deploy.json` or
`deploy.env` names it), and a computer whose labels name another installation
is not that installation's to put back. A backup in which nothing names its
installation is judged by this installation's own labels, as a backup is.
Such a computer, and one whose volume name is taken here by a volume that is
not this installation's, is left out and the report says so; nothing of its
here is touched. One whose volumes are here but name another installation
(`restore.computers_named_elsewhere`, as after `COMPOSE_PROJECT_NAME`
changed on the same machine) is left out too, and the report says how to
make it this installation's. A backup made by `--with-volumes` before backups held their
list of parts restores its `data.tar` and `work.tar` the same way, without
their copy of the journal; each is checked first to hold the folders put back
from it. A backup counts as whole only when `SHA256SUMS` lists every file in it
and each matches. `backup.keep` never removes the backup the last deploy took,
which `rollback` restores from; `backup.max_age_days` does, once it is that old,
and says so.

The same backup by hand: back up `deploy/.env`, Postgres, the named volumes
containing knowledge, artifacts, workspaces, and restrictions, and the two
volumes of each of the agents' computers (`melete-sbx-<name>-work` and
`melete-sbx-<name>-home`: those whose `melete.install_project` is this
installation's Compose project, and those made before computers carried that
label whose `melete.project` is its `MELETE_SANDBOX_PROJECT`). Preserve
ownership and permissions. Stop Melete,
runtime work and the agents' computers before taking the database and volume
snapshot so their durable state is consistent; a stopped computer starts again
when it is next used. An installation started with an override names the same
files on each Compose command below, and one running the browser worker stops
`browser` with the others, since it writes into a space. From the repository
root:

```bash
backup_dir="$HOME/melete-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup_dir"
docker compose -f deploy/docker-compose.yml stop melete runtime web
project="$(sed -n 's/^MELETE_SANDBOX_PROJECT=//p' deploy/.env)"
name="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' deploy/.env)"
computers="label=com.melete.sandbox=v1"
labels='{{.Label "melete.install_project"}}|{{.Label "melete.project"}}'
# This installation's computers: labelled with its Compose project or, made
# before computers carried that label, with its sandbox project.
own() {
  awk -F'|' -v name="${name:-melete}" -v project="$project" \
    '$2 == name || ($2 == "" && project != "" && $3 == project) { print $1 }'
}
docker ps --filter "$computers" --format "{{.Names}}|$labels" | own | xargs -r docker stop
docker compose -f deploy/docker-compose.yml exec -T postgres sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "$backup_dir/database.dump"
cp -p deploy/.env "$backup_dir/deploy.env"
docker compose -f deploy/docker-compose.yml cp -a melete:/data - > "$backup_dir/data.tar"
docker compose -f deploy/docker-compose.yml cp -a melete:/work - > "$backup_dir/work.tar"
image="$(docker inspect --format '{{.Config.Image}}' \
  "$(docker compose -f deploy/docker-compose.yml ps --all --quiet melete)")"
for volume in $(docker volume ls --filter "$computers" --format "{{.Name}}|$labels" | own); do
  docker run --rm --network none --user 0:0 --entrypoint tar \
    --mount "type=volume,src=$volume,dst=/v,readonly" "$image" \
    -C /v --numeric-owner -cf - . > "$backup_dir/computer-$volume.tar"
done
chmod 600 "$backup_dir"/*
docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 180
```

The [Compose copy command](https://docs.docker.com/reference/cli/docker/compose/cp/)
uses archive mode to retain ownership, and the computers' archives keep each
file's numeric owner. The `/data` archive includes spaces, artifacts, and the
current restriction journal. Keep a current independent journal copy as
described below. `runtime-home` and each attempt's home are left out: they
keep no job's work, and jobs recover from Postgres into fresh attempts.

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

### Backups on a schedule

A backup that stays on the same disk goes when that disk goes. Run one every
day, encrypted, to another machine, and have something tell you when a day is
missed. `deploy/backup-schedule/` holds an example: `melete-backup.sh` takes
the backup with `--to` and `--encrypt-to`, then calls a check-in address you
choose; the systemd `melete-backup.timer` runs it every night, and runs a
missed night as soon as the machine is back. Any monitor that alerts you when
its pings stop arriving will do.

A finished backup calls the check-in address exactly as you gave it. A backup
that did not finish calls it as a failure:

- Most monitors (healthchecks.io and those like it) get `/fail` added to the
  address's path, before any query string: `https://hc-ping.com/abc?rid=1`
  becomes `https://hc-ping.com/abc/fail?rid=1`.
- An Uptime Kuma push address (one whose path holds `/api/push/`) signals
  failure with `status=down`, not `/fail`, so `status` and `msg` in its query
  are replaced: `https://kuma.example/api/push/T0k3n?status=up&msg=OK&ping=`
  becomes `https://kuma.example/api/push/T0k3n?ping=&status=down&msg=backup%20failed`.

```bash
age-keygen -o melete-backup.key   # on another machine; keep this file off the server
sudo cp deploy/backup-schedule/melete-backup.{service,timer} /etc/systemd/system/
sudoedit /etc/systemd/system/melete-backup.service   # the account, the paths, the destination, the public key, the check-in address
sudo systemctl daemon-reload && sudo systemctl enable --now melete-backup.timer
```

With cron instead, two lines in the installation account's crontab do the same.
Cron runs with a bare `PATH` that does not include `~/.bun/bin`, so the first
line names where `bun` is (the same `PATH` the systemd unit sets); without it
every night's backup fails with `bun: command not found`:

```cron
PATH=/home/melete/.bun/bin:/usr/local/bin:/usr/bin:/bin
30 3 * * * cd /home/melete/melete && MELETE_BACKUP_TO=ssh://backup-host:/srv/melete-backups MELETE_BACKUP_RECIPIENT=age1... MELETE_BACKUP_PING_URL=https://monitor.example/ping/your-check deploy/backup-schedule/melete-backup.sh
```

Then say that backups run on a schedule, in `deploy/melete.deploy.json`:

```json
"backup": { "dir": "~/melete-backups", "keep": 3, "scheduled": true }
```

`keep` (and `max_age_days`, 30 by default) hold on the backup host as well, so
the nightly backups over SSH there never grow past the newest three.

Every backup `melete backup` finishes, here or over SSH, is noted in
`deploy/.melete/last-backup.json`. With `"scheduled": true`, and always on a
hosted installation, `check` and `status` fail (`backup.age`) when the newest
backup is more than 26 hours old, or when there is none yet. They read only the
newest backup's time, so pruning old backups never changes the answer.
### Computers a backup leaves out

`backup` takes the agent computers it can tell are this installation's. The
volumes of one it cannot tell about are named in a warning, so none is left
out silently:

- `backup.computer_volumes_unattributed`: made before computers carried
  `melete.install_project`, under a `MELETE_SANDBOX_PROJECT` this installation
  no longer runs with. It may be this installation's, from before that setting
  changed, or another's on the same engine. One under the sandbox project that
  another installation's service runs with now belongs to that installation,
  whose own backup takes it, so it is not named.
- `backup.computer_volumes_other_installation`: its `melete.install_project`
  names a Compose project that has no Melete service container on this engine.
  It is this installation's from before its `COMPOSE_PROJECT_NAME` changed, or
  belongs to an installation that was removed or is down
  (`docker compose down`).

The volumes stay on the engine as they are, and `restore` does not put them
back. To keep a copy of one that is this installation's, stop its container
(`computer`, the volume name without `-work` or `-home`). Then archive both
volumes with their labels into a folder of their own, outside the backup (a
backup counts as whole only when `SHA256SUMS` lists every file in it), with
`image` and `name` set as in the commands above:

```bash
computer=melete-sbx-<name>
copy_dir="$HOME/melete-computers-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$copy_dir"
docker stop "$computer"
for volume in "$computer-work" "$computer-home"; do
  docker volume inspect --format \
    '{{range $key, $value := .Labels}}--label {{$key}}={{$value}} {{end}}' \
    "$volume" > "$copy_dir/$volume.labels"
  docker run --rm --network none --user 0:0 --entrypoint tar \
    --mount "type=volume,src=$volume,dst=/v,readonly" "$image" \
    -C /v --numeric-owner -cf - . > "$copy_dir/$volume.tar"
done
```

To make it this installation's, so that its backups take it from then on and a
restore puts it back, make both volumes again, named for this installation,
and unpack the archives into them before the agent next uses the computer. On
the engine that still has them, first remove the computer's container and both
volumes; the service makes the container again on the volumes the next time
the agent uses it:

```bash
docker rm -f "$computer"
docker volume rm "$computer-work" "$computer-home"
```

Then, on that engine or a new one:

```bash
for volume in "$computer-work" "$computer-home"; do
  docker volume create \
    $(sed 's/--label melete\.install_project=[^ ]* //' "$copy_dir/$volume.labels") \
    --label "melete.install_project=${name:-melete}" "$volume"
  docker run --rm -i --network none --user 0:0 --entrypoint tar \
    --mount "type=volume,src=$volume,dst=/v" "$image" \
    -C /v --numeric-owner -xpf - < "$copy_dir/$volume.tar"
done
```

### How long backups keep what was removed

Forgetting a memory or deleting a record removes it from the running
installation at once: from what it shows and searches, and from the space's
files and search index. (A file deleted in a conversation waits in the trash
for `MELETE_TRASH_DAYS` first.) Backups made before that still hold it. A
backup is removed only when a newer one is made, so what was removed stays in
this installation's backups until the last backup made before the removal is
older than `backup.max_age_days` (30 days by default) and another backup is
made. Taken on a schedule, for example daily from cron, that bounds it to about
30 days. When no new backup is made, older ones stay where they are; copies kept
elsewhere (`--to`, a copy of `backup.dir`, the provider's disk snapshots, an S3
bucket's old versions) are yours to expire on the same schedule; and the
directories `melete upgrade` leaves (`upgrade-<tag>-<time>`) are not removed by
this rule, so remove them once the release has run as it should.

An operator who offers Melete to other people should say this in their privacy
terms: what someone removes is gone from the service at once, and from its
backups within the period they are kept, 30 days unless you set another
`backup.max_age_days`. Restoring an older backup does not bring back a memory
forgotten after it was made, because the newest restriction journal is replayed
at startup; a record or file deleted after it was made does come back with it.

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
# With log shipping, first run
#   docker compose -p melete-logs --env-file deploy/.env -f deploy/docker-compose.log-shipping.yml down --volumes
# and also remove:
#   otel/opentelemetry-collector-contrib@sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1
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
