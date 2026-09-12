# Melete

**Melete carries a responsibility to completion on your own machine: it never
repeats an external effect it is unsure about, and it asks you exactly once
when only you can decide.**

It is an open-source, self-hosted personal assistant. You run it with Docker
Compose on a Linux host, connect the model provider and accounts you choose,
and it works through jobs you delegate: reading, drafting, scheduling, sending,
running code in a sealed cell, and remembering what you corrected.

**Status: v0.1, pre-release.** This README states what the code does and what
it does not claim. Every claim maps to a named test on the tree at the head of
`integration`; the evidence sections below say where. A useful assistant with a
real model is not claimed by any of it.

## What it is

Three principles decide every design choice.

1. **A thin harness around a thick boundary.** The engine is an unmodified,
   pinned release of [Hermes Agent](https://github.com/NousResearch/hermes-agent)
   (`v2026.9.7`), started fresh for every attempt inside a container that has no
   route out. Everything the model wants to do in the world goes through
   Melete's broker as a typed action: canonical payload, content hash, scope
   check, approval when the effect class needs one, budget reservation, and a
   receipt. A repair may change how an action is sent, never what it does.
2. **Responsibility is durable state, not a chat.** A job lives in Postgres as a
   bounded state machine with disposable attempts, leases, waits, approvals and
   receipts. An attempt can die at any point; the job recovers on the next wake
   without duplicating a completed effect, and an effect whose outcome is
   unknown stays visible as unknown until a connector verifies it or you settle
   it.
3. **Memory is evidence, and corrections win.** What Melete knows about you is
   versioned claims over exact source spans, with the Markdown tree in git as a
   view rather than the authority. A correction is immediate, protected, and
   invalidates precisely the outputs that depended on the old claim; forgetting
   survives a database restore because the removal journal is kept apart.

Melete is model-agnostic: the gateway meters and forwards to the provider you
configure, and the provider never sees your keys or your database.

## The six gates, and where v0.1 stands

| Gate | v0.1 status | Evidence |
| --- | --- | --- |
| Reliability | **Passes the tested scenarios.** | The eight [conformance scenarios](conformance/README.md) ran against the Compose stack on a Linux Docker host: 44 passed, 1 skipped (the second-provider comparison, which needs a credential). Scenarios 1–5 (durable wakes, lease fencing, unknown outcomes, approval binding, runtime death) also run anywhere with disposable Postgres. The [memory runner](conformance/memory/README.md) passed ten scenarios across seven families, and every withheld-memory arm failed as it must. The whole Bun suite on the landed tree passed on Windows at the landing checkpoint (1,544 passed, 29 skipped, 0 failed across 148 files, with `runtime/context.test.ts` run separately because its fourth case hangs on that host) and on Linux against a real Postgres (1,518 passed, 4 failed: two `python` versus `python3` portability cases in the execution-admission tests and an ICU date string in the greeting test, both assigned to a fix pass). |
| Operations | **Partial.** | Measured on a clean Linux Docker host: the install procedure below completed in about 65 seconds; restart under an active job and under a parked approval recovered with one receipt; a restore into an empty database volume kept the newer removal journal and produced exactly one destination effect; egress, sibling-service and owner-control-plane isolation were asserted from inside a claimed cell and the warm cell; the runtime image reproduces its pinned engine commit, plugin hash and SBOM. Not claimed: virtual-machine isolation, execution on Windows or macOS hosts, rootless Docker, and an upgrade procedure between releases. See the [threat model](docs/THREAT-MODEL.md) and [deployment operations](docs/DEPLOYMENT.md). |
| Capability | **Partial, with named gaps.** | Implemented and tested: tool discovery (`search_tools`, `load_tool`) with a token-budgeted core; brokered MCP servers over HTTP (stdio launch is refused until an isolated launcher exists); a browser worker outside the cell with recipes and person takeover; in-cell execution (`exec.run`, `exec.python`) with artifact validation; automatic skill selection bounded to three; correction → candidate → evaluation → promotion → rollback for one procedure family; membership revocation that fences delivered context. Implemented but unverified against the real engine: dynamic discovery inside a live run, lifecycle hooks. Missing: adding an MCP server after a session starts, MCP disconnect recovery, credential refresh for MCP connections, reuse of an evaluated skill by another member. The real-Hermes capability proof is pending. See the [capability matrix](docs/CAPABILITIES.md). |
| Output quality | **Not claimed.** | No real-model evaluation of answers ships. Every test uses a scripted provider. |
| Learning | **Scoped, not general.** | Episode → candidate → held-out evaluation gate → canary → activation, tested end to end with scripted providers for one family: ordering typed table records while preserving their shape. Nothing beyond that family is claimed. See [learning](docs/LEARNING.md). |
| Adoption | **Not measurable before release.** | |

## Demo

![The web app against the mock API: delegate, decide the permission, read the receipt, settle an unconfirmed effect](docs/media/approval-walk.gif)

One walk through `apps/web` against `apps/mock-api`: a request is delegated,
the agent's trail shows what it read, a permission card asks for one decision
(decided against the action's canonical payload hash, which the interface does
not display), the receipt lands with its undo window, and a second job whose
connector never answered rests as unknown until the person says what happened.
The correction-to-repair-brief path is a service property with named tests
(`the next attempt is handed the repair brief in its inputs`), not a screen.

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

All four services (`postgres`, `melete`, `runtime`, and `web`) must show healthy.
The wait timeout covers startup after the images build. If startup fails,
inspect `docker compose -f deploy/docker-compose.yml logs --tail=100` and resolve
the reported error before retrying. No image or volume pruning is needed.

### Keys and the first run

Open **http://localhost:3101** and create the owner account. The web server
proxies `/api` to Melete on the same browser origin; Postgres has no host port.
The API is also available on host loopback port 3100. The fake provider runs
the same scripted test action regardless of the message; it is a deployment
demonstration, not a general-purpose assistant.

To use a real model, edit `MELETE_DEFAULT_PROVIDER`, `MELETE_DEFAULT_MODEL` and
the matching key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
`FIREWORKS_API_KEY`, or `OPENAI_COMPAT_BASE_URL` with `OPENAI_COMPAT_API_KEY`) in
`deploy/.env`, set `MELETE_ENABLE_FAKE_PROVIDER=false`, and recreate the service:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

