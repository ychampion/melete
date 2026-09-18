# 0021 - Hermes capabilities at the pin and the Melete boundary

Status: recorded (source audit; implementation status is separate)
Date: 2026-09-12

## Evidence and scope

Melete revision `9484023cabd32b786cb4d336dec818f441cd0cc1` was inspected in
`lane/w14-capabilities`. A fresh `.hermes-src` checkout of `v2026.9.7` resolves to
`2237be355906fbe6065ce1815711eee52b2d646e`. Every upstream `file:line` below refers
to that commit, not current upstream HEAD. Source inspection establishes an
offered interface; only an executed Melete test establishes a Melete capability.

Reproduce the source inventory from a checkout with `.hermes-src` at the pin:

```sh
git -C .hermes-src rev-parse HEAD
python packages/runtime-hermes/scripts/audit-pin.py .hermes-src
```

Against the original pin, the AST probe reports **37** `VALID_HOOKS` names and
their literal dispatch sites. After W14's observer patch it additionally reports
`on_compaction`; the source references below remain references to the original pin.
It imports no upstream modules, opens no provider connections, and does not claim
that every conditional dispatch runs on the HTTP surface. Its locations can be
read at `https://github.com/NousResearch/hermes-agent/blob/2237be355906fbe6065ce1815711eee52b2d646e/<file>#L<line>`.

## Plugin loader and every registered hook name

`PluginContext.register_hook` is at `hermes_cli/plugins.py:893`; unknown names
warn but are stored. Registering a made-up `on_compaction` therefore succeeds
without making it fire. `VALID_HOOKS` is at `hermes_cli/plugins.py:107`.
`hermes_cli/lifecycle.py:26` fans into first-party observers and plugin dispatch.

| Hook name | Producer at the pin |
|---|---|
| `pre_tool_call` | `hermes_cli/plugins.py:1785`, called by `model_tools.py:710` |
| `post_tool_call` | `model_tools.py:632`; terminal executor forwarding at `agent/inline_tool_executors.py:29` |
| `transform_terminal_output` | `tools/terminal_tool_result.py:129` |
| `transform_tool_result` | `model_tools.py:788` |
| `transform_llm_output` | `agent/turn_finalizer.py:408` |
| `pre_llm_call` | `agent/turn_context.py:617` |
| `post_llm_call` | `agent/turn_finalizer.py:419` |
| `on_stream_start` | `agent/stream_delivery.py:280` |
| `on_stream_delta` | `agent/stream_delivery.py:314` and `:334` |
| `on_stream_end` | `agent/stream_delivery.py:283` |
| `on_interim_message` | `agent/stream_delivery.py:202` |
| `pre_verify` | `hermes_cli/plugins.py:1892` |
| `pre_api_request` | `agent/turn_api_request.py:64` |
| `post_api_request` | `agent/turn_response_intake.py:64` |
| `api_request_error` | `agent/api_request_hooks.py:174` |
| `transform_api_error_classification` | `hermes_cli/plugins.py:1927` |
| `on_session_start` | `agent/conversation_loop.py:733` |
| `on_session_end` | `agent/turn_finalizer.py:625`; interrupted CLI turn at `cli.py:866` |
| `on_session_finalize` | `hermes_cli/lifecycle.py:63`; real session finalization helper |
| `on_session_reset` | `gateway/slash_commands_session.py:210`; CLI also dispatches its session event dynamically |
| `on_skill_lifecycle` | `tools/skill_usage.py:444` |
| `subagent_start` | `tools/delegate_tool.py:286` |
| `subagent_stop` | `tools/delegate_tool_results.py:365` |
| `pre_gateway_dispatch` | `gateway/run_inbound.py:49` |
| `pre_approval_request` | `tools/approval.py:774`, `tools/approval_gateway_wait.py:87`, `tools/approval_prompt.py:210`, `tools/approval_smart.py:141` |
| `post_approval_response` | `tools/approval.py:777`, `tools/approval_gateway_wait.py:73`, `tools/approval_prompt.py:218`, `tools/approval_smart.py:144` |
| `pre_transcription` | `tools/transcription_command.py:228` |
| `kanban_task_claimed` | `hermes_cli/kanban_db.py:2156` |
| `kanban_task_completed` | `hermes_cli/kanban_db.py:2610`; also `hermes_cli/kanban_swarm.py:154` |
| `kanban_task_blocked` | `hermes_cli/kanban_db.py:2944` and `:2946` |
| `on_kanban_worker_spawned` | `hermes_cli/kanban_db.py:187` |
| `on_kanban_worker_exited` | `hermes_cli/kanban_db_dispatch.py:961` |
| `on_kanban_worker_stale_claim` | `hermes_cli/kanban_db.py:2350` |
| `on_kanban_task_updated` | `hermes_cli/kanban_db.py:209` |
| `on_kanban_dispatch_tick` | `hermes_cli/kanban_db.py:254` |
| `gateway_platform_event` | `gateway/run_adapters.py:1362` |
| `pre_command` | `hermes_cli/plugins.py:1735` |

