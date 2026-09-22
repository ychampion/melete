# Melete

**Say it once. It gets done.**

## Deals with every company in your life, so you don't

Connect your inbox and Melete maps every company in your life: what you pay,
what you're owed, what renews next. Then it handles them. It chases refunds,
disputes charges, cancels subscriptions and gets quotes, over days, asking you
once. Open source.

**Maps.** Point Melete at a mailbox and it draws the picture: what each company
takes from you every month, what it owes you back, what renews next, whose price
has gone up, whose trial ends this week, who is holding your data. Every figure
opens the sentence in the email it came from. No evidence, no entry.

**Handles.** Pick one thing, or hand it the lot. Melete writes to the company
from your own address, in your words, quoting the company's own policy back to
it.

**Keeps going.** It waits for the reply, follows up, escalates when a date
passes, and stops when the matter is settled. It asks you once per company,
before the first message goes out, and it never sends the same message twice.

### What it takes on

- **A refund you were promised.** The shop said six weeks ago that the money was
  coming back. Melete quotes the promise to them and asks for a date.
- **A charge that is wrong.** One order, billed twice. Melete puts both lines
  side by side and asks for one of them back.
- **A subscription you are done with.** It renews on the 4th. Melete cancels it
  in writing before it charges, and keeps the confirmation.
- **A price rise at renewal.** Your broadband goes up next cycle. Melete asks
  for the old price, or for the terms to leave.
- **Quotes, and the haggling after them.** Three firms for one repair. Melete
  writes to all three, chases the slow one, and lays the answers out together.
- **An invoice nobody has paid.** Thirty days late. Melete follows up on your
  terms and escalates on the date you set.

<!-- DEMO SLOT: put the launch video or GIF here, directly below this comment.
     It should show one mailbox becoming a map, one item picked, the message
     going out after a single yes, and the reply landing days later. Until the
     asset exists, this comment is the placeholder. -->

## Try it on one email

<!-- TRYIT_URL — BEFORE PUBLISHING, replace the link with the live try-it
     address and delete this comment. bun run release:check fails while the
     link is a placeholder. -->
**[Try it on one email](TRYIT_URL)**

Paste any message from a company, or just describe the problem. You get back
what you are entitled to and why, the sentence in the message that proves it,
how likely it is and how long it usually takes, the message to send, and what to
do on each date if they say no. No account, no inbox, nothing to install.

## Run it yourself

