# 0009 - The Hermes surface at the pin, measured

Status: accepted
Date: 2026-09-11

Everything below was read from a checkout of `v2026.9.7` and, where it says
measured, produced by running the release's own functions. The tag resolves to
commit `2237be355906fbe6065ce1815711eee52b2d646e` (`chore: release v0.21.1
(2026.9.7)`), which is what the image label must record. `77e55b4` in note 0002
is the `main` HEAD the approval probe ran against on 2026-09-10, not the tag.

Line numbers are from that tag. The checkout lives at `.hermes-src/` and the
virtualenv at `.hermes-venv/`; both are gitignored and neither is vendored.

## Verdict

The tripwire does not fire. Built-in toolsets can be disabled, every route
Melete needs exists, and the thin scaffolding measures **3,304 tokens**, under
the 4,000 budget. The lane continues on Hermes.

## The plugin surface

`register(ctx)` is the entry point for a general plugin. `plugins/AGENTS.md`
lists the discovery roots: `plugins/<name>/` in the tree, `$HERMES_HOME/plugins/`,
`./.hermes/plugins/` (opt-in), and `hermes_agent` pip entry points, later-wins.
Melete ships into `$HERMES_HOME/plugins/melete/`, which needs no tree changes.

`hermes_cli/plugins.py:449` is the registrar:

```python
def register_tool(
    self, name: str, toolset: str, schema: dict, handler: Callable,
    check_fn: Callable | None = None, requires_env: list | None = None, is_async: bool = False,
    description: str = "", emoji: str = "", override: bool = False,
) -> Optional[PluginRegistration]:
```

`override=True` needs `plugins.entries.<id>.allow_tool_override` and is refused
otherwise (`hermes_cli/plugins.py:463`). Melete never overrides: broker tool
names are dotted (`email.send`) and collide with nothing built in.

`PluginContext` is defined at `hermes_cli/plugins.py:214`. The plugin imports
nothing else from Hermes, so the compat window that closes on 2026-09-14
(`plugins/AGENTS.md`, "Sep 2026 decomposition compat window") cannot touch it.
`plugins.allow_deprecated_imports` stays false, which is the default
(`hermes_cli/config_defaults.py`).

### The enabling key is `plugins.enabled`, and it is a list

The W0 README described `plugins.allow: ["melete"]`. That key does not exist.
`hermes_cli/plugins_discovery.py:91` reads `plugins.enabled` as an allow-list of
path-derived registry keys, and `:80` reads `plugins.disabled` as a deny-list
that wins over it. A boolean `plugins.enabled: true` silently loads nothing: the
first probe run registered zero tools until the key was corrected.

## Turning the built-ins off

`gateway/platforms/api_server.py:2122` builds every API-server agent with

```python
enabled_toolsets = sorted(_get_platform_tools(user_config, "api_server"))
```

`hermes_cli/tools_config.py:550` resolves that from `platform_toolsets.<platform>`,
falling back to the platform default when the key is absent
(`hermes_cli/platforms.py:35` maps `api_server` to `hermes-api-server`, defined at
`toolsets.py:188` as the core tool list minus TTS, clarify and computer use).
An explicitly saved list replaces the default, and `:567` records that plugin
toolsets are first-class on such a list.

So the whole switch is one key:

```yaml
platform_toolsets:
  api_server: [melete]
```

Measured: `_get_platform_tools` returns exactly `{"melete"}`, and
`model_tools.get_tool_definitions` over it returns the six stub broker tools and
nothing else. The same call over the default returns 23 tools on this machine.

`agent.disabled_toolsets` exists as a global end-of-pipeline subtraction
(`hermes_cli/tools_config.py:591`) but is not needed once the platform list is
explicit, and it is left empty so it cannot mask a future mistake.

### One more switch is required: the tool-search bridge

With `platform_toolsets.api_server: [melete]` alone, the model does not see the
six tools. It sees `tool_search`, `tool_describe` and `tool_call`. Plugin tools
are "deferrable" and Hermes collapses them behind that bridge whenever any
deferrable tool exists (`hermes_cli/config_defaults.py:1789`, default
`tools.tool_search.enabled: "auto"`; the assembly is at `model_tools.py:465`).

That is the wrong shape for Melete. The broker already filters the catalog by
the job's scopes, the architecture caps it at 15 tools, and a search bridge adds
a round trip before the model can call anything. The config is:

```yaml
tools:
  tool_search:
    enabled: "off"
```