### Lifecycle semantics that affect capture

- `on_session_start` fires for a new conversation, not each continuation
  (`agent/conversation_loop.py:730`). In contrast, `on_session_end` is emitted
  by `finalize_turn` after a message's conversation loop. The comment at
  `agent/turn_finalizer.py:623` explicitly separates it from true memory-provider
  shutdown. Store the original hook name; do not label it proof of process exit.
- There are no literal `pre_turn` or `post_turn` names. `pre_llm_call` and
  `post_llm_call` are the per-turn seams; the latter follows the tool loop
  (`agent/turn_finalizer.py:399`). `pre_api_request`/`post_api_request` surround
  provider requests within that turn. They must not be conflated.
- `api_request_error` observes provider failures. There is no general `on_error`
  hook. Tool errors have terminal `post_tool_call` outcomes, while outer HTTP
  exceptions become `run.failed` (`gateway/platforms/api_server_runs.py:587-595`).
- Approval hooks observe Hermes command approvals; their returns are ignored
  (`hermes_cli/plugins.py:133-138`). They do not report a Melete broker approval.
  Melete's park-and-resume ledger remains the approval authority.
- Delegation, skill lifecycle, transcription, Kanban, slash-command and messaging
  hooks are conditional on those features. The thin Melete toolset does not
  enable those tools. Their presence in the loader does not prove a Melete run
  uses them.

### Compaction is a different surface

There is no compaction hook in `VALID_HOOKS`. Successful compression calls
`agent.event_callback("session:compress", ...)` in
`agent/conversation_compression.py:3091-3102`, carrying session identity,
`in_place`, and the compression count. It also notifies the context engine and
memory manager (`:3055-3076`). This is not `ctx.register_hook` delivery.

The HTTP constructor in `gateway/platforms/api_server.py:2134-2151` passes
stream and tool callbacks, but no `event_callback`. The HTTP event forwarder
at `gateway/platforms/api_server_runs.py:147-178` accepts tool start/completion,
reasoning, and delegation boundaries. Registering a plugin callback alone
cannot capture compaction on `/v1/runs`.

**Decision: needs a narrow patch** exposing a genuine compaction observer on
the HTTP/plugin path, or an explicitly reviewed adapter for the existing
context-engine boundary. Do not monkeypatch the agent or infer compaction from
text. The upstream source is unmodified in this lane.

### Failure isolation and durability

`hermes_cli/plugins_dispatch.py:166-199` isolates callback exceptions and logs
them. It does not emit a durable `hook_error`. Bounded callbacks normally have a
30-second timeout (`:138`); a timed-out `pre_tool_call` returns a block directive
(`:187-190`). A Melete observer must therefore do bounded capture, catch its own
failures, and never return a veto, modified arguments, injected context, or
replacement output. Hook capture cannot be an enforcement gate.

