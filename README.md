# Melete

An open-source, self-hosted personal assistant in development.

**Status: pre-release. Durable service components work in scripted tests; a
complete installed assistant is not claimed.** Evidence below applies to code
baseline `9484023cabd32b786cb4d336dec818f441cd0cc1`.

Melete represents a responsibility as a Postgres job with disposable attempts,
waits, approvals and action receipts. The five executable [conformance
scenarios](conformance/README.md) test recovery, fencing, unknown outcomes,
approval binding and runtime death with isolated Postgres and scripted runtimes.
They do not run a Compose deployment or a real model.

## v0.1 release gates

| Gate | Honest status and evidence |
| --- | --- |
| Reliability | Passes the tested scenarios: durable wakes; stale-attempt fencing; unknown sends without redispatch; payload/revision-bound approvals; runtime death recovery. See scenarios 1–5 and their named assertions in [conformance](conformance/README.md). This is fixture evidence, not a deployed-system guarantee. |
| Operations | Partial: database migrations and health (`answers a ping on the migrated Postgres instance`); persisted sessions (`a second service instance recognizes the persisted session`); queue recovery (scenario 1); event replay (`replays across a terminated LISTEN connection and cleans it up on shutdown`); memory restore gating (`deletion hides synchronously, cleanup failures retry, and startup refuses a missing journal`); static Compose checks. Container egress probes are **written, not run**; installation, upgrades and whole-system backup/restore are **not claimed**. |
| Capability | **Not claimed**: scripted fixtures do not establish useful autonomous task performance. |
| Output quality | **Not claimed**: no real-model answer-quality evaluation is established here. |
| Learning | **Not claimed**: procedure transfer is **written, not run** (`procedure-transfer` todo); memory correction tests are not learning evidence. |
| Adoption | **Not measurable before release**. |

## What the code does

- The broker records canonical effects and checks authority before dispatch.
  Unknown sends remain visible and are not blindly repeated (conformance 3,
  `the action is never dispatched a second time, including after broker restart`).
- The service has authenticated job, approval, scheduling, attention and event
  APIs. Startup requires a supplied runtime or the explicit scripted stub when
  Postgres is configured; automatic Hermes startup is **not claimed**. See
  [architecture](docs/ARCHITECTURE.md) for the wiring and named tests.
- Memory authority is Postgres evidence and versioned claims. Markdown in git
  is a derived inspection/edit surface; a raw file edit alone is not an
  authoritative correction (`Markdown round trips support, preserves local
  edits, and owner edits become protected revisions`). Memory startup/router
  integration is optional and is not wired by default; see [memory](docs/MEMORY.md).
- The broker catalog is filtered by scopes; a universal 15-tool limit is
  **not claimed**. The contract constant is not an enforced catalog cap.
- The pinned Hermes adapter and model gateway have fixture tests. Compatibility
  with every provider and real-model policy equivalence are **not claimed**;
  conformance 8 is **written, not run**.
- Compose hardening is declared and statically checked. Runtime egress probes
  are **written, not run**. Postgres shares the runtime's internal network, so
  exclusive broker reachability is **not claimed**. See the [threat model](docs/THREAT-MODEL.md).

## Verify from the repository root

Use Bun 1.3 or newer. These commands finish without a development server.
Database fixtures use disposable Postgres 17 when `DATABASE_URL` is unset;
otherwise they create disposable databases on the supplied server, requiring
database-creation permission. An unavailable embedded binary produces a skip,
which is not a pass. Tests use fake providers. Initial dependency/binary downloads
can require network access.

```bash
bun install
bun run typecheck
bun run lint
bun test --max-concurrency=2 --timeout=15000
bun run openapi
bun run client:generate
bun run compose:check
bun test --max-concurrency=2 --timeout=15000 conformance/scenarios
bun run conformance:memory
```

The generators update the OpenAPI document and client declarations; generated
differences must be inspected. The Compose command checks YAML, not live
networking. The service-scenario command runs scenarios 1–5 and reports 6–8 as todo.
The timeout gives each test/fixture hook fifteen seconds; it is not a total-suite
duration. The shorter default can expire during fixture setup or cleanup; see
the recorded command outcomes before interpreting a nonzero exit.
The memory runner executes ten scenarios across seven families plus ten
withheld-memory runs; procedure transfer is **written, not run**. Results and
command failures are recorded in [REPORT.md](REPORT.md).

## Repository guide

| Path | Role |
| --- | --- |
| `apps/melete` | Service modules and database integration tests |
| `packages/contracts` | Schemas, state transitions and generated OpenAPI |
| `packages/client`, `apps/web`, `apps/mock-api` | Typed client, reference UI and scripted mock; see [CLIENT](docs/CLIENT.md) |
| `packages/runtime-hermes` | Pinned engine configuration and HTTP adapter |
| `packages/knowledge`, `apps/melete/src/memory` | File-view utilities and authoritative memory service |
| `deploy` | Deployment configuration; live deployment is **not claimed** |
| `conformance` | Executable scenarios and explicit todos |
| `docs` | [Architecture](docs/ARCHITECTURE.md), [memory](docs/MEMORY.md), [engineering evidence](docs/ENGINEERING.md), [threat model](docs/THREAT-MODEL.md), [connectors](docs/CONNECTORS.md) |
| `.agents/notes` | Historical engineering decisions; retained as history, not current release claims |

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
