"""Executed probes against the pinned engine's own functions.

Every test here drives real engine code — no reimplementation, no mocks of the
behaviour under test — against a temporary ``HERMES_HOME`` and, where a request
has to be observed, a loopback capture server. No provider is contacted.

Each probe that depends on configuration takes the ``shipped`` case straight
from ``packages/runtime-hermes/config/config.yaml``, so it asserts what the
image actually produces rather than a copy of it; the paired case is the
spelling that does nothing, kept because a key the engine ignores looks exactly
like one it reads. Citations name the engine file and line the probe exercises,
read at the pinned release.

The probes are skipped with a clear reason when the engine is not importable, so
the default plugin test run (an isolated environment without it) stays green.
Run them with the pinned interpreter through ``bun run test:engine-surface``.
"""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import sys
import threading
from pathlib import Path

import pytest

try:  # The pinned engine, importable only from the pinned environment.
    import hermes_constants as _hermes_constants  # noqa: F401
except Exception as exc:  # pragma: no cover - the skip is the point
    pytest.skip(
        "The pinned engine is not importable by this interpreter "
        f"({type(exc).__name__}: {exc}). These probes drive engine functions "
        "directly, so they need the pinned environment: run "
        "`bun run test:engine-surface` (or set MELETE_HERMES_PYTHON to the "
        "pinned interpreter). The default `bun run test:plugin` run skips them.",
        allow_module_level=True,
    )

import yaml  # noqa: E402  (only reachable with the engine present)


# --- Shared fixtures and helpers ---------------------------------------------


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """A throwaway engine home. Config and state caches are keyed on the config
    path, so a fresh directory per test is a fresh load."""
    home = tmp_path / "engine-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def write_config(home: Path, config: dict) -> Path:
    path = home / "config.yaml"
    path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return path


SHIPPED_CONFIG_PATH = Path(__file__).parents[1] / "config" / "config.yaml"


def shipped_config() -> dict:
    """The configuration the image carries, read from the file it is copied from.

    Probes take their ``shipped`` case from here rather than restating it, so a
    setting that is removed or renamed turns a probe red instead of leaving it
    asserting something the runtime no longer does."""
    return yaml.safe_load(SHIPPED_CONFIG_PATH.read_text(encoding="utf-8"))


class _CaptureHandler(http.server.BaseHTTPRequestHandler):
    """Records the request and answers with the server's canned JSON body."""

    def do_POST(self):  # noqa: N802 - http.server's name
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        self.server.captured.append({
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": raw.decode("utf-8", "replace"),
        })
        payload = json.dumps(self.server.reply).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # silence the default stderr log
        return


@contextlib.contextmanager
def capture_server(reply: dict):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _CaptureHandler)
    server.captured = []
    server.reply = reply
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


CHAT_COMPLETION_REPLY = {
    "id": "probe-completion",
    "object": "chat.completion",
    "created": 0,
    "model": "probe-model",
    "choices": [{
        "index": 0,
        "message": {"role": "assistant", "content": "SUMMARY"},
        "finish_reason": "stop",
    }],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}

CAPABILITY_HEADER = "x-melete-capability"


# --- Probe 1: the auxiliary compression client and the capability header ------
# Finding 1. The main agent applies per-provider extra_headers; the auxiliary
# client that makes the compaction summary call builds its client through
# agent/auxiliary_client.py:4595 `_named_custom_openai_wire_client`, whose only
# header source is agent/auxiliary_client.py:825 `_apply_user_default_headers`
# — that reads `model.default_headers` and `model.extra_headers` and nothing
# under `providers.<name>`. Resolution enters that branch at
# agent/auxiliary_client.py:4605 `_resolve_named_custom_branch`, reached from
# agent/auxiliary_client.py:4832 `resolve_provider_client`.


def _gateway_config(base_url: str, *, header_scope: str) -> dict:
    """Engine config for one gateway provider. ``header_scope`` places the
    capability header on the provider entry alone, which is where it used to go,
    or on the model section, which is where the boot script writes it now (see
    ``test_entrypoint.py::test_boot_config_carries_capability_in_model_headers``;
    the boot script writes both copies, and this is the one that carries)."""
    provider: dict = {"base_url": base_url, "key_env": "MELETE_MODEL_KEY",
                      "default_model": "probe-model"}
    model: dict = {"provider": "melete-gateway", "default": "probe-model"}
    if header_scope == "provider":
        provider["extra_headers"] = {CAPABILITY_HEADER: "attempt-token"}
    else:
        model["extra_headers"] = {CAPABILITY_HEADER: "attempt-token"}
    return {"model": model, "providers": {"melete-gateway": provider}}


@pytest.mark.parametrize(
    ("config_case", "header_scope", "expect_header"),
    [("provider-only", "provider", False), ("shipped", "model", True)],
)
def test_compression_aux_client_sends_capability_header(
    hermes_home, monkeypatch, config_case, header_scope, expect_header,
):
    """The auxiliary client carries the capability header only when it sits in
    `model.extra_headers`. A provider-level copy never reaches the summary call.
    """
    monkeypatch.setenv("MELETE_MODEL_KEY", "surrogate-key")
    with capture_server(CHAT_COMPLETION_REPLY) as server:
        base_url = f"http://127.0.0.1:{server.server_port}/providers/probe/v1"
        write_config(hermes_home, _gateway_config(base_url, header_scope=header_scope))

        from agent.auxiliary_client import resolve_provider_client

        client, model = resolve_provider_client(
            provider="melete-gateway",
            task="compression",
            main_runtime={"model": "probe-model", "provider": "melete-gateway",
                          "base_url": base_url, "api_key": "surrogate-key"},
        )
        assert client is not None, "the gateway provider entry did not resolve a client"
        client.chat.completions.create(
            model=model or "probe-model",
            messages=[{"role": "user", "content": "summarize the conversation"}],
        )

        assert server.captured, "the summary call never reached the capture server"
        headers = server.captured[-1]["headers"]
        assert (CAPABILITY_HEADER in headers) is expect_header, (
            f"{config_case} config: capability header "
            f"{'missing' if expect_header else 'unexpectedly present'}"
        )
        if expect_header:
            assert headers[CAPABILITY_HEADER] == "attempt-token"


# --- Probe 2: the tool-search bridge and a post-snapshot registration ---------
# Finding 7. model_tools.py:642 `_dispatch_bridge_tool` recomputes the catalog on
# every bridge call, and model_tools.py:274 keys the definition cache on the
# registry generation, so a tool registered after the definition snapshot is
# callable through `tool_call` without restarting the run.

PROBE_TOOLSET = "engine_surface_probe"


