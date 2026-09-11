# W3 — runtime on pinned Hermes

Append-only. Each slice adds a section; nothing above is edited afterwards.

Machine: Windows 11, bun 1.3.13, node 24.14.0, python 3.12.6, uv 0.9.21,
git 2.33.0. **No Docker.** Everything marked unverified stayed unverified.

## Slice 1 — the Hermes surface at the pin

Tag `v2026.9.7` resolves to commit `2237be355906fbe6065ce1815711eee52b2d646e`
(`chore: release v0.21.1 (2026.9.7)`). Installed into `.hermes-venv` with
`uv pip install -e ./.hermes-src`; both directories are gitignored.

Tripwire: **not fired.** Built-ins can be disabled, every route exists, and the
thin scaffolding measures 3,275 tokens against a 4,000 budget.

Measured by `.agents/probe/measure_thin.py` through the release's own
`_get_platform_tools`, `model_tools.get_tool_definitions` and
`agent.system_prompt.build_system_prompt`. Tokens are chars/4.

| configuration | tools | tool schemas | system prompt | total |
|---|---|---|---|---|
| default `hermes-api-server` here | 23 | 8,737 | 3,154 | 11,891 |
| thin, no identity | 6 | 349 | 2,719 | 3,068 |
| thin + Melete identity | 6 | 349 | 2,926 | 3,275 |

Two corrections to what the skeleton assumed, both in
`.agents/notes/0009-hermes-surface.md` with citations: the plugin allow-list key
is `plugins.enabled` (a list, not `plugins.allow` and not a boolean), and
`tools.tool_search.enabled: "off"` is required or the six broker tools are
collapsed behind a `tool_search`/`tool_describe`/`tool_call` bridge.

Checks:

```
$ bun run lint
Checked 171 files in 223ms. No fixes applied.
$ bun run typecheck
tsc -b && tsc -p apps/web/tsconfig.json --noEmit   (clean)
```

## Slice 2 — the Melete plugin

`packages/runtime-hermes/melete_plugin/` is three modules: `broker.py` (the one
socket), `results.py` (the three shapes a broker answer can take), and
`__init__.py` (`register(ctx)`). It imports nothing from Hermes beyond the `ctx`
object, so the compatibility-path removal on 2026-09-14 cannot reach it.

A needs-approval result carries an instruction to stop, because Hermes cannot
suspend a run for days and resume it. A broker that never answered is reported
as `unknown`, not `failed`: a request with no answer may still have been
received, and retrying it is how one approved send becomes two.

Corrected the slice 1 measurement. The probe had registered its stubs with a
bare JSON Schema, but `tools/registry.py:774` builds the definition as
`{**entry.schema, "name": entry.name}`, so what goes in `schema=` is the OpenAI
function body. The corrected numbers are thin 3,093 tokens, thin + identity
3,304, default 11,916. Still under the 4,000 budget. `melete_plugin.tool_schema`
produces the right shape and a test pins it.

`config/config.yaml`, the README and `src/client.ts` were rewritten against what
the tag actually reads. The skeleton's `POST /v1/runs` body carried
`skip_memory`, `skip_context_files`, `toolsets: []`, `max_turns` and `provider`;
none of those are fields on that route, and `_create_agent` takes all of them
from config. The body now carries `input`, `instructions`, `session_id` and
`model`, which is what the engine reads.

Checks:

```
$ bun run test:plugin
18 passed in 9.16s
$ bun test packages/runtime-hermes --max-concurrency=2
24 pass, 0 fail, 45 expect() calls
$ bun run typecheck
(clean)
```

## Slice 3 — the adapter

`packages/runtime-hermes/src/adapter.ts` implements `contracts.RuntimeAdapter`.
`capabilities()` refuses an engine whose `runs_idempotency.durable` is false.
`start()` sends `Idempotency-Key: <attempt id>` and `X-Hermes-Session-Key: <job
id>`, consumes the stream once, and numbers every event `attempt_id:local_seq`.

Two things the engine's run stream does not carry, both of which changed the
mapping. There are no tool arguments on it, only a preview string
(`_FIXED_EVENT_FIELDS` in `api_server_runs.py`), so `tool_call_proposed` carries
the preview and the real canonical payload stays on the broker's action record,
which is where an approval is argued over anyway. And there are no tool call
ids, so a result is paired with its start by name off a per-name stack.

There is no `gap` event in the frozen contract, and `text_delta` is explicitly
non-durable, so a gap recorded there would vanish. The gap is carried instead in
the reason of a `failed{retryable:true}`, which is durable and can never be read
as a completion. `.agents/notes/proposed/2026-09-11-gap-event.md` proposes the
event type; the contract was not changed.

Checks:

```
$ bun test packages/runtime-hermes --max-concurrency=2
42 pass, 0 fail, 101 expect() calls
```

## Slice 4 — the local end-to-end, with the real engine

`packages/runtime-hermes/scripts/e2e.ts`. Real Hermes API server from the pinned
tag in `.hermes-venv`, real broker, real model gateway with its fake provider,
real adapter, embedded Postgres. The only mock is the model, because the point
is the path an effect takes rather than what a language model says.

