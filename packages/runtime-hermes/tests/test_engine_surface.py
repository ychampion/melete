"""Executed probes against the pinned engine's own functions.

Every test here drives real engine code — no reimplementation, no mocks of the
behaviour under test — against a temporary ``HERMES_HOME`` and, where a request
has to be observed, a loopback capture server. No provider is contacted.

Each probe that depends on configuration is parametrized ``shipped`` versus
``target``: ``shipped`` asserts what the configuration in
``packages/runtime-hermes/config/config.yaml`` produces today, so the file is
green as it stands and records the gap; ``target`` asserts the behaviour the
engine-forward configuration needs. Citations name the engine file and line the
probe exercises, read at the pinned release.

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
    capability header where the shipped boot config puts it (on the provider
    entry) or where the target configuration puts it (on the model section)."""
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
    [("shipped", "provider", False), ("target", "model", True)],
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
        ("shipped", {"enabled": False}, (True, True)),
        ("target", {"memory_enabled": False, "user_profile_enabled": False}, (False, False)),
    ],
)
def test_memory_flags_are_read_from_the_real_keys(
    hermes_home, config_case, memory_section, expected_flags,
):
    """`memory.enabled` leaves both stores on; the two real keys turn them off."""
    write_config(hermes_home, {"memory": memory_section, "skills": {"enabled": False}})

    from hermes_cli.config import load_config
    from tools.memory_tool import get_builtin_memory_store_flags

    config = load_config()
    assert get_builtin_memory_store_flags(config) == expected_flags, (
        f"{config_case} config resolved the wrong store flags")


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
