# 0026 - Engine surface probes: what the pinned engine actually does

Status: recorded (executed probes; the engine configuration is unchanged)

## Problem

The engine-forward direction rests on a read of the pinned engine's source: that
compaction, native tools, skills, tool discovery and session resumption behave in
particular ways, and that a handful of keys in the shipped engine config either
do nothing or do something other than their name suggests. A source read
establishes an offered interface. It does not establish behaviour, and it cannot
say which claims survive contact with the code.

## Decision

`packages/runtime-hermes/tests/test_engine_surface.py` drives the pinned engine's
own functions against temporary engine homes and a loopback capture server. No
provider is contacted and no production code changes. Every probe that depends on
configuration is parametrized `shipped` against `target`: the `shipped` case
asserts what `packages/runtime-hermes/config/config.yaml` produces today, so the
file is green as it stands and records the gap.

The probes skip themselves with a clear reason when the engine is not importable,
so the default `bun run test:plugin` run (an isolated environment without it)
stays green. `bun run test:engine-surface` in `packages/runtime-hermes` runs them
with an interpreter that has the pinned engine, found from `MELETE_HERMES_PYTHON`,
`MELETE_HERMES_VENV`, or a `.hermes-venv` directory at the repository root; with
none of those it prints why it ran nothing. Nothing is wired into CI.

## Alternatives

- *Assert the source text instead of the behaviour.* A line-number assertion
  breaks on every upstream edit and still proves nothing about what runs.
- *Prove the same claims through the full container end-to-end path.* Slower by
  orders of magnitude, and a failure there does not say which layer was wrong.
  The compaction claim does need that path; it is a separate piece of work.
- *Change the engine config first and watch what breaks.* The point of the probes
  is to know the answer before the flip, not after it.

## Evidence

All results below are from executed probes, at the pinned engine release. Engine
paths are relative to that source tree.

### 1. The auxiliary compression client and the capability header — confirms

Asserted: the client the compaction summary call is issued on carries the
capability header only when the header sits in `model.extra_headers`.

`resolve_provider_client(provider=<gateway>, task="compression")`
(`agent/auxiliary_client.py:4832`) reaches the named-custom branch at `:4605`,
which builds the client at `:4595` `_named_custom_openai_wire_client`. That
function's only header source is `:825` `_apply_user_default_headers`, which reads
`model.default_headers` and `model.extra_headers` and nothing under
`providers.<name>`.

| Config | Header on the request the capture server received |
|---|---|
| shipped (`providers.<name>.extra_headers`, written at boot) | absent |
| target (`model.extra_headers`) | present, with the attempt value |

This confirms the design's first finding: "the summary request reaches the gateway
with no `x-melete-capability`". A provider-level copy is not enough, and keeping
the provider-level copy alongside the model-level one is harmless.

### 2. The tool-search bridge and a post-snapshot registration — confirms

Asserted: `tool_call` dispatches a tool registered after the definition snapshot,
in the same process, without a restart.

A tool was registered, `get_tool_definitions(..., skip_tool_search_assembly=True)`
was taken as the snapshot, a second tool was registered, and
`handle_function_call("tool_call", {"name": <second>, ...})` was issued. The second
tool's handler ran and returned its own result; the snapshot does not name it.
`model_tools.py:642` `_dispatch_bridge_tool` recomputes the catalog on every bridge
call, and the definition cache key at `:274` includes the registry generation.

This confirms the design's seventh finding, and with it the premise of the
discovery work: the stop-and-continue around `load_tool` is not required once the
bridge is on.

### 3. A registered terminal provider's `strip_env_keys` — refutes in part

Asserted: a registered terminal environment provider's `strip_env_keys` are
removed from the native terminal subprocess and from `execute_code` children.

A provider naming `MELETE_ATTEMPT_TOKEN`, `API_SERVER_KEY` and `MELETE_MODEL_KEY`
was registered through the real registry, with all three set in the process
environment.

| Child environment builder | Registered keys removed |
|---|---|
| `agent/terminal_env_registry.py:69` `plugin_strip_env_keys` | returns all three |
| `tools/environments/local.py:295` `_sanitize_subprocess_env` | yes |
| `tools/environments/local.py:302` `hermes_subprocess_env` | yes |
| `tools/environments/local.py:542` `_make_run_env` (the native terminal, used at `:783`) | **no** |
| `tools/code_execution_env.py:52` `_scrub_child_env` (`execute_code`) | all three, but not because of the registration |

