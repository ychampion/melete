# Melete

An open-source, self-hosted, model-agnostic personal assistant.

**Give Melete a responsibility, close the tab, come back to progress, a result,
or one precise question.**

> **Status: pre-release. Nothing works yet.**
> This repository currently contains the contracts, the schema, the deployment
> shape, and the conformance scenarios. There is no working assistant here to
> install. Watch the repository if you want to know when there is.

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

Memory is files. Knowledge records are Markdown with provenance frontmatter, one
git repository per space, which you can read, edit, diff, and delete with the
tools you already have.

## In scope for v0.1

- Single-owner self-hosting with `docker compose up`, on Linux. macOS and Windows
  through Docker Desktop, documented as a trial.
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
- Model-agnostic providers. DeepSeek V4.1 Flash on Fireworks is the recommended
  and tested default; Anthropic, OpenAI, Google, and any OpenAI-compatible
  endpoint, including a local model, also work. The provider and the model
  actually served are recorded per attempt.
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
| `docs` | [Architecture](docs/ARCHITECTURE.md), [memory](docs/MEMORY.md), [what the service proves](docs/ENGINEERING.md), [threat model](docs/THREAT-MODEL.md), [connectors](docs/CONNECTORS.md), [building a client](docs/CLIENT.md) |
| `.agents/notes` | Why things are the way they are, one decision per file |

## Working on it

Requires [bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run openapi          # regenerate packages/contracts/openapi.json
bun run client:generate  # regenerate the client's types from openapi.json
bun run compose:check    # check the declared runtime boundary without Docker
bun run conformance        # list the eight scenarios and what each will assert
bun run conformance:memory # run the eight memory families, counterfactual arm included
```

The service starts Postgres migrations, pg-boss workers, memory and the broker.
An HTTP job reserves an attempt, selects up to three skills from its space,
recalls knowledge with versioned handles, and records the context. The service
then asks a supervisor to start one pinned Hermes engine for that attempt.
Hermes reaches tools and models through the broker; the service removes the
engine when the attempt finishes. A correction fences old context and queues a
replacement with a delta and a repair brief.

On a Docker host, fill in `deploy/.env.example` as `deploy/.env`, set `DOCKER_GID`
to the group owning the local Docker socket, then run `docker compose up --build`
from `deploy`. Docker 27 or later is required for per-job volume subpaths. The
Compose builds the runtime image and the service launches attempts; the `runtime-dev` profile adds
only an idle inspection container. This wiring has static checks here; image
builds and the container network boundary still need verification on a Docker
host. See [the wiring note](.agents/notes/0022-wired-assistant.md).

For local development, install the pinned engine and select the process supervisor:

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
access. Container isolation requires the Docker supervisor. The scripted HTTP
proof uses no provider key:

```bash
bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=2
```

The current gateway reserves input bytes and output together against
`budget.max_output_tokens`. The Hermes proof explicitly supplies `200000`; the
default `8000` can reject the engine prompt with `token_cap_exceeded`. Choose a
bounded budget when creating a real-engine job; the service does not enlarge it
after admission.

The reference client can also run against the scripted mock:

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
