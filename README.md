# Melete

An open-source, self-hosted personal assistant in development.

**Status: pre-release. Durable service components work in scripted tests, and
the Linux Compose stack builds from source and runs the scripted provider; a
complete assistant with a real model is not claimed.** The test-mapped evidence
below was recorded at code baseline `9484023cabd32b786cb4d336dec818f441cd0cc1`;
the deployment evidence was recorded on a Linux Docker host on 2026-09-11 and
2026-09-12 (see [the threat model](docs/THREAT-MODEL.md)).

Melete represents a responsibility as a Postgres job with disposable attempts,
waits, approvals and action receipts. The first five [conformance
scenarios](conformance/README.md) test recovery, fencing, unknown outcomes,
approval binding and runtime death with isolated Postgres and scripted runtimes.
Scenarios 6 to 8 run against the Compose stack when the opt-in below is set.
None of them runs a real model.

## v0.1 release gates

| Gate | Honest status and evidence |
| --- | --- |
| Reliability | Passes the tested scenarios: durable wakes; stale-attempt fencing; unknown sends without redispatch; payload/revision-bound approvals; runtime death recovery. See scenarios 1–5 and their named assertions in [conformance](conformance/README.md). This is fixture evidence, not a deployed-system guarantee. |
| Operations | Partial: database migrations and health (`answers a ping on the migrated Postgres instance`); persisted sessions (`a second service instance recognizes the persisted session`); queue recovery (scenario 1); event replay (`replays across a terminated LISTEN connection and cleans it up on shutdown`); memory restore gating (`deletion hides synchronously, cleanup failures retry, and startup refuses a missing journal`); static Compose checks. Container egress probes ran from a claimed cell and the warm cell on a Linux Docker host (scenario 6, 2026-09-12); a clean-host install was measured at 64.93 seconds; the Postgres restore proof passed with one destination effect. Upgrades are **not claimed**. |
| Capability | **Not claimed**: scripted fixtures do not establish useful autonomous task performance. |
| Output quality | **Not claimed**: no real-model answer-quality evaluation is established here. |
| Learning | **Not claimed**: procedure transfer is **written, not run** (`procedure-transfer` todo); memory correction tests are not learning evidence. |
| Adoption | **Not measurable before release**. |

## What the code does

- Additional accounts, shared spaces and membership revocation exist as API
  primitives (`/principals`, `/spaces/shared`, `/spaces/{id}/memberships`);
  revocation invalidates delivered context and fences running work. There is no
  invitation UI. The [capability matrix](docs/CAPABILITIES.md) lists their
  tests and what remains unproven.
- The broker records canonical effects and checks authority before dispatch.
  Unknown sends remain visible and are not blindly repeated (conformance 3,
  `the action is never dispatched a second time, including after broker restart`).
- The service has authenticated job, approval, scheduling, attention, event and
  reaction APIs. With `MELETE_RUNTIME_ADAPTER=docker` the service supervises one
  Hermes container per attempt itself; otherwise startup requires a supplied
  runtime or the explicit scripted stub when Postgres is configured. See
  [architecture](docs/ARCHITECTURE.md) for the wiring and named tests.
- Memory authority is Postgres evidence and versioned claims. Markdown in git
  is a derived inspection/edit surface; a raw file edit alone is not an
  authoritative correction (`Markdown round trips support, preserves local
  edits, and owner edits become protected revisions`). Memory startup and its
  routes are wired when the Docker runtime is selected and stay optional
  otherwise; see [memory](docs/MEMORY.md).
- The broker catalog is filtered by scopes and served as a token-budgeted core
  (750 estimated tokens) plus `search_tools` and `load_tool`; a universal
  15-tool limit is **not claimed**. The contract constant is not an enforced
  catalog cap.
- The pinned Hermes adapter and model gateway have fixture tests. Compatibility
  with every provider and real-model policy equivalence are **not claimed**;
  conformance 8 is **written, not run**.
- Compose hardening is declared, statically checked, and was probed live on a
  Linux Docker host: from inside a claimed cell and the warm cell, the internet,
  the host metadata address, Postgres, the web service and the owner control
  plane were unreachable, and the broker with its model gateway was the only
  peer. See the [threat model](docs/THREAT-MODEL.md).

## Install on a Linux Docker host

