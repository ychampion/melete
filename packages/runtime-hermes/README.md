# Hermes runtime adapter

This package contains the HTTP adapter, plugin and container configuration for
Hermes `v2026.9.7`, behind the `RuntimeAdapter` contract.
The pin is checked by `names the exact release the image is built from` in
[`client.test.ts`](src/client.test.ts).
The service constructs and supervises this adapter itself when
`MELETE_RUNTIME_ADAPTER=docker` is set (one container per attempt, retired when
the attempt ends); otherwise callers inject a runtime or use the explicit local
stub.

## Configuration and prompt scope

Every surface that starts the engine renders its configuration from
[`src/engine-config.ts`](src/engine-config.ts): the image's own copy in
`config/config.yaml`, the boot script, the process supervisor, the container
supervisor, the evaluation stack and the local end-to-end harness. A setting is
therefore changed in one place, and
`the configuration in the image is what the renderer produces` in
[`engine-config.test.ts`](src/engine-config.test.ts) fails if the committed file
drifts from it.

What it renders: the Melete plugin toolset alone, which is what turns every
built-in toolset off; the tool-search bridge off; the skill curator,
conversation checkpoints and the auxiliary title and review requests off, so
nothing spends a job's budget in the background; `memory.memory_enabled` and
`memory.user_profile_enabled` both false, which are the two keys the engine
actually reads — a store built from either one loads its files out of the engine
home whatever the toolset list says; a turn ceiling of 150
(`MELETE_ENGINE_MAX_TURNS`), which is a runaway stop and not a cost control,
since unset means unlimited; the tool-loop hard stop on by name, because the
engine counts this platform as attended and would otherwise only warn; and model
traffic pointed at Melete's gateway.

Compaction is on, in place, and does not abort the attempt when a summary
fails. `model.context_length` comes from Melete's model catalog, so the engine's
arithmetic and Melete's agree, and `compression.threshold_tokens` is the lowest
of the engine's own trigger for that window, the owner's cap
(`MELETE_COMPACTION_MAX_TOKENS`, default 200,000) and a figure that keeps the
request inside the body the gateway accepts. The summary call runs on the
attempt's own model through the gateway and is metered like any other request;
the capability header is written into the model section as well as the provider
entry, because the auxiliary client that makes that call reads only the former.
`HERMES_BUNDLED_SKILLS` names a directory that does not exist, so the engine's
own bundled skills are never copied into an attempt's home.

The boot script adds only what belongs to one attempt: the capability, the model
it was granted, and the window and trigger that follow from that model. The
image also applies
`patches/observer_bridge.py`: three source hashes must match the audited pin or
the identical reviewed patch. It adds a real compaction dispatch and binds
plugin observations to the current HTTP run queue; updating the pin means
reviewing those seams again. A checkout carrying an earlier version of the patch
is refused as well, so it has to be restored to the pinned commit first.
The image's labels record the Hermes commit and the plugin content hash, and
`build-metadata.py` refuses a build whose plugin bytes do not match the pin.
Historical measurements remain in
[the engineering record](../../.agents/notes/0009-hermes-surface.md); the
current scaffolding measurement is below.

The broker filters tools by scopes and serves a token-budgeted core (750
estimated tokens, discovery tools included) plus `search_tools` and `load_tool`;
the contract's tool-count constant is advisory and the catalog is bounded by the
token budget rather than by a fixed number of tools.
`renderInstructions` orders identity, skills and knowledge; named client tests
include `the identity is short enough to be a prefix, not a personality`,
`the instructions are identity, then skills, then knowledge`, and
`every knowledge excerpt carries where it came from`. The engine adds its own
prompt on top of these instructions, so the measurement below is of the whole
assembled request.

## HTTP lifecycle and approvals

The client builds requests for capabilities, run start/status/events/stop and
shell-approval responses. Evidence includes `start posts to /v1/runs with the
surrogate token`, `the attempt id is the idempotency key and the job id is the
session`, and `the event request asks for a stream and does not try to resume one`.