**Decision: reusable as-is** for the offered observer dispatch; **needs a narrow
Melete bridge** for redaction, error records, ordering, persistence and replay.
The broker continues to enforce authentication, scope, generations, approval,
budgets, admission and dispatch even when every hook is disabled or fails.

The HTTP run stream is an in-memory queue, consumed once, not a durable hook
log (`gateway/platforms/api_server_runs.py:87-98`, `:688`). Melete currently
numbers mapped events at `attempt_id:local_seq` in its adapter. Neither a
successful plugin registration nor upstream logging supplies the requested
dedup/replay guarantee. The frozen contract blocks that bridge in slice 2.

## MCP transport, live discovery, reconnect and credentials

The client uses the optional Python MCP SDK, one background event loop and one
long-lived task per server (`tools/mcp_tool.py:1-10`). It supports stdio
(`tools/mcp_tool_transport.py:204`), SSE (`:339`) and Streamable HTTP (`:363`).
Session initialization/discovery publishes readiness at `:116`; transport
negotiation supports SDK-dependent legacy and newer protocol paths (`:78-112`).
These source branches have not been live-tested by W14.

Live discovery exists: `tools/mcp_tool_discovery.py:406` loads configured
servers, and `tools/mcp_tool_agent.py:82-123` rebuilds an already constructed
agent's tool snapshot from the live registry, with generation ordering and a
prefix-preserving mode. The agent initially snapshots its tools. The existence
of this helper does not establish an operator route or a running Melete job's
ability to discover a new server. Melete's plugin currently reads its broker
catalog once in `packages/runtime-hermes/melete_plugin/__init__.py:145`.

The reconnect loop is substantive, but has different authority semantics:

- `tools/mcp_tool_server_run.py:52-109` watches shutdown/reconnect and performs
  keepalive probes, avoiding probes during an active RPC. Failed probes cause a
  reconnect. Defaults are 180-second keepalive, five reconnect retries, three
  initial retries, a 60-second backoff ceiling and a 300-second parked self-probe
  (`tools/mcp_tool.py:234-245`).
- `tools/mcp_tool_server_run.py:125-145` removes a parked server's tools but
  keeps its lifecycle task alive. `:194-325` applies backoff and distinguishes a
  proven healthy session from a handshake that immediately drops.
- `tools/mcp_tool_handlers.py:140-184` handles auth recovery and session expiry
  with reconnect plus one retried RPC. `:191-226` respawns a dead stdio child
  and retries the call once. `:443-449` installs these recoverers on tool calls.
  Transport recovery alone does not prove that an earlier effect did not happen.
- `tools/mcp_oauth_manager.py:1-6` describes disk token reload, shared provider
  state, deduplicated 401 recovery and reconnect. `:74-95` seeds expiry and
  restores token-endpoint metadata; `:378` implements `handle_401`.
  `tools/mcp_tool_transport.py:327-337` reuses this manager across reconnects.
  A noninteractive server without cached credentials is refused (`mcp_oauth_manager.py:312-317`).
- MCP sampling and elicitation are enabled by default when the SDK supports
  them (`tools/mcp_tool_server_run.py:155-165`). These are additional model and
  approval channels, not permission granted by a Melete connection.

**Decision: must be replaced on the runtime side by broker-owned connectors**
(W10c), with typed reconnect/auth repair policy (W12). SDK transport behavior
may inform those connectors, but Melete owns installation, sealed credentials,
grants, effect identity, uncertain outcomes and revocation. Reconnect may restore
a transport; it must not silently redispatch an uncertain effect. Runtime-side
MCP credentials, sampling or elicitation cannot bypass the broker/gateway.

## Tool search and progressive disclosure

`tools/tool_search.py:1-7` defines `tool_search`, `tool_describe`, `tool_call`.
It reconstructs a live catalog; any deferrable tool activates the bridge.
`model_tools.py:465-480` performs schema collapse, and `:642-675` dispatches
against the current filtered catalog. These names are not Melete's requested
`search_tools` and `load_tool`.