```
bun run packages/runtime-hermes/scripts/e2e.ts
```

Last run, in full:

```
broker + gateway on 127.0.0.1:54619
cold start: 6152 ms
capabilities: {"streaming":true,"tools":true,"interrupt":true,"version":"hermes@v2026.9.7 (hermes-agent)"}
outcome: {"kind":"waiting_for_approval","action_ids":["act_01M283HS2PAA9EXP0SAY5SRN67"]}
events: turn_started, tool_call_proposed, tool_result, text_delta, action_requested, attempt_outcome
actions: [{"id":"act_01M283HS2PAA9EXP0SAY5SRN67","kind":"test.send","status":"needs_approval","effect_class":"write_external"}]
approval: 200 {"decision":"approved","payload_hash":"cb41d1d1...","decided_at":"2026-09-11T11:27:22.845Z"}
second cold start: 6125 ms
second outcome: {"kind":"completed","summary":"The scripted action has a recorded receipt.","evidence":[]}
second events: turn_started, tool_call_proposed, tool_result, text_delta, attempt_outcome
actions after approval: [{"id":"act_01M283HS2PAA9EXP0SAY5SRN67","status":"succeeded","has_receipt":true}]
```

One action, not two. The approved action is the one that was carried out.

Cold start is 5.6 to 9.3 seconds across runs, on Windows, from a warm page
cache, with a model-provider catalog that probes several backends before
settling. A container on Linux with no ambient provider keys should be faster;
this number is an upper bound, not a benchmark.

### Five things only the real engine could have told us

Each of these passed every unit test and failed against the running server.

1. **`API_SERVER_KEY` is required.** Without a usable key,
   `gateway/config_env.py:_api_server` returns before enabling the platform. The
   process starts, logs nothing alarming, and never listens. The first run sat
   on a two-minute timeout with a healthy-looking gateway.
2. **Provider keys in the ambient environment win.** A stray `GOOGLE_API_KEY`
   routed the run to Gemini, which answered 404 for a model it had never heard
   of. The container inherits none of these; a local harness must strip them.
3. **The gateway needs the capability on every model request**, not just the
   surrogate: `401 capability_required`. Hermes sends a provider's
   `extra_headers` on each call, so the entrypoint writes
   `x-melete-capability` into the config at boot from `MELETE_ATTEMPT_TOKEN`.
4. **The surrogate is a label, not the capability.** The gateway matches
   `/^melete-surrogate-[A-Za-z0-9_-]+$/` and a JWT's dots fail it.
5. **A plugin handler is called with one positional dict**, not keyword
   arguments (`tools/registry.py:822`). A `**kwargs`-only signature raised
   `TypeError` before the broker was ever reached, and the model was told the
   tool was broken. The fake broker could not have caught this; two tests now
   pin both call shapes.

### One design decision the end-to-end forced

The plugin's `client_ref` is scoped to the **job**, not the attempt.

An action that parks for approval is carried out when the next attempt proposes
the same thing again: the broker finds the approved action under that reference
and dispatches it. With an attempt-scoped reference the resumed attempt created
a second action and left the approval attached to one nobody would ever execute.
The run showed exactly that before the change: two rows, one `approved` with no
receipt and one `needs_approval`.

The cost is that two genuinely separate but byte-identical effects within one
job collapse into one. That is the safer direction. An approval binds to a
payload hash, so a second identical send is indistinguishable from a retry, and
sending twice is the failure that cannot be taken back.

### What the end-to-end did not measure

The scaffolding tokens on the wire from the real server were not captured. The
3,304-token figure in slice 1 comes from the release's own prompt-assembly and
tool-definition functions rather than from a request body, and no transcript or
volatile input was included in it. Capturing the on-wire number needs a tap in
the gateway's metering path, which was not built.

## Slice 5 — image and compose, authored and unverified

**The image has not been built. This machine has no Docker.** The install path
follows upstream's own container build at the tag and the syntax is checked, but
no image exists and no probe has run against one.

The Dockerfile now fails the build if the tag has moved: it asserts the clone's
HEAD equals `2237be355906fbe6065ce1815711eee52b2d646e` and records it in a label
and at `/opt/hermes/.melete-hermes-commit`.

`HERMES_HOME` moved to `/var/lib/hermes` on a named volume, because the root
filesystem is read-only and the run-idempotency reservations are a SQLite file
under it. On a read-only root that store degrades to process memory,
`/v1/capabilities` reports `durable: false`, and the adapter refuses to start.
`deploy/scripts/compose-check.ts` gained two checks: the allowed mounts are
`/work` and `/var/lib/hermes` and nothing else, and the Hermes home must be
writable.

`conformance/scenarios/06-no-route-out.test.ts` carries the six probes as
`test.todo` with the exact command and the exact expected failure for each. It
is that file rather than a new `06-egress.test.ts`, because scenario 6 already
had a file and two files for one scenario would be worse than one good one. The
probes use Python's standard library rather than curl: `python:3.12-slim` ships
neither curl nor wget, and the image deliberately leaves no package manager
behind.
