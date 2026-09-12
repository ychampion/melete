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
| `tools.tool_search.enabled: "off"` | `config/config.yaml` | Melete supplies its own scoped `search_tools` and `load_tool`; the engine's separate discovery bridge is disabled. |
| `skills.enabled: false` | `config/config.yaml` | Skills are discovered and read through the broker, which enforces the current space and scopes. |
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

The local discovery end-to-end test captures the first actual provider request
from pinned commit `2237be355906fbe6065ce1815711eee52b2d646e`. With a seven-tool
core, it measured 7,426 system-prompt characters and 2,774 tool-schema characters:
**2,550 estimated tokens**, using `ceil((system + schemas).length / 4)`, below
the 4,000-token tripwire. The broker core itself was 694 estimated tokens
against its 750-token budget. This is a scaffolding estimate, not provider usage
or a tokenizer-specific count. User input and subsequent tool results are metered
separately by the gateway.

The earlier W3 prompt-assembly probe in `.agents/notes/0009-hermes-surface.md`
used a different tool fixture and is historical evidence. The discovery test
measures the wire request after the current plugin and configuration are active.

With the pinned source installed at `.hermes-src` and its Python environment at
`.hermes-venv`, reproduce on Windows with:

```bash
bun run packages/runtime-hermes/scripts/discovery-e2e.ts
```

It uses embedded Postgres, real pg-boss, the local Hermes HTTP server on 3140,
the broker on 3142, and a scripted provider. It asserts search, load, continuation,
receipt persistence, append-only provider history and one public outcome. Raw
captures stay in its temporary directory because they include local capabilities.

## The plugin contract

`melete_plugin/` registers one tool per entry in the broker's catalog and
nothing else. Every handler is a forwarder: it posts the proposed payload to the
broker over the internal network and returns what the broker says.

The plugin holds no credentials, contains no connector code, and makes no
decisions. Canonicalisation, effect classification, approval, budget, dispatch,
and the receipt all happen on the broker side, where they can be recorded.

The initial catalog is a deterministic core plus two read-only meta-tools.
`search_tools` returns compact scoped manifests; `load_tool` persists a schema in
the attempt's context and registers its forwarder. Loaded tools retain the same
broker approval, scope, budget and receipt checks. Skill reads and the optional
`compose` execution seam use `/tools/call`; connector effects use `/actions`.

Pinned Hermes snapshots its toolset when constructing each active agent.
Registering a tool does not mutate that snapshot. The adapter therefore verifies
the new catalog through its service-owned `catalogState` callback, stops and
drains the current run, then starts a continuation with the extended catalog.
Use `brokerCatalogState` when constructing the adapter. Model text cannot
authorize a continuation. The attempt, capability, budgets and event sequence
are shared, and there is exactly one public attempt outcome.
After execution ends, a ledger check bounded by the broker client's timeout (30 seconds by default) preserves pending
approvals even when the model's wall allowance has expired. It permits no new
model run or tool execution and aborts the lookup if the service stalls. The
`unknown_check` outcome explicitly records timeout or unavailability and holds
the job for input without automatic retry. Set `brokerParkedActions.timeoutMs`
to match a customized broker timeout.

Continuations keep the native Hermes session history, including complete tool
call and result metadata. They do not reconstruct `conversation_history`, which
the pinned HTTP path would normalize and strip. The real-server test checks the
previous request remains an exact prefix of the next request's history.

Two details that the local end-to-end settled and that are easy to get wrong.

A handler is called as `handler(args, **kwargs)` with the model's arguments in
one positional dict, not as keyword arguments. A `**kwargs`-only signature
raises `TypeError` before the broker is reached, and the model is told the tool
is broken. Engine metadata such as `session_id` is not merged into those
arguments. Registered handlers return JSON strings because the pinned dispatcher
adds message metadata to object results; the HTTP broker client itself uses
ordinary JSON objects.

The proposal reference is scoped to the **job**, not the attempt. An action that
parks for approval is carried out when the next attempt proposes the same thing
again: the broker finds the approved action under that reference and dispatches
it. An attempt-scoped reference makes that a brand new action and leaves the
owner's approval attached to one nobody will ever execute. The cost is that two
genuinely separate but byte-identical effects in one job collapse into one,
which is the safer direction: an approval binds to a payload hash, so a second
identical send is indistinguishable from a retry.

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

The adapter answers `deny` to shell-approval notifications. Broker approvals
use the ledger flow above. It never grants `allow_session` or `allow_permanent`,
which would outlive the attempt they were granted for.

## Running code inside the cell