Melete explicitly disables this bridge in
`packages/runtime-hermes/config/config.yaml:27-31`. Its plugin exposes the
broker's startup catalog directly. **Decision: must be replaced by Melete's
authority-aware discovery/load interface** (W10c). Search results are not grants;
both loading and use must recheck current authorization and generation.

## Skills, automatic creation, curator and rollback

Hermes lists skills and loads `SKILL.md` plus linked files through `skills_list`
and `skill_view` (`tools/skills_tool.py:519`, `:600-617`). The prompt gets a skill
index only when skills tools are enabled (`agent/system_prompt.py:298-311`).
This is model/slash-command selection, not Melete's deterministic trigger rule.

There is a real automatic skill-creation path. After enough tool iterations,
`agent/turn_finalizer.py:593-620` spawns background review if `skill_manage` is
available and background review is not disabled. The skill-review prompt at
`agent/background_review.py:368` explicitly uses owner corrections to update
or create skills. Mutation implementation is `tools/skill_manager_tool.py:392`
(create) and `:432` (patch). This is direct skill mutation, not an evaluated
Melete candidate promotion.

The curator exists and is enabled by default (`agent/curator.py:103`). It
transitions skills based on activity (`:191`); an optional model consolidation
pass is off by default (`:128`). Mutation history has before/after backups and
single-entry rollback (`tools/skill_ledger.py:1-8`, `:338-402`); normal ledger
capture failures do not block mutations (`:265-302`). These lifecycle states,
backups and ownership rules are not Melete's evaluation or audience authority.

**Decision: must be replaced** by Melete selection and W11's
correction-to-candidate-to-evaluation-to-promotion-to-rollback pipeline. The
thin toolset excludes `skill_manage`, so the foreground review trigger above
does not activate for Melete broker tools. Do not enable it as an implementation
of Melete learning. The thin config also does not explicitly disable the
independent curator; a future runtime-hardening change should do so.

Melete already implements and tests short-file loading and deterministic
selection in `packages/skills/src/loader.ts:162-201` and
`packages/contracts/src/skills.ts:69`. However, the actual service bundle at
`apps/melete/src/jobs/bundle.ts:291-293` still sets `tools`, `skills` and
`knowledge` to empty arrays. `skillsForObjective` in
`apps/melete/src/knowledge/routes.ts:303` is not called by that builder. Automatic
skill selection in the running job is therefore missing, even though the
selector is tested.

## Memory and context provider surfaces

`agent/memory_provider.py:77-140` offers initialization, a static prompt block,
prefetch, queued prefetch, turn synchronization, tool schemas/dispatch, shutdown,
session boundaries and pre-compression hooks. `agent/memory_manager.py:597-772`
fans out lifecycle work, including compression and delegation. A provider is
selected through `memory.provider` and `plugins/memory/__init__.py:181`;
`PluginContext.register_memory_provider` alone is inert
(`hermes_cli/plugins.py:728-737`).

`PluginContext.register_context_engine` replaces the built-in compressor and
admits only one engine (`hermes_cli/plugins.py:691-709`). The `ContextEngine`
surface has compression, per-request context selection, turn completion,
session boundaries and optional tools (`agent/context_engine.py:97-207`). Its
`select_context` result is request-only, not persisted transcript state (`:120`),
and its `on_session_end` is a true session boundary (`:183`), unlike the general
hook of the same name. Registered system-prompt sections (`plugins.py:917`) and
`@prefix:` reference providers (`:712`) are additional context entry points.
Built-in context files are loaded at `agent/system_prompt.py:585-596` unless
disabled through the constructor or absent from the runtime filesystem.