`_make_run_env` is called with an empty plugin strip set, so the registration
never reaches a terminal command. `MELETE_ATTEMPT_TOKEN` and `MELETE_MODEL_KEY`
survive in the environment of a native terminal command. `API_SERVER_KEY` does not
survive, but only because it is already in the engine's own provider and gateway
blocklist — removing the registration does not bring it back.

`execute_code` never consults the registry at all. Its child environment is built
by an allowlist whose secret-substring block (`tools/code_execution_env.py:29`,
which names `KEY` and `TOKEN` among others) removes all three names with or
without any registration. A second probe with the registry reset confirms this.

So the design's twelfth finding holds for the generic spawn surfaces and is wrong
for the two surfaces it was written about. The plugin registration buys nothing
for `execute_code` and nothing for the native terminal. See "What must change"
below.

Honest limit, not probed: removing a name from a child environment does not hide
the value from code running as the same user, which can still read the parent
process's environment through the operating system.

### 4. Which memory and skills keys the engine reads — confirms, and refines

Asserted: `memory.enabled` and `skills.enabled` are not keys the engine reads;
`memory.memory_enabled` and `memory.user_profile_enabled` are.

| Config | `get_builtin_memory_store_flags` |
|---|---|
| shipped (`memory.enabled: false`) | `(True, True)` — both stores on |
| target (`memory.memory_enabled: false`, `memory.user_profile_enabled: false`) | `(False, False)` |

`skills.enabled: false` is likewise inert: a live `skill_manage` create under that
config still writes the skill (probe 6).

Refinement the design does not state: the two real flags decide whether a store is
constructed at all (`agent/agent_init.py:1266`). The store itself reads `MEMORY.md`
and `USER.md` from `HERMES_HOME/memories` regardless of its own flag values — a
store built with both flags false still loads both files into its live entry
lists. The flags are therefore the only switch; nothing downstream of construction
will keep a file out.

### 5. Bundled skills sync against a directory that does not exist — confirms

Asserted: pointing `HERMES_BUNDLED_SKILLS` at a directory that does not exist makes
the sync a no-op.

`sync_skills(quiet=True)` returned an empty result (`copied` and `updated` empty,
`total_bundled` zero) and did not create `HERMES_HOME/skills` at all
(`tools/skills_sync.py:371` returns before the directory is made). A control probe
with a populated override directory copied its one skill, so the no-op is the
override's doing.

### 6. `skill_manage` under and without the write-approval gate — confirms

Asserted: `skills.write_approval: true` stages to
`HERMES_HOME/pending/skills/<id>.json` and writes no live skill; without it, the
write lands live.

Under the gate, the call returned `{"success": true, "staged": true, "pending_id":
...}` and wrote exactly one pending record holding the replayable payload
(`action`, `name`, `content`). No skill package appeared.

Without the gate the write landed live. Recorded, because the owner's decision is
to let skills be written live behind guards, and those guards have to be built on
what the engine actually leaves behind:

**Where a live write lands and what it produces.** The package root is
`HERMES_HOME/skills/<name>/`, with `SKILL.md` holding the exact content supplied.
A `category` argument inserts a directory level (`skills/<category>/<name>/`), and
`skills.create_dir` moves the root elsewhere entirely
(`tools/skill_manager_tool.py:184`). A supporting file lands inside the same
package at the requested relative path, for example
`skills/<name>/references/note.md`. Beside the packages, the same skills directory
holds an append-only audit ledger, `skills/.curator_ledger.jsonl`, which gains one
JSON line per mutation carrying the action, the skill name, and before and after
file manifests.

**Which hook events fire around it.** One `on_skill_lifecycle` per successful
mutation (`tools/skill_usage.py:443`), with `action` `created` for a create and
`edited` for a supporting-file write, carrying `skill_name`, `provenance`,
`task_id` and `session_id`. Dispatched as a tool rather than called directly, the
write is bracketed by the generic pair: `pre_tool_call`, then the lifecycle hook,
then `post_tool_call` with `tool_name` `skill_manage`. So an observer sees the tool
name, the skill name and the timing, but not the content; anything that has to
decide on the content has to read the package or the ledger, or hold the write in
the pending directory.

### 7. The tool-loop hard stop on the API server platform — confirms

Asserted: the hard stop applies on this platform only when
`tool_loop_guardrails.hard_stop_enabled: true`.

| Config | `hard_stop_enabled` on `api_server` | on an unattended platform |
|---|---|---|
| shipped (no section) | `False` | `True` |
| `non_interactive_hard_stop_enabled: true` only | `False` | `True` |
| target (`hard_stop_enabled: true`) | `True` | `True` |