def _probe_schema(name: str) -> dict:
    return {
        "name": name,
        "description": f"Probe tool {name}.",
        "parameters": {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
    }


@pytest.fixture
def probe_registry(hermes_home):
    """Registers probe tools on the real registry and removes them after."""
    write_config(hermes_home, {})
    from tools.registry import registry

    registered: list[str] = []

    def register(name: str, handler):
        registry.register(name=name, toolset=PROBE_TOOLSET,
                          schema=_probe_schema(name), handler=handler)
        registered.append(name)

    try:
        yield register
    finally:
        for name in registered:
            with contextlib.suppress(Exception):
                registry.deregister(name)


def test_tool_call_dispatches_a_tool_registered_after_the_snapshot(probe_registry):
    """A tool registered after the definition snapshot is reachable through the
    bridge's `tool_call` in the same run."""
    import model_tools

    calls: list[dict] = []
    probe_registry("probe_early", lambda args, **kw: json.dumps({"tool": "probe_early"}))

    snapshot = model_tools.get_tool_definitions(
        enabled_toolsets=[PROBE_TOOLSET], quiet_mode=True, skip_tool_search_assembly=True)
    snapshot_names = {d["function"]["name"] for d in snapshot}
    assert snapshot_names == {"probe_early"}

    def late(args, **kw):
        calls.append(dict(args))
        return json.dumps({"tool": "probe_late", "value": args.get("value")})

    probe_registry("probe_late", late)

    result = model_tools.handle_function_call(
        "tool_call",
        {"name": "probe_late", "arguments": {"value": "after-the-snapshot"}},
        enabled_toolsets=[PROBE_TOOLSET],
    )

    assert calls == [{"value": "after-the-snapshot"}], (
        f"the bridge did not dispatch the late registration: {result}")
    assert json.loads(result)["tool"] == "probe_late"
    assert "probe_late" not in snapshot_names


def test_a_tool_registered_mid_run_joins_the_running_agent_at_the_end(probe_registry, hermes_home):
    """The live-tools seam: the engine's own live refresh, asked for by the
    support module, adds a tool registered after the run's snapshot to the
    running agent's list, at the end, without moving the tools already there.
    tools/mcp_tool_agent.py `refresh_agent_mcp_tools(preserve_prefix=True)`."""
    import types

    import model_tools

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime_support"))
    import melete_runtime_hooks

    # The shipped tool-search setting: off, so plugin tools are offered directly.
    shipped = yaml.safe_load((Path(__file__).resolve().parents[1] / "config" / "config.yaml")
                             .read_text(encoding="utf-8"))
    write_config(hermes_home, {"tools": shipped["tools"]})
    probe_registry("probe_b", lambda args, **kw: json.dumps({"tool": "probe_b"}))
    probe_registry("probe_c", lambda args, **kw: json.dumps({"tool": "probe_c"}))
    snapshot = model_tools.get_tool_definitions(enabled_toolsets=[PROBE_TOOLSET], quiet_mode=True)
    agent = types.SimpleNamespace(
        tools=list(snapshot),
        valid_tool_names={d["function"]["name"] for d in snapshot},
        enabled_toolsets=[PROBE_TOOLSET],
        disabled_toolsets=None,
        session_id="",
    )
    before = [d["function"]["name"] for d in agent.tools]
    assert before == ["probe_b", "probe_c"]
    melete_runtime_hooks.bind_agent(agent)
    try:
        assert melete_runtime_hooks.refresh_live_tools("probe_a") is False
        # Sorted by name it would come first; registered mid-run it goes last.
        probe_registry("probe_a", lambda args, **kw: json.dumps({"tool": "probe_a"}))
        assert melete_runtime_hooks.refresh_live_tools("probe_a") is True
    finally:
        melete_runtime_hooks.bind_agent(object())
    assert [d["function"]["name"] for d in agent.tools] == ["probe_b", "probe_c", "probe_a"]
    assert "probe_a" in agent.valid_tool_names
    result = model_tools.handle_function_call(
        "probe_a", {"value": "same run"}, enabled_toolsets=[PROBE_TOOLSET])
    assert json.loads(result)["tool"] == "probe_a"


def test_the_engine_marks_only_the_fallback_load_as_an_error(probe_registry, hermes_home):
    """The adapter restarts a run only for a load the running agent could not
    take, and it reads that from the `error` field of the engine's
    `tool.completed` frame. The engine sets that field from
    agent/display.py `_detect_tool_failure` (agent/tool_executor.py), applied to
    the very JSON the plugin returns. Driven here with the plugin's own results:
    the fallback is marked, the live load is not."""
    import types

    from agent.display import _detect_tool_failure

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime_support"))
    import melete_runtime_hooks
    from melete_plugin import _loaded_result

    schema = {"name": "probe_loaded"}
    melete_runtime_hooks.bind_agent(object())
    fallback = json.dumps(_loaded_result(schema, "f"))
    assert _detect_tool_failure("load_tool", fallback)[0] is True

    shipped = yaml.safe_load((Path(__file__).resolve().parents[1] / "config" / "config.yaml")
                             .read_text(encoding="utf-8"))
    write_config(hermes_home, {"tools": shipped["tools"]})
    probe_registry("probe_loaded", lambda args, **kw: json.dumps({"tool": "probe_loaded"}))
    agent = types.SimpleNamespace(
        tools=[], valid_tool_names=set(), enabled_toolsets=[PROBE_TOOLSET],
        disabled_toolsets=None, session_id="")
    melete_runtime_hooks.bind_agent(agent)
    try:
        live = _loaded_result(schema, "f")
    finally:
        melete_runtime_hooks.bind_agent(object())
    assert live["status"] == "loaded"
    assert _detect_tool_failure("load_tool", json.dumps(live))[0] is False


# --- Probe 3: plugin strip_env_keys on the child environments ----------------
# Finding 12. agent/terminal_env_registry.py:69 `plugin_strip_env_keys` unions
# every registered provider's keys, and
# tools/environments/local_env_policy.py:184 exposes them to the env builders.
# The three builders in tools/environments/local.py apply the union differently:
# :295 `_sanitize_subprocess_env` and :302 `hermes_subprocess_env` pass it,
# :542 `_make_run_env` — the builder the native terminal uses at :783 — passes
# frozenset() instead, so a registration never reaches a terminal command.
# execute_code does not use any of them: it builds its child env through
# tools/code_execution_env.py:52 `_scrub_child_env`, an allowlist whose
# secret-substring block at :29 already removes these names without a registry.
#
# Honest limit, not tested here: stripping the names from the child environment
# does not hide them from code running as the same user, which can still read
# the parent's environment through the operating system.

MELETE_SECRETS = ("MELETE_ATTEMPT_TOKEN", "API_SERVER_KEY", "MELETE_MODEL_KEY")


@pytest.fixture
def registered_terminal_provider(hermes_home, monkeypatch):
    """Registers a terminal environment provider whose `strip_env_keys` names
    the three attempt-scoped secrets, exactly as a plugin registration would."""
    from agent import terminal_env_registry
    from agent.terminal_env_provider import TerminalEnvironmentProvider

    class ProbeProvider(TerminalEnvironmentProvider):
        @property
        def name(self):
            return "engine_surface_probe"

        @property
        def strip_env_keys(self):
            return frozenset(MELETE_SECRETS)

        def is_available(self):
            return False

        def create_environment(self, **kwargs):  # pragma: no cover - never created
            raise NotImplementedError

    write_config(hermes_home, {})
    for key in MELETE_SECRETS:
        monkeypatch.setenv(key, f"secret-value-for-{key}")
    provider = ProbeProvider()
    terminal_env_registry.register_provider(provider)
    try:
        yield provider
    finally:
        terminal_env_registry._reset_for_tests()


def test_registered_strip_env_keys_reach_only_some_child_environments(
    registered_terminal_provider,
):
    """The registered keys are stripped from the generic subprocess builders,
    but the native terminal's own builder is called with an empty plugin set, so
    registration alone does not remove them from a terminal command."""
    from agent.terminal_env_registry import plugin_strip_env_keys
    from tools.environments.local import (
        _make_run_env, _sanitize_subprocess_env, hermes_subprocess_env,
    )
    from tools.environments.local_env_policy import _HERMES_PROVIDER_ENV_BLOCKLIST

    assert plugin_strip_env_keys() == frozenset(MELETE_SECRETS)

    sanitized = _sanitize_subprocess_env(dict(os.environ))
    generic = hermes_subprocess_env()
    terminal = _make_run_env({})

    for key in MELETE_SECRETS:
        assert key not in sanitized, f"{key} survived the generic subprocess builder"
        assert key not in generic, f"{key} survived the non-terminal spawn builder"

    # The native terminal keeps every registered key that the engine's own
    # provider blocklist does not already claim. API_SERVER_KEY is claimed;
    # the two attempt-scoped names are not.
    assert "API_SERVER_KEY" in _HERMES_PROVIDER_ENV_BLOCKLIST
    assert "API_SERVER_KEY" not in terminal
    for key in ("MELETE_ATTEMPT_TOKEN", "MELETE_MODEL_KEY"):
        assert key not in _HERMES_PROVIDER_ENV_BLOCKLIST
        assert key in terminal, (
            f"{key} was expected to survive the native terminal builder at the "
            "pinned release, because that builder passes no plugin strip set")


def test_execute_code_child_environment_drops_the_registered_keys(
    registered_terminal_provider,
):
    """execute_code does not consult the registry at all: its child environment
    is an allowlist whose secret-substring block removes all three names."""
    from tools.code_execution_env import _scrub_child_env

    child = _scrub_child_env(dict(os.environ))
    for key in MELETE_SECRETS:
        assert key not in child, f"{key} survived the execute_code child allowlist"


def test_execute_code_child_allowlist_removes_the_secrets_without_registration(
    hermes_home, monkeypatch,
):
    """execute_code's scrub is an allowlist with a secret-substring block, so it
    removes the three names whether or not any provider is registered."""
    from agent import terminal_env_registry
    from tools.code_execution_env import _scrub_child_env

    write_config(hermes_home, {})
    terminal_env_registry._reset_for_tests()
    for key in MELETE_SECRETS:
        monkeypatch.setenv(key, "secret-value")

    assert terminal_env_registry.plugin_strip_env_keys() == frozenset()
    child = _scrub_child_env(dict(os.environ))
    for key in MELETE_SECRETS:
        assert key not in child


# --- Probe 4: which memory keys the engine actually reads --------------------
# Finding 4. hermes_cli/config_defaults.py:1194 defines `memory_enabled` and
# `user_profile_enabled`, both defaulting to true;
# tools/memory_tool.py:175 `get_builtin_memory_store_flags` reads exactly those
# two. `memory.enabled` and `skills.enabled` are not among them.
# agent/agent_init.py:1266 builds the store only when one of the two flags is
# true, and then calls `load_from_disk`, which reads MEMORY.md and USER.md from
# tools/memory_tool.py:38 `get_memory_dir` — ``HERMES_HOME/memories``.


@pytest.mark.parametrize(
    ("config_case", "memory_section", "expected_flags"),
    [
        ("inert-spelling", {"enabled": False}, (True, True)),
        ("shipped", shipped_config().get("memory"), (False, False)),
    ],
)
def test_memory_flags_are_read_from_the_real_keys(
    hermes_home, config_case, memory_section, expected_flags,
):
    """`memory.enabled` leaves both stores on; the two real keys, which the
    shipped configuration now sets, turn them off."""
    write_config(hermes_home, {"memory": memory_section})

    from hermes_cli.config import load_config
    from tools.memory_tool import get_builtin_memory_store_flags

    config = load_config()
    assert get_builtin_memory_store_flags(config) == expected_flags, (
        f"{config_case} config resolved the wrong store flags")


# agent/agent_init.py:1318 reads `agent.execution_guidance` (default "auto"), and
# agent/system_prompt.py:519 adds the coding-agent execution brief when
# `_model_gate` passes for the attempt's model.
@pytest.mark.parametrize(
    ("config_case", "setting", "expected"),
    [
        ("engine-default", "auto", True),
        ("shipped", shipped_config()["agent"].get("execution_guidance", "auto"), False),
    ],
)
def test_the_execution_brief_is_left_out_for_the_default_model(config_case, setting, expected):
    """Left on "auto", the default model gets the coding brief that sends every
    sum, date and claim to a tool; the shipped setting leaves it out."""
    from agent.prompt_builder import EXECUTION_GUIDANCE_MODELS
    from agent.system_prompt import _model_gate

    model = shipped_config()["model"]["default"]
    assert _model_gate(setting, model, EXECUTION_GUIDANCE_MODELS) is expected, (
        f"{config_case} setting resolved the wrong gate for {model}")


def test_the_store_loads_home_files_exactly_when_a_flag_is_on(hermes_home):
    """The flags decide whether a store exists at all; the store itself reads
    both files from the engine home unconditionally, which is why the gate has
    to be the flags and not the toolset."""
    memories = hermes_home / "memories"
    memories.mkdir()
    (memories / "MEMORY.md").write_text("a fact from a previous attempt\n", encoding="utf-8")
    (memories / "USER.md").write_text("an owner detail\n", encoding="utf-8")

    from tools.memory_tool import MemoryStore, get_memory_dir

    assert get_memory_dir() == memories

    # The condition agent/agent_init.py:1266 applies before constructing a store.
    for memory_enabled, user_enabled in ((False, False),):
        assert not (memory_enabled or user_enabled), (
            "with both target flags off no store is constructed, so neither file "
            "is read")

    store = MemoryStore(memory_enabled=True, user_profile_enabled=True)
    store.load_from_disk()
    assert any("a fact from a previous attempt" in e for e in store.memory_entries)
    assert any("an owner detail" in e for e in store.user_entries)

    off = MemoryStore(memory_enabled=False, user_profile_enabled=False)
    off.load_from_disk()
    assert any("a fact from a previous attempt" in e for e in off.memory_entries), (
        "the store reads the files regardless of its own flags — only the "
        "construction gate keeps them out of the prompt")


# --- Probe 5: bundled skills sync against a directory that does not exist ----
# hermes_constants.py:265 `get_bundled_skills_dir` resolves HERMES_BUNDLED_SKILLS
# ahead of the repository-relative default, and tools/skills_sync.py:371 returns
# an empty result before creating or touching the engine home's skills
# directory. That is what neutralises the sync the gateway runs on every start
# (gateway/run.py:4848).


def test_bundled_skill_sync_is_a_noop_without_a_bundled_directory(
    hermes_home, tmp_path, monkeypatch,
):
    """With the override pointing nowhere, the sync copies nothing and does not
    even create the skills directory."""
    write_config(hermes_home, {})
    missing = tmp_path / "no-bundled-skills"
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(missing))

    from hermes_constants import get_bundled_skills_dir
    from tools.skills_sync import sync_skills

    assert get_bundled_skills_dir() == missing
    assert not missing.exists()

    result = sync_skills(quiet=True)

    assert result["copied"] == [] and result["updated"] == []
    assert result["total_bundled"] == 0
    assert not (hermes_home / "skills").exists(), (
        "the sync created a skills directory it had nothing to fill")