**Decision: must be replaced for knowledge authority** by Melete's scoped,
generation-checked memory and bounded bundle excerpts. The built-in compressor
is **reusable as-is for transient context reduction**, subject to the separate
compaction-observation gap above. New providers, reference expansion, prompt
sections or engine tools must not introduce knowledge outside a current Melete
bundle. The thin runtime keeps memory off and contextual files absent; do not
treat upstream provider availability as a delivered Melete memory feature.

## W14 implementation after the additive-contract authorization

The base-revision gaps above are historical audit findings. The resumed brief
permits additive contracts and supersedes the original freeze stop. W14 adds
typed `hook_event` and `hook_error`, plugin observers, the hash-checked HTTP and
compaction patch, and adapter deduplication into the durable event stream.
Enforcement stays in the broker. Recorded-stream and observer tests pass; the
real-Hermes check reaches hooks but still fails its broker-action assertion.

W14 also adds principals, shared membership with monotonic generation, API and
capability authorization, revocation fences, and the skill-selector wiring in
`apps/melete/src/jobs/bundle.ts`. The principal integration scenario passes
against PostgreSQL and pg-boss, including private-space refusal and regrant.
This does not supply W11's evaluated promotion or the gated MCP chain.

Compatibility details live with the schemas in `packages/contracts`. The current
three-state matrix is in [docs/CAPABILITIES.md](../../docs/CAPABILITIES.md).

## PR 27 upgrade review - 2026-09-12

The original account-upgrade test executed migration SQL directly, so its
passing result did not prove production timestamp selection. The new regression
`production migration upgrades the integration schema with MCP setup and
procedure promotion` creates the schema and real migration ledger through 0032,
then calls the actual `migrateDatabase` startup function. Before the fix it
failed with all three requested columns absent (`3` assertions, `12.44s`).

Migrations 0033 and 0034 now use timestamps `1789232400013` and `1789232400014`,
following 0032's `1789232400012`. The existing account regression now also uses
the production upgrader after constructing its historical ledger. The focused
`principals.test.ts` run passes all three tests and 87 assertions in 15.44 seconds,
including setup/login preservation, legacy capability fences, the three new
columns, and an idempotent second startup. The upgrade evidence row is restored
only with this production-path proof.

The second review reproduction pauses an actual HTTP MCP initialization and
revokes through `POST /connections/:id/lifecycle`. Both cases fail before the
route fix: successful initialization revives the row at generation 1, while
failed initialization overwrites its revoked status with error (`2` failures,
`12` assertions, `12.16s`). Completion now compares the original generation and
disabled/connecting state atomically in both update paths. A stale opened worker
is removed and closed; a changed generation returns a conflict without changing
the connection response contract.

`runtime-mcp-revocation.test.ts` preserves every revoked state field across both
handshake outcomes, verifies session disposal and registry removal, and refuses
discovery, loading and dispatch from a fresh attempt. It and `runtime-mcp.test.ts`
pass together: 3 tests, 60 assertions, 29.99 seconds. No jobs or broker source was
changed, and the 85-assertion real-engine proof file remains byte-for-byte
unchanged at SHA-256 `50f3ae8adf5b7b5c26dea07dc335a09128853f5481af6f7026bf39eb96b7ba99`.

## Integrated release-gate proof - 2026-09-12

The findings above describe the original audit and first delivery. Integration
`55b6a50` includes W10c, W11, W12, W15 and the W14 migration as `0027`. The
release-gate continuation starts at `c83c3e5`. It uses the retained engine at the
same pin, adapter `hermes@v2026.9.7+melete-observers.2`, through `bootstrap()` and
real HTTP with a scripted provider. No engine installation was needed.

The single strict test is `real Hermes capability chain: discovery, hooks,
learning, teammate context and revocation` in `capability-proof.test.ts`.
Each stage records its own evidence; the test fails for any failed stage or
missing implementation. The earlier release-gate strict run passed all five stages with
85 assertions in 208.62 seconds, no failures and no missing entries. Evidence is
`%TEMP%/melete-w14-capability-JAbcAJ/capability-evidence.json`, SHA-256
`899c68b5b6470201ea378e0c2e70306255c499e160a9a317634dfb1aa3e7fa31`.