Adapter tests use a fake Hermes fetch surface:
`refuses an engine whose run idempotency is not durable`,
`maps the stream to contract events in order`,
`a tool result is paired with the call that opened it`, and
`an interrupted run fails retryably and says history is missing`.
They prove adapter behavior for those frames, not a full real-engine deployment.

Broker-tool decisions use Melete park-and-resume:
`a parked action turns a completion into waiting_for_approval`.
They are not routed through Hermes's plugin approval gate. The resumed input
names the approved tool and its stored payload, and `resume_action` forwards
only the action id (`an approved decision names the tool, the approved payload
and how to carry it out`; `test_resume_sends_only_the_action_id_and_returns_the_receipt`).
A reply that asks for a go-ahead on an external effect nobody proposed gets one
continuation and otherwise settles waiting for input (`proposal.ts`; `an ask
that still proposes nothing settles waiting for input, never completed`).
Unexpected shell approval notifications are denied
(`a shell-command approval is denied, never allowed for the session`).

## Plugin and container limits

The plugin forwards broker proposals and returns their dispositions, carries
out `in_cell` execution tools itself, and registers a schema the broker loads on
demand. Its Python test suite (`tests/`) runs with `bun run test:plugin`; a
local TypeScript adapter pass does not imply container execution passed.

Compose declares an internal-only runtime, read-only root, non-root UID and
dropped capabilities. Each attempt's container mounts only its job's `work/<job>`
subpath, a named `/var/lib/hermes` volume and temporary storage. The home volume
supports durable engine run-idempotency; the static check `taking away the
runtime writable Hermes home` covers the declaration.

Inside-container egress and filesystem probes are
[conformance 6](../../conformance/scenarios/06-no-route-out.test.ts); run from a
claimed attempt and the warm cell on a Linux Docker host, they found the broker
and model gateway to be the only reachable peers, with Postgres, the web service
and the owner control plane unreachable. The service
starts and retires these containers itself when the Docker runtime is selected.

## What the thin configuration costs

The local discovery end-to-end test captures the first actual provider request
from pinned commit `2237be355906fbe6065ce1815711eee52b2d646e`. With a seven-tool
core, it measured 7,708 system-prompt characters and 2,886 tool-schema characters:
**2,649 estimated tokens**, using `ceil((system + schemas).length / 4)`, below
the 4,000-token tripwire. The broker core itself was 714 estimated tokens
against its 750-token budget. That measurement predates the names-only index of
unloaded tools, which may add at most 250 estimated tokens to `load_tool`; the
wire request has not been measured again with it. This is a scaffolding
estimate, not provider usage or a tokenizer-specific count. User input and subsequent tool results are metered
separately by the gateway.