Melete is yours to run: your machine, your mailbox, your model provider, your
keys. Everything below is the whole install. On a Windows machine with Docker
Desktop, follow [Windows (Docker Desktop)](docs/DEPLOYMENT.md#windows-docker-desktop)
for the install, then carry on from [first run](#first-run).

### Install on a Linux Docker host

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

Install Bun, clone the repository, and generate the local configuration:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
git clone https://github.com/ychampion/melete.git
cd melete
bun install --frozen-lockfile
bun run deploy/scripts/configure.ts --fake
bun run compose:check
docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 180
docker compose -f deploy/docker-compose.yml ps
```

`configure.ts --fake` writes `deploy/.env` from `deploy/.env.example` with
private permissions, generates independent local secrets, records the Docker
socket group, and turns on the scripted provider and test connector; it refuses
to replace an existing `.env`. Compose reads `deploy/.env`; keep it with your
backups.

All four services — `postgres`, `melete`, `runtime` and `web` — come up healthy.
If startup fails, `docker compose -f deploy/docker-compose.yml logs --tail=100`
names the reason.

### First run

Open **http://localhost:3101** and create the owner account. The web server
proxies `/api` to Melete on the same browser origin; Postgres has no host port.
The API is also available on host loopback port 3100.

The `--fake` configuration starts in walkthrough mode: a scripted provider plays
the same job every time, so you can watch a delegation become a brokered action
and a receipt before you connect a model of your own.

To use a real model, set `MELETE_DEFAULT_PROVIDER`, `MELETE_DEFAULT_MODEL` and
the matching key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
`FIREWORKS_API_KEY`, or `OPENAI_COMPAT_BASE_URL` with `OPENAI_COMPAT_API_KEY`)
in `deploy/.env`, set `MELETE_ENABLE_FAKE_PROVIDER=false`, and recreate the two
services:

```bash
docker compose -f deploy/docker-compose.yml up -d --force-recreate --wait melete runtime
```

Connected accounts — mail, calendars, MCP servers, the browser worker — are
described in [connectors](docs/CONNECTORS.md),
[mail and calendars](docs/mail-calendar.md) and
[the browser worker](docs/browser-worker.md). Mail and calendars connect with an
account name and a password or app password, so a provider that accepts only
OAuth sign-in cannot be connected.

On a remote Linux host, tunnel from your own computer and use the same address
there:

```bash
ssh -N -L 3101:127.0.0.1:3101 user@your-linux-host
```

For a public hostname, serve HTTPS through a reverse proxy, since session
cookies are `Secure`; set `MELETE_WEB_ORIGIN=https://your-hostname` in
`deploy/.env` and recreate the web service. [Deployment](docs/DEPLOYMENT.md) covers TLS, provider
configuration, image provenance and backup restoration.

An optional override reaches the installation from your phone and your laptop
over your own tailnet, with HTTPS and no published port. See
[Tailscale](docs/DEPLOYMENT.md#tailscale).

### Remove it completely

Everything Melete keeps lives in Docker volumes and one configuration file, so
taking it off the machine is one command, a sweep and one deletion. Give the
first command the same `-f` files you started the stack with, so it reaches the
browser worker and the Tailscale node when you use them. It stops the stack and
removes its containers and named volumes: the database, your spaces, artifacts,
the work directory, the removal journal and, with the Tailscale file, the node
key. The sweep catches the per-attempt containers, networks and volumes the
service creates while it runs: those carry Melete's own labels rather than
Compose's, so they are matched by label and by the Compose project name, which
the sweep reads from `deploy/.env`. Delete `deploy/.env` last, because it holds
the master key that unseals anything you backed up.

```bash
docker compose -f deploy/docker-compose.yml down -v --rmi local --remove-orphans
# Started it with the browser worker or Tailscale? Add the same -f files to that line.
owned=label=com.melete.attempt-supervisor=v1
name=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' deploy/.env)
project=label=com.melete.project=${name:-melete}
docker ps -aq --filter "$owned" --filter "$project" | xargs -r docker rm -f
docker network ls -q --filter "$owned" --filter "$project" | xargs -r docker network rm
docker volume ls -q --filter "$owned" --filter "$project" | xargs -r docker volume rm
rm -f deploy/.env
```

What is left afterwards is the source directory you cloned and the images:
`melete-service:local`, `melete-runtime:local` and `melete-web:local`, which
Docker built, and `postgres:17-alpine`, plus `tailscale/tailscale` with
Tailscale, which it pulled. Every installation on a host shares these images,
so remove them only when this was the last one:

```bash
docker image rm melete-service:local melete-runtime:local melete-web:local \
  postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
# With Tailscale, also remove:
#   tailscale/tailscale@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680
```

## Everything else it does

Companies are one thing Melete takes off you. It is a personal assistant you run
yourself: you hand it the work, it reads what it needs, does the steps, and comes
back to you for the one decision only you can make. Everything it does in the
world leaves a record you can read, and undo.

![Delegate the work, decide the one permission it asks for, read the receipt, settle an effect whose confirmation never arrived](docs/media/approval-walk.gif)

*Delegate, decide once, read the receipt, and settle the job whose confirmation
never arrived.*

**An action happens once, and leaves a receipt.** Every effect — a message sent,
an event created, a file written — becomes a canonical payload with a content
hash before it leaves, and one logical effect keeps one identity across retries,
restarts and replacement attempts. What landed is written down: what, where,
when, and an undo handle you can spend while it is still valid.

**One permission question, bound to exactly what is being sent.** An approval is
attached to the hash of the thing it approves, so changing a recipient, an
amount or a revision afterwards gets the action refused at the door rather than
sent under your old yes. Cancel while dispatch is in flight and the cancellation
is honoured.

**An unknown outcome stays unknown until it is settled.** When a send is
accepted but the acknowledgement is lost, Melete shows it as unresolved, asks
the connector to verify it, and lets you settle it yourself. It is never quietly
sent again to make the uncertainty go away.

**Corrections win, and redo what depended on them.** A correction takes effect
immediately and is protected from being overwritten by a later import. It marks
stale precisely the outputs that cited the old claim, and the next attempt is
handed a brief saying what to repair.

**Forgetting survives a restore.** What you ask Melete to forget goes into a
removal journal kept apart from the database, and the journal is replayed over
restored data. Restore last week's backup and the forgotten fact stays forgotten.

**It has hands, and they wait for you.** Melete drives its own sandboxed
Chromium for the things that only exist behind a form, and you can watch it and
take over mid-task; the approval binds the exact browser intent, so an
unapproved submit reaches nothing outside the browser. It runs code in the
sandbox too, and the command, exit code, duration, output digest and any kill
land on the record like every other effect.

**Your keys never reach the sandbox, and the sandbox has no route out.** You
bring your own model and your own accounts; the provider key stays in the Melete
service, which meters every request, and each attempt gets a short-lived
capability and a surrogate credential instead. The container the model runs in
has one reachable peer, the broker: no internet, no host metadata address, no
database, no web service, no owner control plane.

## Develop and verify

Use Bun 1.3 or newer. From the repository root:

```bash
bun install --frozen-lockfile
bun run doctor
bun run typecheck
bun run lint
bun run test
bun run openapi
bun run client:generate
bun run compose:check
bun run browser:compose:check
bun run tailscale:compose:check
bun run conformance
bun run conformance:memory
bun run test:plugin
```

`bun run doctor` names each missing prerequisite. Database fixtures use
disposable Postgres 17: embedded when `DATABASE_URL` is unset, otherwise
disposable databases created on the server you supply, which needs
database-creation permission. On current Linux distributions, set
`DATABASE_URL`. On Windows, clone to a short path such as `C:\m`: the embedded
server's own files sit about 145 characters below the clone, and once a path
passes Windows' 260-character limit its `initdb` says `pg_ident.conf.sample` is
missing when the file is there. Tests use scripted providers. `bun run lint` is
Biome over the whole tree followed by `bun run scrub:check`, which refuses local
paths and internal work codes in tracked files. The generators rewrite the
OpenAPI document and the client declarations; inspect the diff. Install Chromium
with `bunx playwright install chromium` for the browser fixtures, and run the
suites sequentially on small machines. `budget.max_output_tokens` is a job's
cumulative output ceiling (8,000 by default); the optional `max_input_tokens`
bounds each request's context and, when omitted, uses the model context window
minus that ceiling.

To work on the interface without the service, run the mock and the web app:

```bash
MOCK_PORT=3210 bun run dev:mock
bun run dev:web
```

Then open http://localhost:5180. [Building a client](docs/CLIENT.md) describes
the scenarios the mock plays and the rules the web app follows.

### Run the agent runtime locally

Install the agent runtime and select the process supervisor; the service then
starts memory, the broker and one engine per attempt on this machine:

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
access; the sandbox is the Docker path above. The scripted HTTP proof needs no
provider key:

```bash
bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=1
```

[CONTRIBUTING](CONTRIBUTING.md) has the contribution rules.
[Service conformance](conformance/README.md) and
[memory conformance](conformance/memory/README.md) describe what each scenario
checks and how to run the deployment scenarios against a Compose stack.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — processes, boundaries and durable state
- [Memory](docs/MEMORY.md) — claims, revisions, corrections and removal
- [Learning](docs/LEARNING.md) — how a correction becomes an evaluated procedure
- [Capabilities](docs/CAPABILITIES.md) — what the runtime can do, with its tests
- [Connectors](docs/CONNECTORS.md) — the connector contract and effect classes
- [Mail and calendars](docs/mail-calendar.md) — accounts, sending and scheduling
- [Browser worker](docs/browser-worker.md) — the sandboxed browser, recipes and takeover
- [Deployment](docs/DEPLOYMENT.md) — TLS, provider configuration, provenance and backups
- [Upgrading](docs/UPGRADING.md) — moving a running installation to a later release
- [Threat model](docs/THREAT-MODEL.md) — the boundary and what rests on it
- [Building a client](docs/CLIENT.md) — the API surface and the rules a client follows
- [Evaluation](docs/EVALS.md) — how answer quality is measured

## Repository guide

| Path | Role |
| --- | --- |
| `apps/melete` | The service: jobs, broker, memory, connectors and model metering |
| `packages/contracts` | Schemas, state transitions and the generated OpenAPI document |
| `packages/client`, `apps/web`, `apps/mock-api` | Typed client, the web app built from the design canvas, and the scripted mock |
| `apps/tryit` | The try-it page above: one email in, one case file out, no account behind it |
| `packages/runtime-hermes` | Runtime configuration, the Melete plugin, the HTTP adapter and the runtime image |
| `packages/knowledge`, `packages/skills`, `apps/melete/src/memory` | File-view utilities, skill files and the authoritative memory service |
| `deploy` | `docker-compose.yml`, the browser override, `.env.example`, the configuration generator, and the checks that the sandbox is really a sandbox |
| `conformance` | Service scenarios and [memory scenario families](conformance/memory/README.md) |
| `docs` | The documentation above |
| `.agents/notes` | Engineering decisions and the evidence behind them |
| `CHANGELOG.md` | What each version ships |

## Contributing, security and licence

Read [CONTRIBUTING](CONTRIBUTING.md) before opening a pull request, and report
security issues through the [security policy](SECURITY.md). Melete is
Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Melete's agent runtime is built on
[Hermes Agent](https://github.com/NousResearch/hermes-agent), customised for
Melete.
