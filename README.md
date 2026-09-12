# Melete

An open-source, self-hosted, model-agnostic personal assistant.

**Give Melete a responsibility, close the tab, come back to progress, a result,
or one precise question.**

> **Status: pre-release. The Linux Compose stack builds from source.**
> The installation below uses a deterministic local provider to exercise jobs,
> approvals, and receipts without a model key. That check does not establish
> real-provider behavior. See the [deployment report](REPORT.md) for measured
> results and remaining limitations.

## What it is

Most assistants are a chat window: you stay, you watch, you steer. Melete is
built around the opposite shape. You hand over something that takes time, and it
keeps working after you have gone.

That only makes sense if three things are true, and they are what the code is
about:

1. **A responsibility outlives any process.** Jobs, waits, approvals, actions,
   and receipts live in Postgres. A runtime attempt is disposable. Your client
   can close, the runtime can die, the machine can reboot; the job remains.
2. **Effects have identity.** Every external action is a record before it is a
   request. An approval binds to the exact bytes you were shown. A retry reuses
   the same action. An outcome nobody can confirm stays `unknown`, and is never
   quietly re-sent.
3. **Every boundary is described exactly as strong as it is.** v0.1 isolation is
   a container on a network with no route out. That is not a virtual machine,
   and [the threat model](docs/THREAT-MODEL.md) says so in those words.

The last point is why there is a [conformance suite](conformance/), and a
[memory conformance runner](conformance/memory/README.md) beside it. Anyone can
run them and check the claims rather than believe them.

## The shape of it

```
you  ->  job  ->  attempt  ->  proposed action  ->  approval  ->  receipt
          |                          |
          |                          the broker: canonicalise, classify,
          |                          admit or refuse, dispatch once, verify
          |
          durable in Postgres, with a bounded state machine
```

The model plans and writes. Melete enforces. The model sees short things: an
identity under 250 tokens, at most three skills, bounded retrieved knowledge, a
catalog of at most 15 tools. Everything it does passes through a typed, durable,
auditable gate that behaves the same whether the model cooperated or not.

Memory claims, revisions, and restrictions live in Postgres. Knowledge records
also have a Markdown surface with provenance frontmatter, one Git repository
per space, which you can read, edit, and diff with the tools you already have.

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

For an unmerged deployment PR, use that PR's branch instead of `integration`
in the `git switch` command. Record `git rev-parse HEAD` with your install timing.
Bun 1.3.13 was used for the initial deployment checks; the clean-host install
also passed with Bun 1.4.2 from the installer above.

If the repository requires authentication, transfer source without copying a
credential to the new host. From an existing checkout, create a bundle for the
branch you are installing:

```bash
git bundle create /tmp/melete-source.bundle lane/w6-deploy
```

Transfer that file to the new host. In the install block, replace the GitHub
clone command with `git clone /path/to/melete-source.bundle melete`, and select
`lane/w6-deploy` in the `git switch` command. A bundle contains committed source
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

## In scope for v0.1

- Single-owner self-hosting with Docker Compose on Linux. Docker Desktop on
  macOS and Windows is outside the Linux verification reported here.
- Durable jobs with waits, schedules, approvals, and recovery after a restart.
- A thin runtime in a sandboxed container with no route to the internet. Tool
  calls only through the broker.
- A broker with an action ledger, approvals bound to payload hashes, budgets,
  receipts, reconciliation, and a key-injecting model gateway.
- Connectors: workspace files, public web fetch in its own compartment, email
  over IMAP and SMTP with an app password, calendar over ICS import and CalDAV,
  and a test destination the conformance suite uses.
- Knowledge as Markdown with provenance, a git repository per space, full-text
  retrieval, and browse, edit, and delete from the client.
- Short Markdown skills with triggers, built in and user-added.
- A configurable model gateway for Fireworks, Anthropic, OpenAI, Google, and
  OpenAI-compatible endpoints. Deployment conformance uses the explicit fake
  provider. Real providers require their own credentials and verification;
  the requested and actually served models are recorded per attempt.
- A conformance suite you can run with one command.

## Out of scope for v0.1

- **Multi-user accounts, shared spaces, invitations.** The schema carries
  `space.audience` so this can come later; the client shows one owner.
- **Google and Microsoft OAuth.** Restricted scopes need weeks of verification.
  IMAP, SMTP, and CalDAV instead.
- **Virtual-machine isolation.** A Firecracker microVM is the target and gVisor
  is the documented step in between. Neither is in v0.1.
- **A desktop app, a mobile app, a plugin marketplace, autonomous purchases.**

## Repository

| Path | What is in it |
|---|---|
| `packages/contracts` | Zod schemas, types, the job state machine, the broker protocol, the OpenAPI document |
| `packages/knowledge` | Record parsing, space layout, the SQLite full-text index, write mediation |
| `packages/runtime-hermes` | The pinned runtime image, its Melete plugin, and a typed run client |
| `packages/client` | The typed HTTP client: generated types, a thin fetch wrapper, a resumable event stream |
| `apps/melete` | The service: API, jobs, broker, gateway, connectors, knowledge, events |
| `apps/mock-api` | Every operation in `openapi.json`, in memory, driven by scripted scenarios |
| `apps/web` | A small reference client, to show the API is enough to build one |
| `deploy` | `docker-compose.yml`, `.env.example`, and the check that the sandbox is really a sandbox |
| `conformance` | Eight scenarios that prove the durability and boundary claims, and [eight memory scenario families](conformance/memory/README.md) that prove the memory ones |
| `docs` | [Architecture](docs/ARCHITECTURE.md), [deployment](docs/DEPLOYMENT.md), [memory](docs/MEMORY.md), [what the service proves](docs/ENGINEERING.md), [threat model](docs/THREAT-MODEL.md), [connectors](docs/CONNECTORS.md), [building a client](docs/CLIENT.md) |
| `.agents/notes` | Why things are the way they are, one decision per file |

## Working on it

Requires [bun](https://bun.sh) 1.3 or newer.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run openapi          # regenerate packages/contracts/openapi.json
bun run client:generate  # regenerate the client's types from openapi.json
bun run compose:check    # validate the Compose boundary configuration
bun run conformance        # run scenarios; Compose checks need the opt-in above
bun run conformance:memory # run the eight memory families, counterfactual arm included
```

Database tests create disposable fixtures. Without `DATABASE_URL`, they start
embedded Postgres, which must run as a non-root user. The Compose conformance
command above supplies the existing Docker Postgres server instead.

For client-only development, the mock API provides scripted data:

```bash
bun run dev:mock   # the whole API in memory on :3190, with scripted jobs
bun run dev:web    # the reference client on :5173, pointed at the mock
```

Delegate something, watch the job stop for approval, approve it, and see the
receipt. [docs/CLIENT.md](docs/CLIENT.md) is what a second client needs to know
before it starts.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Melete is named for the muse of practice, on the theory that an assistant earns
its place by doing the same unglamorous thing reliably.