| Capability | Status | Current evidence and limit |
|---|---|---|
| Dynamic tool discovery | implemented-and-tested | Real search/load, catalog continuation, one MCP call and a durable receipt. Dedicated HTTP connections fix the reproduced Windows Bun pool stall during the runtime stream. |
| MCP connect after session start | implemented-and-tested | The proof starts without a connection and installs through authenticated `POST /connections` during a running attempt. The same attempt discovers and calls the tool. |
| MCP disconnect recovery | implemented-and-tested | An expired HTTP session causes typed W12 repair, new initialization, one call and a receipt. HTTP and stdio fixtures prove bounded reconnect; acknowledgement loss remains unknown without replay. |
| Connection auth refresh and reconnect | implemented-and-tested | Real Hermes observes one sealed credential refresh and a receipt. Revocation stops dispatch and preserves an open question with `waiting_for_input`. Both transport fixtures cover refresh and grant loss during repair. |
| Lifecycle hooks | implemented-but-unverified | The real discovery stage passes session start/end and pre/post tool capture with 23 events. Recorded-stream and Python checks prove deduplication, replay, failure isolation and continuation identity. Actual compaction remains unverified. |
| Automatic skill selection | implemented-and-tested | Real member context selects alpha/beta/gamma, caps at three and excludes the private canary from the bundle and provider requests. |
| Correction, candidate, evaluation, promotion, rollback | implemented-and-tested | Real correction, bounded candidate generation, validation and sealed evaluation, private owner canary, activation and rollback. Both evaluation phases require held-out improvement without regression. |
| Teammate reuse of an evaluated shared skill | implemented-and-tested | A explicitly activates space delivery; B's different record task receives only the evaluated compiled procedure. Private delivery denies B before sharing. Public and other-space denial are also checked in `shared-procedure.test.ts`. |
| Revocation prevents subsequent use | implemented-and-tested | Revoking B cancels queued evaluated reuse, refuses selection and old capabilities, and dispatches no action. General shared-context tests additionally cover delivered-context invalidation and regrant fencing. |

### MCP ownership and uncertain outcomes

The operator route persists HTTP configuration, setup state and sealed
credentials, opens a worker and publishes its verified catalog after activation.
Service-issued principal-bound attempts can opt into signed
`live_connection_scopes`; explicitly restricted and legacy tokens retain fixed
scopes. Operator grants remain bounded by the existing principal, membership,
space, epoch, compartment and agent restrictions. Search and loaded schemas
cannot authorize a dispatch. Approval, intent keys, trust origin and declared
effect classes remain broker-owned.

Repair classifies only proved pre-dispatch failures, session termination and
explicit authentication refusal as retryable typed faults. Reconnect checks the
pinned catalog. W12 bounds attempts; refresh occurs once against the sealed,
operator-configured token endpoint and publishes a new sealed reference only if
the original grant remains current. A dropped acknowledgement is never replayed.
Revocation leaves an open question even if Hermes claims completion. Production
stdio launch remains disabled pending OS isolation; stdio repair is tested with
explicit fixtures.

### Evaluated sharing and private context

`POST /procedures/:id/activate` adds `scope: private | space`, default private.
The additive promotion record captures that choice and the authenticated
principal. The existing evaluated applicability object does not grant access.
Canary delivery stays private; space activation requires the origin shared-space
owner, validation and sealed evidence, and a completed private canary.

Selection checks current membership under the same authority lock used by
revocation, matching space, task applicability, model, runtime, body hash and
live evaluation evidence. Members receive only the verified compiled procedure
body. Episodes, corrections, evaluation records and job timelines remain private
to their principal. Revocation cancels queued reuse and fences previously
issued capabilities; rollback removes subsequent selection.