Measured: with the bridge on, three tools and 661 tokens of schema. With it off,
six tools and 377 tokens. This is the only non-obvious line in the thin config.

## Config keys

| Key | Effect | Citation |
|---|---|---|
| `platform_toolsets.api_server` | the only toolsets the API server agent gets | `gateway/platforms/api_server.py:2122`, `hermes_cli/tools_config.py:550` |
| `plugins.enabled` | allow-list of plugin keys; a list, never a boolean | `hermes_cli/plugins_discovery.py:91` |
| `tools.tool_search.enabled: "off"` | present the tools directly instead of behind a search bridge | `hermes_cli/config_defaults.py:1792` |
| `approvals.timeout` | 300 by default; how long a shell-command approval blocks | `hermes_cli/config_defaults.py:1535` |
| `approvals.unattended_mode` | `deny` by default, which is what an unanswered `api_server` approval does | `hermes_cli/config_defaults.py:1538` |
| `model.provider` / `model.base_url` / `model.api_key` | `custom` is the profile with no fixed key and a user-set endpoint | `plugins/model-providers/custom/__init__.py:65`, `hermes_cli/runtime_provider.py:73` |
| `API_SERVER_HOST` / `API_SERVER_PORT` | bind; defaults `127.0.0.1` and `8642` | `gateway/platforms/api_server.py:1107`, `hermes_cli/config_defaults.py:2761` |
| `API_SERVER_ENABLED` / `API_SERVER_KEY` | turn the platform on inside the gateway and require a bearer | `hermes_cli/web_server_messaging.py:191` |

`skip_memory` and `skip_context_files` are **AIAgent constructor arguments**
(`agent/agent_init.py:2204`), not config keys, and
`gateway/platforms/api_server.py:2087` does not pass either. There is no
`platform_toolsets`-style key that reaches them on the `/v1/runs` path;
`gateway.platforms.<plat>.skip_context_files` (`gateway/run_turn_runner.py:847`)
belongs to the messaging turn runner, not the API server. Melete therefore
reaches the same end by configuration rather than by argument: the memory flags
plus keeping `memory` out of the toolset list, and an image whose working
directory holds no `SOUL.md`, `AGENTS.md`, `CLAUDE.md`, `.hermes.md` or
`.cursorrules` for `_context_files_part` (`agent/system_prompt.py:585`) to find.

**Superseded on this point.** `memory.enabled` is not a key the engine reads:
executed probes showed both built-in stores still on with it set to false. The
keys are `memory.memory_enabled` and `memory.user_profile_enabled`, and the
configuration now sets those. See
[note 0026](0026-engine-forward.md) and
`test_memory_flags_are_read_from_the_real_keys`.
The measurement below confirms the context tier is empty in that arrangement.

## The HTTP routes

`gateway/platforms/api_server_runs.py:101`:

```python
("POST", "/v1/runs", self._handle_runs), ("GET", "/v1/runs/{run_id}", self._handle_get_run),
("GET", "/v1/runs/{run_id}/events", self._handle_run_events),
("POST", "/v1/runs/{run_id}/approval", self._handle_run_approval),
("POST", "/v1/runs/{run_id}/steer", self._handle_steer_run),
("POST", "/v1/runs/{run_id}/stop", self._handle_stop_run)]
```

`GET /v1/capabilities` is registered at `gateway/platforms/api_server.py:1503`
and handled at `:2232`. Every route Melete needs is present, plus `steer`, which
Melete does not use: a mid-run instruction that never reached the ledger is
exactly the untracked side channel the broker exists to prevent.

### Durable idempotency

`features.runs_idempotency` in the capabilities body comes from
`gateway/platforms/api_server_runs.py:108`:

```python
return {
    "supported": True,
    "durable": self._run_idempotency_store.durable,
    "retention_seconds": store_type.RETENTION_SECONDS}
```

`durable` is `self._db_path is not None`
(`gateway/platforms/api_server_run_idempotency.py:62`), false when the SQLite
file cannot be opened and the store falls back to process memory (`:79`).
Retention is 24 hours. The reservation is a unique `(scope, key)` row inserted
inside `BEGIN IMMEDIATE`, so two workers cannot both admit one `POST /v1/runs`.

The adapter refuses to start when `durable` is false. Without it a restart
between the POST and the receipt turns a retry into a second run, and a second
run is a second set of effects.