Provider keys stay in Melete's gateway; a runtime cell receives a per-attempt
capability and a surrogate credential, never the key. Connected accounts (mail,
calendar, MCP servers, the browser worker) are described in
[connectors](docs/CONNECTORS.md), [mail and calendars](docs/mail-calendar.md)
and [the browser worker](docs/browser-worker.md).

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

## Run the conformance suites

From the repository root, after `bun install --frozen-lockfile`:

```bash
bun run conformance
bun run conformance:memory
bun run lint
```

`bun run conformance` lists the eight scenarios and runs 1–5 on disposable
Postgres 17 with scripted runtimes; without the Compose opt-in it reports 6–8 as
deferred. `bun run conformance:memory` runs the ten memory scenarios, repeats
each one with recall withheld, and writes `conformance/memory/report.json`.
`bun run lint` is the style check: Biome over the whole tree, followed by
`bun run scrub:check`, which fails the build if a local path or working note
leaks into the repository.

To run all eight scenarios, use a fresh disposable installation **before
creating an owner account in the browser**. The runner creates its own account
and test data, kills test processes, and restarts the stack:

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
running services and runtime containers. Run the Compose scenarios sequentially
because they restart shared services; a skipped scenario is not a passing
deployment check.

## Verify from the repository root

Use Bun 1.3 or newer. These commands finish without a development server.
Database fixtures use disposable Postgres 17 when `DATABASE_URL` is unset;
otherwise they create disposable databases on the supplied server, requiring
database-creation permission. On a current Linux host the embedded Postgres
binary does not start, so set `DATABASE_URL` there. An unavailable embedded
binary produces a skip, which is not a pass. Tests use fake providers. Initial
dependency and binary downloads can require network access.

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
differences must be inspected. The Compose command checks YAML (19 checks), not
live networking. `bun run test:plugin` runs the Python plugin suite with `uv`.
The `test` script passes `--max-concurrency=2 --timeout=30000`, which gives each
test and fixture hook thirty seconds, not the whole suite; several minutes of
output is normal progress. The memory runner's procedure-transfer scenario is a
recorded todo: promotion is exercised by the learning tests instead.

## Local development with the pinned engine