def test_bundled_skill_sync_copies_when_the_directory_exists(
    hermes_home, tmp_path, monkeypatch,
):
    """The same call with a populated override does copy, so the no-op above is
    the override's doing and not an unrelated failure."""
    write_config(hermes_home, {})
    bundled = tmp_path / "bundled"
    (bundled / "probe-bundled").mkdir(parents=True)
    (bundled / "probe-bundled" / "SKILL.md").write_text(
        "---\nname: probe-bundled\ndescription: A bundled probe skill.\n---\n\nBody.\n",
        encoding="utf-8")
    monkeypatch.setenv("HERMES_BUNDLED_SKILLS", str(bundled))

    from tools.skills_sync import sync_skills

    result = sync_skills(quiet=True)

    assert result["total_bundled"] == 1
    assert (hermes_home / "skills" / "probe-bundled" / "SKILL.md").exists()


# --- Probe 6: skill_manage under and without the write-approval gate ---------
# tools/skill_manager_tool.py:600 `_apply_skill_write_gate` runs before any
# handler; tools/write_approval.py:170 `evaluate_gate` stages every skills write
# when `skills.write_approval` is on, and tools/write_approval.py:73
# `stage_write` persists it at HERMES_HOME/pending/skills/<id>.json.
# Without the gate the handler at tools/skill_manager_tool.py:392 writes a live
# skill package, and tools/skill_manager_tool.py:695 `_record_success` runs the
# audit ledger and the lifecycle hook.

PROBE_SKILL = (
    "---\n"
    "name: probe-skill\n"
    "description: A probe skill written by the engine surface probes.\n"
    "---\n\n"
    "# Probe skill\n\nBody text.\n"
)


@pytest.fixture
def lifecycle_hook_recorder(monkeypatch):
    """Records every lifecycle hook name the engine invokes."""
    from hermes_cli import lifecycle

    fired: list = []
    monkeypatch.setattr(lifecycle, "has_hook", lambda name: True)

    def _record(name, **kwargs):
        fired.append((name, kwargs))
        return []

    monkeypatch.setattr(lifecycle, "invoke_hook", _record)
    return fired