`agent/tool_guardrails.py:75` lists `api_server` as attended, so the
non-interactive promotion at `:134` never fires there. Warnings are on throughout.
This confirms the design's eighth finding.

### 8. How `agent.max_turns` resolves on the API server path — confirms

Asserted: unset means unlimited; 150 means 150.

The value the API server hands the agent is
`gateway/run.py:1559` `_current_max_iterations`, which re-bridges `agent.max_turns`
from config on every turn (`:1546` through `:1824`) and resolves it with
`hermes_cli/config.py:1843` `resolve_turn_limit`.

| Config | Resolved iteration ceiling |
|---|---|
| shipped (no `agent.max_turns`) | the unlimited sentinel (`sys.maxsize`) |
| target (`agent.max_turns: 150`) | `150` |

This confirms the design's fifth finding: there is no engine-side iteration limit
in production today.

### 9. The compaction trigger arithmetic — refines

Asserted: the executed trigger for three context windows at the default `0.50`
threshold, the sub-512K floor, and the effect of an absolute cap.

| Window | Effective threshold | Trigger (tokens) | Summary target | Lean tail |
|---|---|---|---|---|
| 64,000 | 0.75 | **54,400** | 3,200 | 10,000 |
| 128,000 | 0.75 | 96,000 | 6,400 | 10,000 |
| 1,000,000 | 0.50 | 500,000 | 10,000 | 25,000 |

With `compression.threshold_tokens: 200000` on the million-token window the
trigger becomes 200,000. A cap of 900,000 on the same window leaves the trigger at
500,000: the cap only ever lowers it. A cap of 40,000 on a 128K window binds at
40,000, below the floored trigger.

The refinement is the first row. At a 64K window the trigger is 85% of the window,
not 75%: the percentage lands below the 64K minimum, the minimum becomes the
binding term, and the engine then caps it at 85% of the budget
(`agent/context_compressor.py:2223`). Any statement of the form "the engine
triggers at 75% of a sub-512K window" is exact at 128K and wrong at 64K. This
matters wherever a rendered `model.context_length` sits at or near the 64K
minimum — including the forced-compaction test, which renders exactly 64,000.

### 10. Rehydration by session id against a body-supplied history — confirms

Asserted: loading a session's history by id preserves tool calls, while a
`conversation_history` in the request body strips them.

A session was seeded with a user message, an assistant message carrying one tool
call, the matching tool result, and a closing assistant message.
`get_messages_as_conversation` (`hermes_state_messages.py:740`) returned all four
rows with the assistant row's `tool_calls` intact and the tool row's
`tool_call_id` and `tool_name` present. The same four messages handed to
`_resolve_conversation_history` (`gateway/platforms/api_server_runs.py:248`) as a
`conversation_history` body field came back as three objects with exactly the keys
`role` and `content` — the coercion at `:266`. This confirms the design's tenth
finding.

## What must change in the direction before the engine configuration is flipped

1. **Secret scrubbing for native tools is not a plugin registration.** Registering
   a terminal environment provider whose `strip_env_keys` names the attempt
   secrets does not remove them from a native terminal command's environment, and
   `execute_code` already removes them without any registration. The planned
   mechanism, and the test written against it, need replacing. The options that do
   work: keep the attempt-scoped values out of the engine process environment
   altogether and pass them another way; or rely on the engine's own
   secret-substring and blocklist coverage, which already claims `API_SERVER_KEY`
   and every `execute_code` child. A registration remains worth keeping for the
   generic spawn surfaces, but it must not be described as the boundary.
2. **The capability is in a file the cell can read.** The target configuration
   writes the attempt capability into `model.extra_headers` in the engine home's
   config file, which is writable — and therefore readable — by the cell's own
   user. An environment scrub does not change that. Whatever replaces item 1 has
   to account for the file, or the attempt capability has to stop being a secret
   from the cell and be treated as a metered, fenced credential that the broker
   already bounds.
3. **The 75% figure is wrong at the 64K minimum.** Any rendering that derives a
   threshold, or a gateway body limit intended to sit above it, must use 85% of
   the window at 64K. The forced-compaction test's own rendered window is the case
   that hits this.
4. **`skills.enabled` deserves the same note as the memory keys.** The direction
   names the two memory keys as the switches that are not read; the skills key is
   inert in exactly the same way and is still in the shipped config.

## How to run

```sh
cd packages/runtime-hermes
MELETE_HERMES_PYTHON=<interpreter with the pinned engine> bun run test:engine-surface
```

The default `bun run test:plugin` collects the same file and skips it, naming the
missing engine as the reason.