Install the pinned engine and select the process supervisor; the service then
starts memory, the broker and one Hermes engine per attempt on this machine:

```bash
git clone --depth 1 --branch v2026.9.7 https://github.com/NousResearch/hermes-agent.git .hermes-src
uv venv .hermes-venv --python 3.12
# Windows: replace .hermes-venv/bin/python with .hermes-venv/Scripts/python.exe.
uv pip install --python .hermes-venv/bin/python -e ./.hermes-src aiohttp==3.14.3
export MELETE_RUNTIME_ADAPTER=hermes MELETE_RUNTIME_SUPERVISOR=process
export MELETE_SPACES_DIR="$PWD/spaces" MELETE_WORK_DIR="$PWD/work"
export MELETE_BROKER_BIND=127.0.0.1:3172 MELETE_BROKER_URL=http://127.0.0.1:3172 PORT=3170
# Configure DATABASE_URL, MELETE_CAPABILITY_KEY, MELETE_APPROVAL_KEY and a provider key.
bun run apps/melete/src/index.ts
```

The process supervisor is a development launcher with the current user's OS
access; container isolation is the Docker path above. The scripted HTTP proof
uses no provider key:

```bash
bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=1
```

`budget.max_output_tokens` remains the cumulative output ceiling (8,000 by
default). The optional `max_input_tokens` bounds each request's context
separately; when omitted it uses the pinned model context window minus the
output ceiling (120,000 for the 128,000-token fallback). The service refuses an
oversized assembled prompt with `input_context_exceeded` before launching
Hermes; the gateway checks the final request again before provider admission.

To work on the interface without a service, run the mock and the web app:

```bash
MOCK_PORT=3210 bun run dev:mock
bun run dev:web
```

Then open http://localhost:5180. [Building a client](docs/CLIENT.md) describes
the scenarios the mock plays and the rules the web app follows.

## What is out of scope for v0.1

- A hosted or multi-tenant service. Melete is one installation for one person,
  with additional accounts and shared spaces available as API primitives only
  (no invitation interface).
- Real-model answer quality, and learning beyond the one evaluated procedure
  family.
- Virtual-machine isolation, confidential compute, host-compromise containment,
  and any operating system other than a Linux Docker host for the sealed cell.
- Launching MCP servers over stdio from the service, interactive sign-in inside
  the browser worker, and provider OAuth stored inside the runtime.
- An exportable tamper-evident action ledger, an upgrade procedure between
  releases, and universal physical erasure of forgotten data (copies already
  delivered elsewhere, old backups, and git history are outside the removal
  journal).

## How to contribute

Read [CONTRIBUTING](CONTRIBUTING.md). Keep every public claim tied to a named
test, label what is not exercised, and record decisions with evidence under
`.agents/notes`. Report security issues through the
[security policy](SECURITY.md).

## Repository guide

| Path | Role |
| --- | --- |
| `apps/melete` | Service modules and database integration tests |
| `packages/contracts` | Schemas, state transitions and generated OpenAPI |
| `packages/client`, `apps/web`, `apps/mock-api` | Typed client, the web app built from the design canvas, and the scripted mock; see [CLIENT](docs/CLIENT.md) |
| `packages/runtime-hermes` | Pinned engine configuration, the Melete plugin and HTTP adapter, and the runtime image |
| `packages/knowledge`, `packages/skills`, `apps/melete/src/memory` | File-view utilities, skill files, and the authoritative memory service |
| `deploy` | `docker-compose.yml`, the browser override, `.env.example`, the configuration generator, and the checks that the sandbox is really a sandbox; verified on a Linux Docker host |
| `conformance` | Eight scenarios (6–8 need the Compose opt-in) and [eight memory scenario families](conformance/memory/README.md) |
| `docs` | [Architecture](docs/ARCHITECTURE.md), [capabilities](docs/CAPABILITIES.md), [memory](docs/MEMORY.md), [learning](docs/LEARNING.md), [engineering evidence](docs/ENGINEERING.md), [threat model](docs/THREAT-MODEL.md), [connectors](docs/CONNECTORS.md), [deployment](docs/DEPLOYMENT.md) |
| `.agents/notes` | Engineering decisions with their evidence; retained as history, not current release claims |
| `CHANGELOG.md` | What each version ships and what it does not claim |

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