`Idempotency-Key` is read at `gateway/platforms/api_server_runs.py:372`. Melete
sends the attempt id.

### Events

The stream is an in-memory `asyncio.Queue` per run
(`gateway/platforms/api_server_runs.py:154`, `:688`, `:707`) with a 30 second
read timeout and no replay: nothing stores past events for a reconnecting
consumer. `TERMINAL_STATUSES` is `{"completed", "failed", "cancelled",
"interrupted"}` (`api_server_run_idempotency.py:17`), and a non-terminal run
whose owner process is gone is reported against `_owner_alive`
(`api_server_runs.py:236`). Both facts land in the adapter as: consume once,
never reconnect for history, and treat `interrupted` or a dropped stream as a
failed attempt with a gap event rather than a completion.

## The approval gate stays unused

`tools/approval_context.py:134`:

```python
_UNATTENDED_APPROVAL_PLATFORMS = frozenset({"webhook", "msgraph_webhook", "api_server"})
```

`gateway/run.py:5129` sets `HERMES_EXEC_ASK=1` inside `start_gateway()`, which is
why note 0002's probe saw the notifier fire. That path covers the shell-command
guard only. Melete's tools are plugin tools whose approvals hard-deny on an
unattended platform, so Melete does not route approval through Hermes at all:
the broker tool returns a structured `needs_approval` result, the run ends, and
the job parks on Melete's ledger where the decision is recorded with the payload
hash it was shown against. The image still sets `HERMES_EXEC_ASK=1` so that a
shell command, if one ever appears, surfaces rather than silently denying.

## Measured: the thin scaffolding

The figures below came from a one-off measurement script, kept outside the
repository. It built a temporary `HERMES_HOME` with a six-tool stub plugin and
this configuration, then called the release's own
`hermes_cli.tools_config._get_platform_tools`,
`model_tools.get_tool_definitions`, and
`agent.system_prompt.build_system_prompt` on a real `AIAgent`. Tokens are
chars/4, the same estimator the gateway's metering uses.

| | tools | tool schemas | system prompt | total |
|---|---|---|---|---|
| default `hermes-api-server` on this machine | 23 | 8,766 tok | 3,150 tok | **11,916 tok** |
| thin, no identity | 6 | 377 tok | 2,715 tok | **3,093 tok** |
| thin + Melete identity | 6 | 377 tok | 2,926 tok | **3,304 tok** |

The identity file is 843 chars, 210 tokens, inside the 250-token contract.

The first run of this probe registered its stubs with a bare JSON Schema as
`schema=`, which is the wrong shape. `tools/registry.py:774` builds the
definition as `{**entry.schema, "name": entry.name}`, so what is passed there is
the OpenAI function body, and a bare schema produces a definition with no
`parameters` key at all. That understated the thin figure by 28 tokens and the
default by 29. The table is from the corrected run, and
`melete_plugin.tool_schema` produces the shape the corrected run used.

Two things the numbers say that the plan did not.

The 23-tool default is not the 37 tools the plan expected, and 8,766 tokens is
not 13,900. Roughly a dozen built-ins are gated off on this machine by their
`check_fn`s: no provider keys, no browser, no vision dependencies. The default
figure here is therefore a floor, and the real saving in a container with
everything available is larger than the table shows. The thin figure is not
affected: it contains no built-ins at all.

The remaining 2,926 tokens are almost entirely Hermes's own prose, not Melete's.
`build_system_prompt_parts` returns three tiers and the thin run measures
stable 9,059 chars, context 842, volatile 1,801. The context tier is exactly the
identity: no context file was found, which is the `skip_context_files` behaviour
obtained without the argument. The stable tier is the Hermes preamble ("You are
Hermes Agent, built by Nous Research...") plus guidance blocks, and the volatile
tier is the timestamp and runtime environment hints.

That matters for how the identity is delivered. `ephemeral_system_prompt` is
**appended** into the context tier (`agent/system_prompt.py:638`), not
substituted for the preamble. Melete's identity is additive, and a run always
carries roughly 2,700 tokens of Hermes voice underneath it. Inside the 4,000
budget, so the lane proceeds, but it is the honest reason the scaffolding cannot
go much below 3,000 on this engine, and it is the first thing a native loop
would recover.

## What is not established here

The measurement is of assembly, not of a live request. The number the real
server puts on the wire is recorded separately in `REPORT.md` from the
end-to-end run. Nothing here was built as a container: this machine has no
Docker.