The earlier prompt-assembly probe in `.agents/notes/0009-hermes-surface.md`
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
sandbox nobody built. In a container, `/work` holds one job and no sibling:
`apps/melete/src/runtime/docker.ts` mounts the work volume with
`VolumeOptions.Subpath` set to the attempt's job id, and the warm cell in
`deploy/docker-compose.yml` mounts the `_probe` subpath the same way. The
declaration is covered by `pins the image, mounts only the job subpath, and
isolates its sole broker peer` in `runtime/docker.test.ts`, and the live
filesystem by conformance 6's `another job is absent from the mounted
filesystem`.

Enabling execution for a space is two things: an `exec` connection, and the
`exec.run` / `exec.python` scopes on the job. A job without them sees no
execution tools at all, because the broker filters the catalog before the cell
does anything with it. It costs 477 tokens of scaffolding when it is on, taking
a thin attempt from 3,304 to 3,781; see `.agents/notes/0016`.

`packages/runtime-hermes/scripts/e2e-exec.ts` runs the whole path against a real
Hermes API server from the pinned tag.

## Discovery and continuations

The initial catalog is a deterministic core plus two read-only meta-tools.
`search_tools` returns compact scoped manifests; `load_tool` persists a schema in
the attempt's context and registers its forwarder. Loaded tools retain the same
broker approval, scope, budget and receipt checks. Skill reads and the optional
`compose` execution seam use `/tools/call`; connector effects use `/actions`.

Pinned Hermes snapshots its toolset when constructing each active agent, so
registering a tool does not mutate that snapshot. The adapter verifies the new
catalog through its service-owned `catalogState` callback, stops and drains the
current run, then starts a continuation with the extended catalog. Model text
cannot authorize a continuation. The attempt, capability, budgets and event
sequence are shared, and there is exactly one public attempt outcome.
Continuations keep the native Hermes session history; the real-server test
checks the previous request remains an exact prefix of the next request's
history.

## Lifecycle observations

Lifecycle observations become `hook_event` or `hook_error`, use the adapter's
ordinary event sequence, and are persisted before timeline fan-out and replay.
Retried captures keep their identity. Only fixed metadata and a digest of
redacted argument shape survive; values, messages, results and exception text
are omitted. Hooks return no directive and never enforce authorization.
`on_session_end` retains Hermes's turn-finalization meaning. The compaction
patch dispatches only after committed progress.

Run `bun run test:plugin` and
`bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2`
for the observer and persistence checks. The optional Windows real-server check is
`MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`;
prepare `.hermes-venv` using note 0009 and install the pin's `aiohttp==3.14.3`.
That check passes with 17 assertions, including observer failure isolation and
one successful tool call. The current combined
proof is `MELETE_CAPABILITY_PROOF=1 bun test apps/melete/test/integration/capability-proof.test.ts --max-concurrency=1`.
It uses the service's process supervisor, which prepares the same hash-checked
observer bridge as the image before starting its first engine. Continuation
captures retain the original attempt identity and use separate capture IDs.
The proof records real lifecycle hooks and exercises runtime MCP installation,
search/load, receipts, bounded reconnect, sealed credential refresh, private
learning, evaluated teammate reuse and revocation. A lost acknowledgement stays
unknown without replay. Real compaction is unverified. See the
[capability matrix](../../docs/CAPABILITIES.md).

## Per-attempt launch

The service supervisor supplies these values per attempt; they are not static
Compose settings. In process mode, `process_launcher.py` wraps the aiohttp
listener startup to report the OS-selected port after binding, so the supervisor
never releases a candidate port before the child starts (tested with two
simultaneously live ephemeral listeners).

| | |
|---|---|
| `MELETE_ATTEMPT_TOKEN` | the capability, written into the provider's `extra_headers` at boot because the model gateway meters per attempt |
| `MELETE_JOB_ID` | scopes the proposal reference, so an approved action resumes rather than duplicating |
| `MELETE_ATTEMPT_ID` | correlation |
| `MELETE_MODEL_KEY` | the surrogate, which must match `melete-surrogate-<label>`; a label, not the capability |
| `MELETE_MODEL_PROVIDER`, `MELETE_MODEL_NAME`, `MELETE_MODEL_API_MODE` | the job's selected provider, model and transport, applied to the gateway-only provider configuration |
| `MELETE_BROKER_URL` | the internal service listener |

`API_SERVER_KEY` is also required, and its absence is silent: without a usable
key the `api_server` platform is never enabled. `HERMES_HOME` is a per-attempt
writable mount: the API server's run-idempotency reservations are a SQLite file
under it, and the adapter refuses an engine whose reservations are not durable.

## Verify the adapter

From the repository root:

```bash
bun test packages/runtime-hermes/src
```

This command uses fake HTTP responses and does not start Docker or call a paid
provider.

## Licence

Melete is Apache-2.0. The engine is fetched at image build time; see
[NOTICE](../../NOTICE) for the upstream attribution.