The cell has no route out and every external effect is brokered, so a command's
effects are confined to `/work/<job>` and can be read, diffed and deleted like
any other file. Execution is therefore enabled, and it needs no approval: there
is no recipient, no destination and no money in it. It is `write_reversible`,
which auto-admits within budget, exactly like `files.write`.

It is **not** the engine's built-in terminal toolset. A built-in runs the
command inside Hermes and hands the output back to the model, and nothing about
that reaches the broker: no action row, no receipt, no effect class, no event.
The one kind of work that writes files would be the one kind of work with no
record. So execution is a Melete tool, served by the broker like every other
tool, and carried out here:

```
exec.python(code)     the catalog entry, filtered by the job's scopes
  -> melete_plugin.execution.run_in_cell   a subprocess in /work/<job>
  -> POST /actions     the RECORD: command, cwd, exit code, duration,
                       output digest, whether it was truncated and killed
  -> receipt           on the ledger and in the event stream
```

The tool's arguments and the action's payload are deliberately two different
shapes: the model asks for a command, the ledger receives a command that has
already finished. `connectorTool.record_schema` declares the second one and
`connectorTool.execution: 'in_cell'` tells the cell which tools work this way.

The workspace is `/work/<job>`, not `/work`: the volume holds one directory per
job and this container is one attempt of one job. `MELETE_WORK_DIR` overrides it
for local runs. What the plugin enforces is the arguments, the caps and the
environment:

- a working directory or stored-output path outside the workspace is refused
  before any process starts, and refused again by the broker when the record
  arrives, so a cell that lied about where it ran is caught at the ledger;
- 30 seconds by default and 120 at most, and a command past its cap is killed
  and the kill is recorded rather than smoothed over;
- 16 KiB of output to the model, then a truncation marker naming the file the
  retained output was written to, under `.melete/exec/`, capped at 4 MiB. The
  record gives `captured_bytes`, `total_bytes` and `capture_limited`; output
  beyond that cap is discarded and the stored prefix is labeled accordingly;
- the child gets an allow-listed environment with no `MELETE_ATTEMPT_TOKEN`, no
  `MELETE_MODEL_KEY` and no proxy variables, so a snippet cannot act as the
  attempt or spend its model budget behind the ledger's back.

What the plugin does **not** enforce is the filesystem. A snippet that opens an
absolute path outside the workspace is stopped by the container's read-only root
and by `/work` being its only writable mount, not by anything in Python. On a
developer machine that protection is simply absent, and
`tests/test_execution.py` asserts that it is absent rather than implying a
sandbox nobody built. One gap remains in `deploy/docker-compose.yml`: it mounts
the whole work volume, so a snippet can read a sibling job's directory even
though the tool refuses to. The per-attempt container has to mount `work/<job>`.

Enabling execution for a space is two things: an `exec` connection, and the
`exec.run` / `exec.python` scopes on the job. A job without them sees no
execution tools at all, because the broker filters the catalog before the cell
does anything with it. It costs 477 tokens of scaffolding when it is on, taking
a thin attempt from 3,304 to 3,781; see `.agents/notes/0016`.

`packages/runtime-hermes/scripts/e2e-exec.ts` runs the whole path against a real
Hermes API server from the pinned tag.

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

The first `Idempotency-Key` is the attempt id; discovery continuations append
`:tools:<index>`. Each retry therefore resolves to its existing run while a
verified schema load can start one new run. The session key is the job id, so
consecutive attempts and discovery continuations retain native session history.

Melete consumes the event stream once and persists every event before fanning it
out. An interrupted run is a dead attempt and is never resumed; the job survives
in Postgres and the next wake starts a fresh attempt.

## Starting the container

Four values are per attempt and are not in the image. The entrypoint refuses to
start without the first two.

| | |
|---|---|
| `MELETE_ATTEMPT_TOKEN` | the capability. Written into the provider's `extra_headers` at boot, because the model gateway meters per attempt and needs it on every inference request, not only the surrogate. |
| `MELETE_JOB_ID` | scopes the proposal reference, so an approved action resumes rather than duplicating. |
| `MELETE_ATTEMPT_ID` | correlation. |
| `MELETE_MODEL_KEY` | the surrogate, which must match `melete-surrogate-<label>`. It is a label, not the capability: a JWT's dots fail that pattern. |

`API_SERVER_KEY` is also required, and its absence is silent: without a usable
key the `api_server` platform is never enabled, so the container starts, logs
nothing alarming, and never listens.

`HERMES_HOME` is a writable volume rather than part of the read-only root. The
API server's run-idempotency reservations are a SQLite file under it; with
nowhere to write, the store falls back to process memory, `/v1/capabilities`
reports `runs_idempotency.durable: false`, and the adapter refuses to start
rather than let a retried start become a second run.

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