Use Docker Engine **28 or newer**, Docker Compose **2.33.1 or newer** supporting
`volume.subpath` and `gw_priority`, and the local rootful Docker socket at `/var/run/docker.sock`.
Engine 28 introduced the [isolated bridge gateway mode](https://docs.docker.com/engine/release-notes/28/)
used to remove host-network reachability. If Docker is not installed, follow
the [Docker Engine installation instructions](https://docs.docker.com/engine/install/)
for your distribution, including the Buildx and Compose plugins.

Run the following in Bash on the Docker host, from an account that can access
that socket; a root shell works. Have Git, curl, and unzip installed. On a
minimal Debian or Ubuntu host, install them with
`apt-get update && apt-get install -y git curl unzip ca-certificates` as root.
On a minimal Alpine host, run
`apk add --no-cache bash git curl unzip ca-certificates libstdc++ libgcc` as root;
the Bun binary needs the C++ runtime libraries there.

```bash
df -h /
docker version
docker compose version
docker info --format '{{.DockerRootDir}}'
```

Start with at least **10 GB free** on the filesystem holding Docker's data;
20 GB gives room for rebuilds. Do not start below 8 GB. Image pulls and the first
build require outbound network access. Ports 3100 and 3101 must be free.

Install Bun, clone the repository, and generate the local configuration:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
git clone https://github.com/ychampion/melete.git
cd melete
git switch integration
bun install --frozen-lockfile
bun run deploy/scripts/configure.ts --fake
chmod 600 deploy/.env
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 180
docker compose -f deploy/docker-compose.yml ps
```

Record `git rev-parse HEAD` with your install timing.
Bun 1.3.13 was used for the initial deployment checks; the clean-host install
also passed with Bun 1.4.2 from the installer above.

If the repository requires authentication, transfer source without copying a
credential to the new host. From an existing checkout, create a bundle for the
branch you are installing:

```bash
git bundle create /tmp/melete-source.bundle integration
```

Transfer that file to the new host. In the install block, replace the GitHub
clone command with `git clone /path/to/melete-source.bundle melete`. A bundle contains committed source
and history; local configuration and untracked files are excluded.

`configure.ts --fake` creates `deploy/.env` from `deploy/.env.example`, generates
independent local secrets, records the Docker socket group, and explicitly
enables the scripted provider and test connector. It refuses to replace an
existing `.env`. Compose reads `deploy/.env`; a file beside this README is not
the deployment configuration. Keep the generated file private and retain it
with your backups.

All four services—`postgres`, `melete`, `runtime`, and `web`—must show healthy.
The wait timeout covers startup after the images build. If startup fails,
inspect `docker compose -f deploy/docker-compose.yml logs --tail=100` and resolve
the reported error before retrying. No image or volume pruning is needed.

Open **http://localhost:3101** and create the owner account. The web server
proxies `/api` to Melete on the same browser origin; Postgres has no host port.
The API is also available on host loopback port 3100. The fake provider runs
the same scripted test action regardless of the message; it is a deployment
demonstration, not a general-purpose assistant.

On a remote Linux host, open a tunnel from your own computer:

```bash
ssh -N -L 3101:127.0.0.1:3101 user@your-linux-host
```

Then use **http://localhost:3101** on that computer. Session cookies retain
`Secure`, `HttpOnly`, and `SameSite=Lax`; browsers allow secure cookies on
localhost. For a public hostname, serve HTTPS through a reverse proxy and set
`MELETE_WEB_ORIGIN=https://your-hostname` in `deploy/.env`, then recreate the web
service. See [deployment operations](docs/DEPLOYMENT.md) for TLS, provider
configuration, image provenance, and backup restoration.

To run conformance, use a fresh disposable installation **before creating an
owner account in the browser**. The runner creates its own account and test
data, kills test processes, and restarts the stack. From the repository root:

```bash
MELETE_CONFORMANCE_COMPOSE=1 bun -e '
import { databaseUrl } from "./conformance/helpers/compose.ts";
const env = { ...process.env, DATABASE_URL: await databaseUrl() };
for (const script of ["conformance", "conformance:memory"]) {
  const run = Bun.spawn([process.execPath, "run", script], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await run.exited;
  if (code !== 0) process.exit(code);
}
'
```

This passes the database connection privately to the runners. Scenarios 1–5
use disposable databases on the Compose Postgres server; scenarios 6–8 use the
running services and runtime containers. The memory suite exercises its
service harness in disposable databases on that same server and writes
`conformance/memory/report.json`. It is separate evidence from the deployed
HTTP flow. Run the Compose scenarios sequentially because they restart shared
services; a skipped scenario is not a passing deployment check.

## Verify from the repository root

Use Bun 1.3 or newer. These commands finish without a development server.
Database fixtures use disposable Postgres 17 when `DATABASE_URL` is unset;
otherwise they create disposable databases on the supplied server, requiring
database-creation permission. An unavailable embedded binary produces a skip,
which is not a pass. Tests use fake providers. Initial dependency/binary downloads
can require network access.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run openapi
bun run client:generate
bun run compose:check
bun run conformance
bun run conformance:memory
bun run test:plugin
```

The generators update the OpenAPI document and client declarations; generated
differences must be inspected. The Compose command checks YAML, not live
networking. `bun run conformance` runs scenarios 1–5 and reports 6–8 as todo
unless the Compose opt-in above is set, in which case all eight run against the
stack. `bun run test:plugin` runs the Python plugin suite. The full suite took
454.72 seconds, about seven and a half minutes, on the measured host; the `test`
script passes `--max-concurrency=2 --timeout=30000`, which gives each test and
fixture hook thirty seconds, not the whole suite. Several minutes of test output
can therefore be normal progress. The shorter default produced fixture-hook
timeouts in a run that took 628.07 seconds. The memory runner executes ten
scenarios across seven families plus ten withheld-memory runs; procedure
transfer is **written, not run**.

## Repository guide

| Path | Role |
| --- | --- |
| `apps/melete` | Service modules and database integration tests |
| `packages/contracts` | Schemas, state transitions and generated OpenAPI |
| `packages/client`, `apps/web`, `apps/mock-api` | Typed client, reference UI and scripted mock; see [CLIENT](docs/CLIENT.md) |
| `packages/runtime-hermes` | Pinned engine configuration, the Melete plugin and HTTP adapter, and the runtime image |
| `packages/knowledge`, `apps/melete/src/memory` | File-view utilities and authoritative memory service |
| `deploy` | `docker-compose.yml`, `.env.example`, the configuration generator, and the check that the sandbox is really a sandbox; verified on a Linux Docker host |
| `conformance` | Eight scenarios (6–8 need the Compose opt-in) and [eight memory scenario families](conformance/memory/README.md) |
| `docs` | [Architecture](docs/ARCHITECTURE.md), [memory](docs/MEMORY.md), [engineering evidence](docs/ENGINEERING.md), [threat model](docs/THREAT-MODEL.md), [connectors](docs/CONNECTORS.md) |
| `.agents/notes` | Historical engineering decisions; retained as history, not current release claims |

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