Both evaluation phases use three paired record tasks through real Hermes plus
scope and memory checks. The record baseline scores 1/3 and the candidate 3/3;
all evidence rows pass the promotion gate. The bounded provider derives output
from actual HTTP prompts and sees neither expected answers nor database state.
Private correction text is absent from the proposal, later member bundle and
provider requests. This establishes integration behavior with a fake provider,
not learning quality across real models.

The single locked full suite reached the 180-second budget with 1,312 passing
test lines, zero failing lines and 29 skips (exit 124, 180.75 seconds). It was
not rerun and is incomplete. Typecheck, lint, clean schema/OpenAPI/client
regeneration, 61 plugin tests and 19 Compose declaration checks pass.

The final evidence path, checksum, focused checks and full-suite command ledger
are in [REPORT.md](../../REPORT.md). Earlier red evidence in that
append-only report describes superseded runs. The current capability matrix is
[docs/CAPABILITIES.md](../../docs/CAPABILITIES.md).

## PR 27 verification - 2026-09-12

Commits `d752616` and `6d0d531` fix the migration timestamps and initialization
race respectively. Product changes are confined to the journal and connections
route. The proof and jobs/broker source remain unchanged.

- Focused command: `bun test apps/melete/test/integration/principals.test.ts apps/melete/test/integration/runtime-mcp-revocation.test.ts apps/melete/test/integration/runtime-mcp.test.ts --max-concurrency=1 --timeout=30000` passes 6 tests and 147 assertions in 25.85 seconds. The production integration-schema upgrade verifies all three columns and repeat-startup idempotence.
- `bun run typecheck` passes. `bun run lint` passes across 541 files with the pre-existing empty-import warning in `apps/melete/test/integration/postgres.ts`.
- `bun run openapi` and `bun run client:generate` both pass from a clean tree at `6d0d531`; `git diff --exit-code` and `git status --porcelain` confirm clean regeneration.
- `bun run test:plugin` passes all 61 tests in 25.42 seconds.

The first unchanged real-engine rerun failed after 67 assertions in 303.09
seconds. Its sealed evaluation records one `budget_exhausted` candidate attempt,
with no model result, after the existing 15-second wall-time budget. Another
lane held the shared test lock during that run. Evidence is retained at
`%TEMP%/melete-w14-capability-wHcsDT/capability-evidence.json`; no proof assertion,
fixture, model output or attempt budget was changed.

The unchanged proof was then rerun while holding the serialized test guard. It passes
all 85 assertions in 284.91 seconds, with every stage passed and empty failure
and missing lists. Evidence is
`%TEMP%/melete-w14-capability-trNDDu/capability-evidence.json`, SHA-256
`899e178f4d13e40ff0269176c3e2f5a600de65a6269fe9e6b6596a546c23ca5c`.
The proof source remains SHA-256
`50f3ae8adf5b7b5c26dea07dc335a09128853f5481af6f7026bf39eb96b7ba99`.

The full suite ran exactly once as `timeout 1200 bun test --max-concurrency=2`
under the owned serialized test guard. It completed in 303.62 seconds with 1,560 passes,
29 skips, one failure and 7,318 assertions across 152 files (exit 1). Both new
review regressions passed in that run. The ownership marker and lock directory
were removed, and inspection found no tracked test processes still running.
The result and stdout/stderr logs remain under
`%TEMP%/melete-w14-pr27-full-20260912.*`; its raw line counters include Bun's
repeated failure/skip summary, while the counts above use Bun's final summary.

The sole failure was `wired-assistant.test.ts:130`: the fixture changed the
singleton owner's email/password, but login reads its principal. Updating that
fixture principal reached a second stale expectation: the exact tool list must
include the integrated `search_tools`, `load_tool` and `react` verbs alongside
`test.send`. Only the fixture and its exact expected list changed. Its focused
command, `bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=1 --timeout=30000`,
then passed 52 assertions in 29.00 seconds through real Hermes. Typecheck and
lint pass after this test-only repair. The full suite was not repeated, so its
recorded result remains non-green despite the passing focused repair.