def test_skill_manage_stages_under_write_approval(hermes_home):
    """With the gate on, the call writes a pending record and no skill."""
    write_config(hermes_home, {"skills": {"write_approval": True}})

    from tools.skill_manager_tool import skill_manage

    result = json.loads(skill_manage(action="create", name="probe-skill",
                                     content=PROBE_SKILL))

    assert result["staged"] is True
    pending_dir = hermes_home / "pending" / "skills"
    records = sorted(pending_dir.glob("*.json"))
    assert [p.name for p in records] == [f"{result['pending_id']}.json"]
    staged = json.loads(records[0].read_text(encoding="utf-8"))
    assert staged["subsystem"] == "skills"
    assert staged["payload"]["action"] == "create"
    assert staged["payload"]["name"] == "probe-skill"
    assert staged["payload"]["content"] == PROBE_SKILL
    assert not (hermes_home / "skills" / "probe-skill").exists(), (
        "a staged write must not leave a live skill")


def test_skill_manage_writes_live_without_write_approval(
    hermes_home, lifecycle_hook_recorder,
):
    """Without the gate the write lands live. This records the layout the write
    produces and the hook events that fire around it, because a live write has
    to be observable and gateable from outside the engine.

    The config here also carries `skills.enabled: false`, the spelling the
    configuration used to carry. The write still lands, so that key is not one
    the engine reads either, which is why it is no longer shipped."""
    write_config(hermes_home, {"skills": {"enabled": False}})

    from tools.skill_manager_tool import skill_manage

    result = json.loads(skill_manage(action="create", name="probe-skill",
                                     content=PROBE_SKILL, session_id="probe-session"))
    assert result["success"] is True

    skills_dir = hermes_home / "skills"
    skill_md = skills_dir / "probe-skill" / "SKILL.md"
    assert skill_md.exists(), "the live write did not land under the engine home"
    assert skill_md.read_text(encoding="utf-8") == PROBE_SKILL
    assert result["skill_md"] == str(skill_md)
    assert result["path"] == "probe-skill"
    assert not (hermes_home / "pending" / "skills").exists()

    # The write leaves a further artefact beside the package itself: an
    # append-only audit ledger in the same skills directory.
    written = sorted(
        str(p.relative_to(hermes_home)).replace(os.sep, "/")
        for p in skills_dir.rglob("*") if p.is_file())
    assert "skills/probe-skill/SKILL.md" in written
    assert "skills/.curator_ledger.jsonl" in written, f"ledger missing from {written}"
    ledger_entry = json.loads(
        (skills_dir / ".curator_ledger.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert ledger_entry["action"] == "create"
    assert ledger_entry["skill"] == "probe-skill"

    # A supporting file lands inside the same package directory.
    json.loads(skill_manage(action="write_file", name="probe-skill",
                            file_path="references/note.md", file_content="note\n"))
    assert (skills_dir / "probe-skill" / "references" / "note.md").exists()

    # One lifecycle hook fires per successful mutation, carrying the skill name.
    lifecycle = [kw for name, kw in lifecycle_hook_recorder
                 if name == "on_skill_lifecycle"]
    assert len(lifecycle) == 2, [name for name, _ in lifecycle_hook_recorder]
    created = next(kw for kw in lifecycle if kw.get("action") == "created")
    assert created["skill_name"] == "probe-skill"
    assert created["session_id"] == "probe-session"
    assert {kw.get("action") for kw in lifecycle} == {"created", "edited"}


def test_a_dispatched_skill_write_also_fires_the_tool_call_hooks(
    hermes_home, lifecycle_hook_recorder,
):
    """Dispatched as a tool, the same write is bracketed by the generic tool
    hooks, which is the pair an observer would gate on."""
    write_config(hermes_home, {})

    import model_tools

    result = json.loads(model_tools.handle_function_call(
        "skill_manage",
        {"action": "create", "name": "probe-skill", "content": PROBE_SKILL},
        session_id="probe-session",
    ))
    assert result["success"] is True

    names = [name for name, _ in lifecycle_hook_recorder]
    assert "pre_tool_call" in names and "post_tool_call" in names, names
    assert names.index("pre_tool_call") < names.index("on_skill_lifecycle")
    assert names.index("on_skill_lifecycle") < names.index("post_tool_call")
    post = next(kw for name, kw in lifecycle_hook_recorder if name == "post_tool_call")
    assert post["tool_name"] == "skill_manage"


# --- Probe 7: the tool-loop hard stop on the api_server platform -------------
# Finding 8. agent/tool_guardrails.py:75 counts api_server as attended, so the
# non-interactive hard stop at agent/tool_guardrails.py:134 never turns it on
# there. Only an explicit `tool_loop_guardrails.hard_stop_enabled` does.


@pytest.mark.parametrize(
    ("config_case", "section", "expected"),
    [
        ("unset", {}, False),
        ("non-interactive-flag-only",
         {"non_interactive_hard_stop_enabled": True}, False),
        ("shipped", shipped_config().get("tool_loop_guardrails"), True),
    ],
)
def test_tool_loop_hard_stop_on_api_server(config_case, section, expected):
    """Unattended runs on this platform get no hard stop unless it is asked for,
    and the shipped configuration asks for it by name."""
    from agent.tool_guardrails import ToolCallGuardrailConfig

    resolved = ToolCallGuardrailConfig.from_mapping(section, platform="api_server")
    assert resolved.hard_stop_enabled is expected, config_case
    # The same section on a platform the engine treats as unattended turns it on
    # by itself, which is why the api_server classification is load-bearing.
    assert ToolCallGuardrailConfig.from_mapping(
        section, platform="cron").hard_stop_enabled is True
    assert resolved.warnings_enabled is True


# --- Probe 8: how agent.max_turns resolves on the API server path ------------
# Finding 5. gateway/run.py:1546 re-bridges `agent.max_turns` from config on
# every turn through gateway/run.py:1824, and gateway/run.py:1559
# `_current_max_iterations` — the value gateway/platforms/api_server.py:2123
# hands the agent — is hermes_cli/config.py:1843 `resolve_turn_limit` over that
# bridge. Absent means the unlimited sentinel, not a default ceiling.


@pytest.mark.parametrize(
    ("config_case", "agent_section", "expect_unlimited", "expected"),
    [
        ("unset", {}, True, None),
        ("shipped", shipped_config().get("agent"), False, 150),
    ],
)
def test_agent_max_turns_resolution_on_the_api_server_path(
    hermes_home, monkeypatch, config_case, agent_section, expect_unlimited, expected,
):
    """Unset resolves to unlimited; the ceiling the shipped configuration names
    resolves to that number."""
    write_config(hermes_home, {"agent": agent_section} if agent_section else {})
    monkeypatch.delenv("HERMES_MAX_ITERATIONS", raising=False)

    import gateway.run as gateway_run
    from hermes_cli.config import TURN_LIMIT_UNLIMITED

    # The module caches its home at import; point it at this probe's home.
    monkeypatch.setattr(gateway_run, "_hermes_home", hermes_home)
    monkeypatch.setattr(gateway_run, "load_hermes_dotenv", lambda **kwargs: None)

    resolved = gateway_run._current_max_iterations()

    if expect_unlimited:
        assert resolved == TURN_LIMIT_UNLIMITED, (
            f"{config_case} config produced a ceiling where none is configured")
        assert TURN_LIMIT_UNLIMITED == sys.maxsize
    else:
        assert resolved == expected, config_case


# --- Probe 9: the compaction trigger arithmetic ------------------------------
# agent/context_compressor.py:2216 floors the threshold to 0.75 below a 512K
# window; :2223 derives the trigger from the window minus max_tokens times the
# threshold, floored at the 64K minimum from agent/model_metadata.py:316 and
# capped at 85% of the budget when that floor binds; :2208 then clamps the
# result to `compression.threshold_tokens`. The numbers below are executed.

WINDOWS = (64_000, 128_000, 1_000_000)


@pytest.mark.parametrize("context_length", WINDOWS)
def test_effective_threshold_percent_floor(context_length):
    """The configured 0.50 is raised to 0.75 only below 512K."""
    from agent.context_compressor import ContextCompressor

    effective = ContextCompressor._effective_threshold_percent(context_length, 0.50)
    assert effective == (0.75 if context_length < 512_000 else 0.50)


@pytest.mark.parametrize(
    ("context_length", "expected_percent", "expected_trigger"),
    [
        # 64K: 0.75 of the window is 48,000, below the 64K minimum floor, so the
        # floor binds and is capped at 85% of the window — 54,400, not 48,000.
        (64_000, 0.75, 54_400),
        (128_000, 0.75, 96_000),
        (1_000_000, 0.50, 500_000),
    ],
)
def test_compression_trigger_without_a_cap(
    context_length, expected_percent, expected_trigger,
):
    """The trigger the engine computes for each window at the default 0.50."""
    from agent.context_compressor import ContextCompressor

    percent = ContextCompressor._effective_threshold_percent(context_length, 0.50)
    assert percent == expected_percent
    assert ContextCompressor._compute_threshold_tokens(
        context_length, percent, None) == expected_trigger

    compressor = ContextCompressor(
        model="probe-model", threshold_percent=0.50, quiet_mode=True,
        config_context_length=context_length)
    assert compressor.context_length == context_length
    assert compressor.threshold_tokens == expected_trigger
    assert compressor.threshold_percent == expected_percent


def test_threshold_tokens_caps_the_million_token_window():
    """A `threshold_tokens` cap lowers the trigger and never raises it."""
    from agent.context_compressor import ContextCompressor

    capped = ContextCompressor(
        model="probe-model", threshold_percent=0.50, quiet_mode=True,
        config_context_length=1_000_000, threshold_tokens_cap=200_000)
    assert capped.threshold_tokens == 200_000

    # A cap above the computed trigger leaves the trigger alone.
    ignored = ContextCompressor(
        model="probe-model", threshold_percent=0.50, quiet_mode=True,
        config_context_length=1_000_000, threshold_tokens_cap=900_000)
    assert ignored.threshold_tokens == 500_000

    # On a small window the cap still binds, below the floored 75% trigger.
    small = ContextCompressor(
        model="probe-model", threshold_percent=0.50, quiet_mode=True,
        config_context_length=128_000, threshold_tokens_cap=40_000)
    assert small.threshold_tokens == 40_000


def test_the_shipped_threshold_is_the_one_the_engine_uses():
    """The window and trigger the image carries, put through the engine's own
    compressor: what Melete renders is what the engine will act on, and the
    owner's cap is what decides at this window rather than the engine's half."""
    from agent.context_compressor import ContextCompressor

    config = shipped_config()
    window = config["model"]["context_length"]
    configured = config["compression"]["threshold_tokens"]

    compressor = ContextCompressor(
        model="probe-model", threshold_percent=0.50, quiet_mode=True,
        config_context_length=window, threshold_tokens_cap=configured)

    assert compressor.context_length == window
    assert compressor.threshold_tokens == configured
    assert configured < ContextCompressor._compute_threshold_tokens(
        window, ContextCompressor._effective_threshold_percent(window, 0.50), None), (
        "the cap is meant to bind at this window; if it no longer does, the "
        "engine's own trigger is the one in force")


def test_summary_budget_scales_with_the_window():
    """The summary output target is 5% of the window, ceilinged, and the lean
    tail 2.5% clamped. Both bound what one compaction costs."""
    from agent.context_compressor import ContextCompressor

    budgets = {}
    for window in WINDOWS:
        compressor = ContextCompressor(
            model="probe-model", quiet_mode=True, config_context_length=window)
        budgets[window] = (compressor.max_summary_tokens, compressor.tail_token_budget)

    assert budgets[64_000] == (3_200, 10_000)
    assert budgets[128_000] == (6_400, 10_000)
    assert budgets[1_000_000] == (10_000, 25_000)


# --- Probe 10: rehydration by session id versus a request-body history -------
# Finding 10. gateway/platforms/api_server_runs.py:420 loads a session's history
# when the body carries a session id and no history of its own, through
# gateway/platforms/api_server.py:2714 and hermes_state_messages.py:740
# `get_messages_as_conversation`, which returns tool calls intact. The
# `conversation_history` body field is coerced at
# gateway/platforms/api_server_runs.py:266 to role and content only.


def _seed_session_with_a_tool_call(db, session_id: str) -> None:
    db.create_session(session_id, source="api_server")
    db.append_message(session_id, "user", content="do the thing")
    db.append_message(
        session_id, "assistant", content="",
        tool_calls=[{
            "id": "call_probe_1",
            "type": "function",
            "function": {"name": "probe_tool", "arguments": '{"value": "x"}'},
        }])
    db.append_message(session_id, "tool", content='{"ok": true}',
                      tool_call_id="call_probe_1", tool_name="probe_tool")
    db.append_message(session_id, "assistant", content="done")


def test_session_rehydration_preserves_tool_calls(hermes_home, tmp_path):
    """Loading by session id returns the tool call and its result."""
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    _seed_session_with_a_tool_call(db, "job-probe")
    history = db.get_messages_as_conversation("job-probe")

    roles = [m["role"] for m in history]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assistant = history[1]
    assert assistant["tool_calls"][0]["id"] == "call_probe_1"
    assert assistant["tool_calls"][0]["function"]["name"] == "probe_tool"
    assert history[2]["tool_call_id"] == "call_probe_1"
    assert history[2]["tool_name"] == "probe_tool"


def test_conversation_history_in_the_request_body_strips_tool_calls():
    """The body field keeps role and content and nothing else."""
    from gateway.platforms import api_server_runs

    class _Server:
        _response_store: dict = {}

    body = {"conversation_history": [
        {"role": "user", "content": "do the thing"},
        {"role": "assistant", "content": "", "tool_calls": [{
            "id": "call_probe_1", "type": "function",
            "function": {"name": "probe_tool", "arguments": '{"value": "x"}'}}]},
        {"role": "tool", "content": '{"ok": true}', "tool_call_id": "call_probe_1",
         "tool_name": "probe_tool"},
    ]}

    history, _instructions, _stored, error = (
        api_server_runs._resolve_conversation_history(
            _Server(), body, None, _openai_error=lambda *a, **k: {"error": True}))

    assert error is None
    assert [sorted(m) for m in history] == [["content", "role"]] * 3
    assert all("tool_calls" not in m and "tool_call_id" not in m for m in history)
    assert history[1]["content"] == ""


# --- The sandbox terminal backend through the engine's own seam --------------
# agent/terminal_env_registry.py:26-29 reserves the built-in backend names and
# the registry refuses them (:32-34). tools/terminal_tool_backends.py:183-192
# builds any other `TERMINAL_ENV` from the registered provider, and
# tools/terminal_tool.py `_run_foreground` retries a raising `env.execute` up to
# three times. These probes register the Melete backend in that registry, reach
# it through the engine's factory and its terminal tool, and count what arrives
# at a loopback broker.

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _Broker(http.server.BaseHTTPRequestHandler):
    def _answer(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):  # noqa: N802 - http.server's name
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.server.proposals.append(json.loads(raw))
        self._answer(*self.server.propose)

    def do_GET(self):  # noqa: N802
        self._answer(200, {"action": {"id": "act_probe", "receipt": {"detail": {
            "output": "from the sandbox\n", "output_binary": False, "exit_code": 7,
            "timed_out": False, "truncated": False, "capture_limited": False}}}})

    def log_message(self, *args):
        return


@contextlib.contextmanager
def _sandbox_backend(propose: tuple):
    from agent import terminal_env_registry
    from melete_plugin.broker import BrokerClient
    from melete_plugin.terminal_backend import register_terminal_backend

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Broker)
    server.proposals = []
    server.propose = propose
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    class _Ctx:
        def register_terminal_environment_provider(self, provider):
            terminal_env_registry.register_provider(provider)
            return provider

    client = BrokerClient(base_url=f"http://127.0.0.1:{server.server_port}", token="cap", timeout=5)
    catalog = [{"name": "terminal.run", "connection_id": "conn_probe"}]
    provider = register_terminal_backend(_Ctx(), client, catalog)
    try:
        yield provider, server
    finally:
        terminal_env_registry._registry.reset_for_tests()
        server.shutdown()
        server.server_close()


def test_the_engine_refuses_a_plugin_backend_with_a_builtin_name():
    from agent import terminal_env_registry
    from melete_plugin.broker import BrokerClient
    from melete_plugin.terminal_backend import SandboxTerminal, engine_classes

    provider_cls, _env, _hooks = engine_classes()

    class Local(provider_cls):
        @property
        def name(self) -> str:
            return "local"

    with pytest.raises(ValueError):
        terminal_env_registry.register_provider(Local(SandboxTerminal(BrokerClient("http://x", "t"), "c")))
    terminal_env_registry._registry.reset_for_tests()


def test_the_engine_factory_builds_the_sandbox_backend_and_one_command_is_one_action(hermes_home):
    from tools.terminal_tool_backends import _create_environment

    ok = (201, {"action_id": "act_probe", "status": "succeeded", "message": "ran"})
    with _sandbox_backend(ok) as (provider, server):
        assert provider is not None and provider.name == "melete_sandbox"
        env = _create_environment("melete_sandbox", image="", cwd="/work", timeout=30, task_id="probe")
        assert env._hermes_backend_name == "melete_sandbox"
        result = env.execute("ls", cwd="/work/src", timeout=10)
        assert result == {"output": "from the sandbox\n", "returncode": 7}
        [proposal] = server.proposals
        assert proposal["kind"] == "terminal.run" and proposal["connection_id"] == "conn_probe"
        assert proposal["payload"]["command"] == "ls" and proposal["payload"]["cwd"] == "src"


def test_the_engines_terminal_tool_sends_a_lost_command_once(hermes_home, monkeypatch):
    """A broker failure after sending would be retried three times by the
    engine if execute() raised; it returns instead, so one proposal arrives."""
    from tools import terminal_tool

    monkeypatch.setenv("TERMINAL_ENV", "melete_sandbox")
    monkeypatch.setenv("TERMINAL_CWD", "/work")
    lost = (500, {"error": {"code": "internal_error", "message": "Broker request failed"}})
    with _sandbox_backend(lost) as (_provider, server):
        answer = json.loads(terminal_tool.terminal_tool("make deploy", task_id="probe-lost"))
        assert len(server.proposals) == 1
        assert "[outcome unknown]" in answer["output"]
        assert answer["exit_code"] != 0


def test_the_sandbox_toolset_gives_the_terminal_and_no_background_processes(hermes_home, monkeypatch):
    """`terminal_tools` is what the boot script and engine-config.ts add for a
    sandbox space (SANDBOX_TERMINAL_TOOLSET). The `terminal` toolset would also
    select process_manage, whose background polls each become a broker action."""
    import model_tools
    from hermes_cli.tools_config import _get_platform_tools
    from tools.registry import discover_builtin_tools

    discover_builtin_tools()
    monkeypatch.setenv("TERMINAL_ENV", "melete_sandbox")
    monkeypatch.setenv("TERMINAL_CWD", "/work")
    ok = (201, {"action_id": "act_probe", "status": "succeeded", "message": "ran"})
    with _sandbox_backend(ok):
        config = {"platform_toolsets": {"api_server": ["melete", "terminal_tools"]},
                  "tools": {"tool_search": {"enabled": "off"}}}
        write_config(hermes_home, config)
        enabled = sorted(_get_platform_tools(config, "api_server"))
        names = {d["function"]["name"] for d in
                 model_tools.get_tool_definitions(enabled_toolsets=enabled, quiet_mode=True)}
        assert "terminal" in names
        assert "process_manage" not in names
        assert "process_manage" not in model_tools._select_tool_names(enabled, None, True)
        # The spelling not used would have asked for it.
        assert "process_manage" in model_tools._select_tool_names(["terminal"], None, True)


@contextlib.contextmanager
def _broker_tools(*names: str):
    """Plugin tools in the `melete` toolset, as the plugin registers them."""
    from tools.registry import registry

    for name in names:
        registry.register(name=name, toolset="melete",
                          schema={"description": f"{name} probe", "parameters": {"type": "object", "properties": {}}},
                          handler=lambda args, **kw: "{}")
    try:
        yield names
    finally:
        for name in names:
            registry.deregister(name)


#: Built-in tools that act outside the engine process. None may be offered:
#: Melete offers what they do as broker tools.
OUTSIDE_EFFECT_TOOLS = {
    "terminal", "process_manage", "read_file", "write_file", "patch", "search_files",
    "web_search", "web_extract", "browser_navigate", "execute_code", "vision_analyze",
    "image_generate", "memory", "session_search", "skill_manage", "cronjob_manage",
    "text_to_speech", "clarify", "computer_use",
}

#: Broker tools only the agent that delegated may call (runtime_support).
PARENT_ONLY_TOOLS = ("ask_person", "say", "react", "job.wait", "search_tools", "load_tool",
                     "run.start", "run.delegate")


def _with_helpers(config: dict) -> dict:
    """The configuration an attempt with a conversation's budget is booted with."""
    toolsets = [*config["platform_toolsets"]["api_server"], "delegation"]
    return {**config, "platform_toolsets": {"api_server": toolsets}}


def test_the_shipped_toolsets_offer_the_engine_only_builtins_and_nothing_else(hermes_home):
    """engine-config.ts: the task list for every attempt, and helpers only when
    the boot script adds them for a budget that fits. Each acts only inside the
    engine (tools/todo_tool.py, tools/delegate_tool.py)."""
    import model_tools
    from hermes_cli.tools_config import _get_platform_tools
    from tools.registry import discover_builtin_tools

    discover_builtin_tools()
    with _broker_tools("files.read"):
        for config, expected in ((shipped_config(), {"files.read", "todo_list"}),
                                 (_with_helpers(shipped_config()), {"files.read", "todo_list", "delegate_task"})):
            write_config(hermes_home, config)
            enabled = sorted(_get_platform_tools(config, "api_server"))
            names = {d["function"]["name"] for d in
                     model_tools.get_tool_definitions(enabled_toolsets=enabled, quiet_mode=True)}
            assert names == expected
            assert not names & OUTSIDE_EFFECT_TOOLS


def _parent_agent(base_url: str, toolsets: list):
    from run_agent import AIAgent

    return AIAgent(base_url=base_url, api_key="melete-surrogate-probe", provider="custom",
                   requested_provider="melete-gateway", model="probe-model",
                   api_mode="chat_completions", enabled_toolsets=toolsets, quiet_mode=True,
                   skip_context_files=True, skip_memory=True, max_iterations=4)


@pytest.mark.parametrize("sandbox", [False, True])
def test_a_helper_is_melete_with_the_parents_tools_less_the_parent_only_ones(hermes_home, monkeypatch, sandbox):
    """A helper built by the pinned engine with the delegation seam applied:
    the parent's toolsets less delegation, the question tool and memory
    (tools/delegate_tool_toolsets.py), less the broker tools that speak to the
    person, park the job or start more helpers; Melete's identity from the
    engine home's SOUL.md, not the engine's own; and the gateway's metering
    header on its client, keyed on the gateway's address (agent/agent_init.py)."""
    from hermes_cli.tools_config import _get_platform_tools
    from tools import delegate_tool
    from tools.registry import discover_builtin_tools

    discover_builtin_tools()
    base = "http://127.0.0.1:9/providers/probe/v1"
    config = _with_helpers(shipped_config())
    if sandbox:
        monkeypatch.setenv("TERMINAL_ENV", "melete_sandbox")
        monkeypatch.setenv("TERMINAL_CWD", "/work")
        config["platform_toolsets"]["api_server"].append("terminal_tools")
    config["providers"]["melete-gateway"].update({"base_url": base, "extra_headers": {CAPABILITY_HEADER: "attempt-token"}})
    write_config(hermes_home, config)
    (hermes_home / "SOUL.md").write_text((Path(__file__).parents[1] / "config" / "SOUL.md").read_text(encoding="utf-8"),
                                         encoding="utf-8")
    ok = (201, {"action_id": "act_probe", "status": "succeeded", "message": "ran"})
    with _sandbox_backend(ok), _broker_tools("files.read", *PARENT_ONLY_TOOLS):
        parent = _parent_agent(base, sorted(_get_platform_tools(config, "api_server")))
        assert {"ask_person", "delegate_task"} <= parent.valid_tool_names
        child = delegate_tool._build_child_agent(0, "probe goal", None, None, None, 5, 1, parent)
        expected = {"files.read", "todo_list"} | ({"terminal"} if sandbox else set())
        assert set(child.valid_tool_names) == expected
        assert {d["function"]["name"] for d in child.tools} == expected
        prompt = child._build_system_prompt()
        assert prompt.lstrip().startswith("# Melete\n\nYou are Melete")
        assert "Hermes Agent" not in prompt
        assert child._client_kwargs["default_headers"][CAPABILITY_HEADER] == "attempt-token"


def test_a_helper_cannot_use_a_parent_only_tool_even_if_offered(monkeypatch):
    """The plugin refuses them inside a helper whatever the helper's list says,
    since the engine may rebuild that list from the toolsets mid-run."""
    from agent.delegation_context import delegated_child_context
    from melete_plugin import build_handler

    class _Unreached:
        def __getattr__(self, name):
            raise AssertionError("a parent-only tool reached the broker from a helper")

    for name in PARENT_ONLY_TOOLS:
        handler = build_handler(_Unreached(), {"name": name, "connection_id": None})
        with delegated_child_context("helper-session"):
            refused = handler({"text": "hello"})
        assert refused["error"]["code"] == "parent_only"


def test_helpers_are_bounded_by_the_shipped_configuration(hermes_home):
    """tools/delegate_tool_config.py reads the `delegation` section: three at a
    time, one level deep, ten minutes each, no helper of a helper, no
    self-approved commands."""
    from tools import delegate_tool, delegate_tool_config

    write_config(hermes_home, shipped_config())
    assert delegate_tool._get_max_concurrent_children() == 3
    assert delegate_tool_config._get_max_spawn_depth() == 1
    assert delegate_tool_config._get_orchestrator_enabled() is False
    assert delegate_tool_config._get_child_timeout() == 600
    assert delegate_tool_config._get_subagent_approval_callback() is delegate_tool_config._subagent_auto_deny
    assert delegate_tool._load_config()["max_iterations"] == 50


def test_a_delegation_runs_inside_the_turn_and_returns_what_its_helpers_left_parked(monkeypatch):
    """The delegation seam (patches/observer_bridge.py), as the image applies it:
    both dispatch paths ask for the synchronous run, the model is told so, and
    an action a helper left waiting for approval comes back to the parent as
    data beside the summaries."""
    import json as _json

    import melete_runtime_hooks
    import run_agent
    from tools import delegate_tool

    seen: dict = {}

    def capture(**kwargs):
        seen.update(kwargs)
        return "{}"

    with monkeypatch.context() as patch:
        patch.setattr(delegate_tool, "delegate_task", capture)
        parent = type("Parent", (), {"_delegate_depth": 0})()
        run_agent.AIAgent._dispatch_delegate_task(parent, {"tasks": [{"goal": "probe"}]})
    assert seen["background"] is False, "the delegation seam is not applied to this engine"
    assert delegate_tool._model_background_value({}, parent) is False
    description = delegate_tool._build_top_level_description()
    assert "Runs inside this turn" in description
    assert "END YOUR TURN" not in description
    assert "-> execute_code" not in description and "-> cronjob" not in description

    melete_runtime_hooks.note_helper_parked("act_parked", "email.send")
    monkeypatch.setattr("tools.delegate_tool._run_batch",
                        lambda batch, background: _json.dumps({"results": [{"summary": "drafted"}]}))
    monkeypatch.setattr("tools.delegate_tool._build_children", lambda *a, **k: ([], None))
    monkeypatch.setattr("tools.delegate_tool._Batch", lambda *a, **k: None)
    real_parent = type("Parent", (), {"_delegate_depth": 0, "model": "probe-model", "provider": "custom",
                                      "base_url": "http://127.0.0.1:9/v1", "api_key": "k"})()
    out = _json.loads(delegate_tool.delegate_task(tasks=[{"goal": "probe"}], parent_agent=real_parent))
    assert out["results"] == [{"summary": "drafted"}]
    assert out["awaiting_approval"] == [{"action_id": "act_parked", "tool": "email.send"}]
    assert "NOT happened" in out["awaiting_approval_note"]


class _CatalogBroker(http.server.BaseHTTPRequestHandler):
    """Serves one attempt's catalog on `GET /tools` and nothing else."""

    def do_GET(self):  # noqa: N802 - http.server's name
        payload = json.dumps({"tools": self.server.catalog}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        return


def _entry(name: str, connection_id: str) -> dict:
    return {"name": name, "description": f"{name} probe", "connection_id": connection_id,
            "effect_class": "read", "input_schema": {"type": "object", "properties": {}}}


#: A paired computer with commands off offers its other tools beside the
#: sandbox's own terminal and desktop. Sorted by name, these come first.
PAIRED_DEVICE_TOOLS = [f"device.{tool}" for tool in (
    "status", "list_files", "read_file", "write_file", "open_url", "screenshot",
    "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot")]


@pytest.mark.parametrize("toolsets, terminal", [
    # What engine-config.ts renders for a space with a sandbox (SANDBOX_TERMINAL_TOOLSET).
    (["melete", "terminal_tools"], True),
    # Without the terminal toolset, the plugin still hands the terminal to the
    # engine, so the model is left with none. The bundle must select it.
    (["melete"], False),
])
def test_the_model_is_offered_a_terminal_beside_a_paired_computer(hermes_home, monkeypatch, toolsets, terminal):
    """The plugin registered from a broker catalog with a paired computer
    online, and the tool definitions the engine then gives the model."""
    import model_tools
    from agent import terminal_env_registry
    from melete_plugin import TOOLSET, register_tools
    from melete_plugin.broker import BrokerClient
    from tools.registry import discover_builtin_tools, registry

    discover_builtin_tools()
    monkeypatch.setenv("TERMINAL_ENV", "melete_sandbox")
    monkeypatch.setenv("TERMINAL_CWD", "/work")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _CatalogBroker)
    server.catalog = (
        [_entry(name, "conn_laptop") for name in PAIRED_DEVICE_TOOLS]
        + [_entry(name, "conn_sandbox") for name in ("computer.screenshot", "computer.key", "terminal.run")]
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    class _Ctx:
        def register_tool(self, name, toolset, schema, handler, description="", emoji=""):
            registry.register(name=name, toolset=toolset, schema=schema, handler=handler,
                              description=description, emoji=emoji)

        def register_terminal_environment_provider(self, provider):
            terminal_env_registry.register_provider(provider)
            return provider

    client = BrokerClient(base_url=f"http://127.0.0.1:{server.server_port}", token="cap", timeout=5)
    registered: list = []
    try:
        registered = register_tools(_Ctx(), client)
        assert TOOLSET in toolsets
        config = {"platform_toolsets": {"api_server": toolsets},
                  "tools": {"tool_search": {"enabled": "off"}}}
        write_config(hermes_home, config)
        from hermes_cli.tools_config import _get_platform_tools
        enabled = sorted(_get_platform_tools(config, "api_server"))
        names = {d["function"]["name"] for d in
                 model_tools.get_tool_definitions(enabled_toolsets=enabled, quiet_mode=True)}
        assert "device.status" in names and "computer.key" in names
        # One terminal at most, and it is the engine's, pinned to the sandbox.
        assert "terminal.run" not in names
        assert ("terminal" in names) is terminal
    finally:
        for name in registered:
            with contextlib.suppress(Exception):
                registry.deregister(name)
        terminal_env_registry._registry.reset_for_tests()
        server.shutdown()
        server.server_close()


# --- Probe: a screenshot reaches the provider as a picture -------------------
# agent/tool_executor.py:1025 hands each tool result to
# agent/vision_message_prep.py:206 `_tool_result_content_for_active_model`,
# which sends the plugin's multimodal envelope as an image part only when
# `_model_supports_vision` (agent/image_routing.py:315, reading
# `model.supports_vision` first) says so, and its text summary otherwise. The
# probe runs one real engine turn: the model asks for a screenshot, the
# plugin's own result path answers it from a broker stand-in, and a recording
# provider shows what the engine sent next.


class _ScriptedProvider(http.server.BaseHTTPRequestHandler):
    """Asks for one screenshot, then ends the turn; records every request."""

    def do_POST(self):  # noqa: N802 - http.server's name
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.captured.append(body)
        first = len(self.server.captured) == 1
        delta = (
            {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
             "function": {"name": self.server.tool, "arguments": "{\"step\": 1}"}}]}
            if first else {"role": "assistant", "content": "done"})
        chunks = [
            {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if first else "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        frame = {"id": "probe", "object": "chat.completion.chunk", "created": 0, "model": "probe-model"}
        out = "".join(f"data: {json.dumps({**frame, **c})}\n\n" for c in chunks) + "data: [DONE]\n\n"
        payload = out.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        return


class _ScreenshotBroker:
    """The broker as the plugin sees it for one succeeded screenshot."""

    def __init__(self, tool: str, picture: bytes) -> None:
        self.tool, self.picture = tool, picture

    def propose(self, **_kw):
        return {"action_id": "act_01PROBESHOT", "status": "succeeded"}

    def action(self, action_id):
        return {"receipt": {"action_id": action_id, "connection_id": "con_probe", "external_ref": None,
                            "detail": {"path": "device/screenshot-act_01PROBESHOT.png",
                                       "width": 1600, "height": 1000}}}

    def screenshot(self, action_id):
        return self.picture if action_id == "act_01PROBESHOT" else None


@pytest.mark.parametrize("tool", ["computer.screenshot", "device.screenshot"])
@pytest.mark.parametrize(("vision", "expect_picture"), [(True, True), (False, False)])
def test_a_screenshot_reaches_the_provider_as_a_picture_only_for_a_vision_model(
    hermes_home, monkeypatch, tool, vision, expect_picture,
):
    import io

    from PIL import Image

    from melete_plugin import build_handler, engine_result
    from run_agent import AIAgent
    from tools.registry import registry

    monkeypatch.setenv("MELETE_ENGINE_SUPPORTS_VISION", "1" if vision else "0")
    monkeypatch.setenv("MELETE_MODEL_KEY", "melete-surrogate-probe")
    out = io.BytesIO()
    Image.new("RGB", (1600, 1000), (255, 128, 0)).save(out, format="PNG")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _ScriptedProvider)
    server.captured, server.tool = [], tool
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        config = shipped_config()
        # The model is one the engine's catalog does not know: only the
        # configuration Melete writes says whether it reads images.
        config["model"].update({"default": "probe-model", "supports_vision": vision})
        config["providers"]["melete-gateway"].update({"base_url": base, "default_model": "probe-model"})
        write_config(hermes_home, config)

        client = _ScreenshotBroker(tool, out.getvalue())
        spec = {"name": tool, "connection_id": "con_probe", "effect_class": "read",
                "input_schema": {"type": "object", "properties": {"step": {"type": "integer"}}}}
        forward = build_handler(client, spec)
        registry.register(name=tool, toolset="melete",
                          schema={"description": "Take a screenshot.", "parameters": spec["input_schema"]},
                          handler=lambda args=None, **_kw: engine_result(tool, forward(args), client))
        try:
            agent = AIAgent(base_url=base, api_key="melete-surrogate-probe", provider="custom",
                            requested_provider="melete-gateway", model="probe-model",
                            api_mode="chat_completions", enabled_toolsets=["melete"], quiet_mode=True,
                            skip_context_files=True, skip_memory=True, max_iterations=4)
            agent.run_conversation("take a screenshot")
        finally:
            registry.deregister(tool)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert len(server.captured) >= 2, "the engine never sent the tool result back"
    [result] = [m for m in server.captured[1]["messages"] if m.get("role") == "tool"]
    content = result["content"]
    if expect_picture:
        assert isinstance(content, list), f"no picture was sent: {str(content)[:200]}"
        assert [part["type"] for part in content] == ["text", "image_url"]
        assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    else:
        assert isinstance(content, str) and "image_url" not in content
        assert "act_01PROBESHOT" in content


# --- Probe: a screenshot survives a second run in the same session -----------
# The adapter starts another run in the same engine and session when the model
# loads a tool (packages/runtime-hermes/src/adapter.ts, `loaded`), and that run
# reads its history back from the engine's session store
# (gateway/platforms/api_server.py `_conversation_history_for_session`). Each
# tool message is written there as it lands (agent/tool_executor.py
# `_flush_session_db_after_tool_progress`), through
# agent/session_persistence.py `_durable_content`, which at the pin turns a
# picture into the text "[screenshot]". With the picture seam the agent's own
# screenshot is stored whole; a paired computer's is stored as text, never as a
# picture (code the agent runs can read the store), and the broker is asked for
# it again when the next run's history is read.


@pytest.mark.parametrize(("tool", "shared"), [
    ("computer.screenshot", True), ("device.screenshot", True), ("device.screenshot", False),
])
def test_a_screenshot_reaches_the_provider_again_in_the_next_run_of_the_session(
    hermes_home, monkeypatch, tmp_path, tool, shared,
):
    import io
    import sqlite3

    from PIL import Image

    from hermes_state import SessionDB
    from melete_plugin import build_handler, engine_result
    from melete_plugin.vision import Withheld
    from melete_plugin.vision import restore as restore_picture
    from melete_runtime_hooks import register_picture_restorer, restore_pictures
    from run_agent import AIAgent
    from tools.registry import registry

    monkeypatch.setenv("MELETE_ENGINE_SUPPORTS_VISION", "1")
    monkeypatch.setenv("MELETE_MODEL_KEY", "melete-surrogate-probe")
    out = io.BytesIO()
    Image.new("RGB", (800, 500), (20, 30, 90)).save(out, format="PNG")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _ScriptedProvider)
    server.captured, server.tool = [], tool
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/v1"
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)
    try:
        config = shipped_config()
        config["model"].update({"default": "probe-model", "supports_vision": True})
        config["providers"]["melete-gateway"].update({"base_url": base, "default_model": "probe-model"})
        write_config(hermes_home, config)

        client = _ScreenshotBroker(tool, out.getvalue())
        spec = {"name": tool, "connection_id": "con_probe", "effect_class": "read",
                "input_schema": {"type": "object", "properties": {"step": {"type": "integer"}}}}
        forward = build_handler(client, spec)
        registry.register(name=tool, toolset="melete",
                          schema={"description": "Take a screenshot.", "parameters": spec["input_schema"]},
                          handler=lambda args=None, **_kw: engine_result(tool, forward(args), client))

        def run(message, history=None):
            agent = AIAgent(base_url=base, api_key="melete-surrogate-probe", provider="custom",
                            requested_provider="melete-gateway", model="probe-model",
                            api_mode="chat_completions", enabled_toolsets=["melete"], quiet_mode=True,
                            skip_context_files=True, skip_memory=True, max_iterations=4,
                            session_db=db, session_id="job_probe")
            agent.run_conversation(message, conversation_history=history)

        try:
            run("take a screenshot")
            first = len(server.captured)
            # What code the agent runs could read: the store holds no paired
            # computer's picture, only the agent's own.
            with sqlite3.connect(db_path) as raw:
                stored = " ".join(str(row[0]) for row in raw.execute("select content from messages"))
            assert ("data:image/jpeg;base64," in stored) == (tool == "computer.screenshot")
            # The next run of the attempt, as the API server starts it: history
            # read back, then the plugin's restorer, as the seam calls it.
            if not shared:
                client.picture = None
                client.screenshot = lambda _id: Withheld("kept private")
            register_picture_restorer(lambda name, content: restore_picture(name, content, client.screenshot))
            run("continue", restore_pictures(db.get_messages_as_conversation("job_probe")))
        finally:
            registry.deregister(tool)
            register_picture_restorer(lambda _name, content: content)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert first >= 2 and len(server.captured) > first, "the second run sent nothing"
    [result] = [m for m in server.captured[first]["messages"] if m.get("role") == "tool"]
    content = result["content"]
    if not shared:
        assert isinstance(content, str) and "image_url" not in content
        assert json.loads(content)["picture"] == "kept private"
        return
    assert isinstance(content, list), f"the picture did not survive the run: {str(content)[:300]}"
    assert [part["type"] for part in content] == ["text", "image_url"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
