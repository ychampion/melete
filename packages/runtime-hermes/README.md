# @melete/runtime-hermes

The v0.1 execution engine: a pinned, unmodified [Hermes](https://github.com/NousResearch/hermes-agent)
release, configured thin, behind the `RuntimeAdapter` interface from
`@melete/contracts`.

Pinned release: **`v2026.9.7`** (MIT, Nous Research). The image builds from that
tag and records the resolved commit at `/opt/hermes/.melete-hermes-commit`, so a
running container can say exactly what it is.

## What "thin" means here

Melete does not fork Hermes. Everything below is configuration, which is what
makes upgrading the pin a one-line change instead of a rebase.

| Switch | Where | Why |
|---|---|---|
| `platform_toolsets.api_server: [melete]` | `config/config.yaml` | The one key that turns every built-in off. An explicit list replaces the `hermes-api-server` default, so the model's whole catalog is what the broker served for this job. |
| `plugins.enabled: [melete]` | `config/config.yaml` | An allow-list of plugin directory names. It is a list, not a boolean: `plugins.enabled: true` loads nothing, silently. |
| `tools.tool_search.enabled: "off"` | `config/config.yaml` | Plugin tools are otherwise collapsed behind a `tool_search`/`tool_describe`/`tool_call` bridge. The broker's catalog is already scope-filtered and capped, so the bridge only adds a round trip. |
| `memory.enabled: false` | `config/config.yaml` | Melete owns memory. A retracted knowledge record has to vanish from retrieval at once, which an engine-side store would quietly undo. |
| no context files in the image | `Dockerfile` | No `SOUL.md`, `AGENTS.md` or `.hermes.md` for the prompt builder to find. The identity is sent with every run and is capped at 250 tokens. |
| `providers.melete-gateway` | `config/config.yaml` | The only inference endpoint is Melete's model gateway, which holds the real provider key. The surrogate in this container is worth nothing elsewhere. |
| `HERMES_EXEC_ASK=1` | `Dockerfile` | Surfaces the shell-command guard. See below. |
| No route out | `deploy/docker-compose.yml` | The container sits only on the `internal` network. The broker is the only peer it can reach. |
| At most three skills | the service | The context assembly rule from the architecture; the bundle arrives already trimmed. |

`skip_memory` and `skip_context_files` are `AIAgent` constructor arguments, not
config keys, and the `/v1/runs` path does not pass them. The two rows above
reach the same end through configuration. Measurements and citations are in
`.agents/notes/0009-hermes-surface.md`.

### What the thin configuration costs

Measured against the pinned tag with the release's own prompt-assembly
functions, on a machine where a dozen built-ins are already gated off by their
`check_fn`s (so the default column is a floor, not a ceiling):

| | tools | tool schemas | system prompt | total |
|---|---|---|---|---|
| default `hermes-api-server` | 23 | 8,766 tok | 3,150 tok | 11,916 tok |
| thin + Melete identity | 6 | 377 tok | 2,926 tok | 3,304 tok |

Most of the remaining 2,926 tokens are Hermes's own preamble, not Melete's. Run
`instructions` are appended to it rather than substituted for it, so an attempt
always carries the engine's voice underneath the identity. That is the honest
floor on this engine and the first thing a native loop would recover.

## The plugin contract

`melete_plugin/` registers one tool per entry in the broker's catalog and
nothing else. Every handler is a forwarder: it posts the proposed payload to the
broker over the internal network and returns what the broker says.

The plugin holds no credentials, contains no connector code, and makes no
decisions. Canonicalisation, effect classification, approval, budget, dispatch,
and the receipt all happen on the broker side, where they can be recorded.

The catalog is fetched at registration and is already filtered by the job's
scopes, so an out-of-scope tool never appears in the model's context rather than
being refused after the model has spent a turn on it.

## Melete does not use Hermes's approval gate

`api_server` is in `_UNATTENDED_APPROVAL_PLATFORMS`, so an approval escalated
from a plugin tool hard-denies with nobody to ask. Melete therefore never routes
a tool approval through Hermes. A broker tool that needs a decision returns

```json
{"status": "needs_approval", "action_id": "act_...", "instruction": "...stop..."}
```

the run ends, and the job parks on Melete's ledger where the decision is
recorded against the payload hash the person was shown. The next wake is a fresh
attempt that begins by being told what was decided.

## Why `HERMES_EXEC_ASK=1` is still set

The flag covers the shell-command guard, which is the one approval path that
does surface over HTTP. Melete's toolset has no shell command in it, so this is
a safety net rather than a dependency: if one ever appears, it is asked about
instead of silently refused. A probe against `HEAD 77e55b4` (2026-09-10)
recorded the behaviour:

- `api_server` is in `_UNATTENDED_APPROVAL_PLATFORMS`. On a bare `POST /v1/runs`,
  a Tier-2 dangerous command is blocked with "unattended platform (api_server)
  with no user present", and the gateway notifier never fires. The owner is
  never asked, so there is nothing for Melete to surface.
- With `HERMES_EXEC_ASK=1`, the notifier fires with `request_id`, `command`,
  `pattern_key`, `allow_session`, and `allow_permanent`. Both `once` and `deny`
  resolve correctly through `resolve_gateway_approval`.
- If nobody answers, the call blocks until the 300 second approval timeout.

Melete answers `once` or `deny` and never `allow_session` or `allow_permanent`.
A standing allowance would outlive the attempt it was granted for, which is the
exact property the broker exists to prevent.

## The client

`src/client.ts` builds requests and parses responses. It opens no sockets, so it
is fully testable without a container:

```
GET  /v1/capabilities          what this build supports
POST /v1/runs                  start one bounded attempt
GET  /v1/runs/{id}             status
GET  /v1/runs/{id}/events      the SSE stream, consumed exactly once
POST /v1/runs/{id}/approval    answer a shell-command notification
POST /v1/runs/{id}/stop        cancel
```

`POST /v1/runs/{id}/steer` exists and is not used: a mid-run instruction that
never reached the ledger is the untracked side channel the broker exists to
prevent.

`Idempotency-Key` is the attempt id and the session key is the job id, so a
resent start resolves to the run that already exists and consecutive attempts on
one job continue one Hermes session.

Melete consumes the event stream once and persists every event before fanning it
out. An interrupted run is a dead attempt and is never resumed; the job survives
in Postgres and the next wake starts a fresh attempt.

## Building

The image has not been built on the machine this package was written on, which
has no Docker. The Dockerfile follows the install path from the upstream
container build at the pinned tag (`uv sync --frozen --no-install-project`, then
`uv pip install --no-deps -e .`) and its syntax is checked, but the build itself
is unverified here.

```bash
docker build -t melete/runtime:0.1.0-pre packages/runtime-hermes
```

## Licence

Melete is Apache-2.0. Hermes is MIT and is fetched at build time, not vendored.
`NOTICE` at the repository root carries its copyright notice.
