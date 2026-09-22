"""The sandbox terminal backend, against a scripted broker client.

Nothing here opens a socket or imports the engine: the engine's base classes
are stood in for, and the broker is a client object that records what it was
asked. The same backend is driven through the real broker over HTTP by
`apps/melete/test/integration/sandbox-terminal.test.ts`, and through the pinned
engine's own factory by `tests/test_engine_surface.py`.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime_support"))

from melete_plugin import register  # noqa: E402
from melete_plugin.broker import BrokerError  # noqa: E402
from melete_plugin.execution import child_environment  # noqa: E402
from melete_plugin.results import UNCERTAIN_INSTRUCTION  # noqa: E402
from melete_plugin.terminal_backend import (  # noqa: E402
    BACKEND_NAME,
    INTERRUPTED_STATUS,
    MAX_TIMEOUT_MS,
    SESSION_MARGIN_SECONDS,
    TERMINAL_TOOL,
    SandboxTerminal,
    engine_classes,
    register_terminal_backend,
    sandbox_connection,
    workspace_relative,
)

CONNECTION = "conn_01J0SANDBOX0000000000000A"
ACTION = "act_01J0SANDBOX0000000000000B"
TERMINAL_ENTRY = {
    "name": TERMINAL_TOOL,
    "description": "Run a command in the sandbox.",
    "input_schema": {"type": "object"},
    "effect_class": "write_reversible",
    "connection_id": CONNECTION,
}


def receipt(**detail: Any) -> Dict[str, Any]:
    base = {
        "output": "",
        "output_binary": False,
        "exit_code": 0,
        "signal": None,
        "timed_out": False,
        "truncated": False,
        "output_path": None,
        "output_bytes": 0,
        "captured_bytes": 0,
        "total_bytes": 0,
        "capture_limited": False,
        "output_digest": "d" * 64,
    }
    base.update(detail)
    return {"action_id": ACTION, "detail": base}


class ScriptedBroker:
    """Records every proposal; answers with what the test scripted."""

    def __init__(self) -> None:
        self.proposals: List[Dict[str, Any]] = []
        self.reads: List[str] = []
        self.response: Dict[str, Any] = {"action_id": ACTION, "status": "succeeded", "message": "ran"}
        self.error: Optional[BrokerError] = None
        self.receipt: Optional[Dict[str, Any]] = receipt(output="hello\n")
        self.hold: Optional[threading.Event] = None

    def propose(self, **call: Any) -> Dict[str, Any]:
        self.proposals.append(call)
        if self.hold is not None:
            self.hold.wait(10)
        if self.error is not None:
            raise self.error
        return dict(self.response)

    def action(self, action_id: str) -> Dict[str, Any]:
        self.reads.append(action_id)
        return {"id": action_id, "receipt": self.receipt}


class StandInProvider:
    """What the engine's provider ABC contributes that the backend relies on: nothing."""


class StandInEnvironment:
    def __init__(self, cwd: str, timeout: int, env: Optional[dict] = None) -> None:
        self.cwd = cwd
        self.timeout = timeout


def environment(broker: ScriptedBroker, **hooks: Any) -> Any:
    provider_cls, _env_cls, _hooks = engine_classes(StandInProvider, StandInEnvironment)
    provider = provider_cls(SandboxTerminal(broker, CONNECTION, **hooks))  # type: ignore[arg-type]
    return provider.create_environment(cwd="/work", timeout=60, task_id="t1")


# -- selection and registration ------------------------------------------------


class RecordingContext:
    def __init__(self, accept: bool = True) -> None:
        self.tools: List[Dict[str, Any]] = []
        self.hooks: Dict[str, Any] = {}
        self.providers: List[Any] = []
        self.accept = accept

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_tool(self, **kwargs: Any) -> None:
        self.tools.append(kwargs)

    def register_terminal_environment_provider(self, provider: Any) -> Any:
        self.providers.append(provider)
        return object() if self.accept else None


def test_the_backend_registers_under_its_own_name_only_when_the_broker_offers_a_sandbox():
    ctx = RecordingContext()
    provider = register_terminal_backend(
        ctx, ScriptedBroker(), [TERMINAL_ENTRY],  # type: ignore[arg-type]
        provider_base=StandInProvider, environment_base=StandInEnvironment,
    )
    assert provider is not None and provider.name == BACKEND_NAME == "melete_sandbox"
    assert ctx.providers == [provider]
    # It says what it is: a remote, disposable sandbox with no key to strip.
    assert (provider.is_remote, provider.is_container, provider.session_isolated_when_nonpersistent) == (True, True, True)
    assert provider.strip_env_keys == frozenset()

    for catalog in ([], [{**TERMINAL_ENTRY, "connection_id": None}], [{"name": "exec.run", "connection_id": "c"}]):
        empty = RecordingContext()
        assert register_terminal_backend(empty, ScriptedBroker(), catalog) is None  # type: ignore[arg-type]
        assert empty.providers == []


def test_two_sandbox_connections_select_none():
    other = {**TERMINAL_ENTRY, "connection_id": "conn_01J0SANDBOX0000000000000Z"}
    assert sandbox_connection([TERMINAL_ENTRY, other]) is None
    assert sandbox_connection([TERMINAL_ENTRY, dict(TERMINAL_ENTRY)]) == CONNECTION


def test_a_refused_registration_is_reported_and_nothing_else_happens():
    ctx = RecordingContext(accept=False)
    assert register_terminal_backend(
        ctx, ScriptedBroker(), [TERMINAL_ENTRY],  # type: ignore[arg-type]
        provider_base=StandInProvider, environment_base=StandInEnvironment,
    ) is None


def test_the_plugin_still_registers_its_tools_where_the_engine_classes_are_absent(monkeypatch):
    # Without the engine importable the backend cannot be built. The tools still
    # register, and no terminal backend exists, so TERMINAL_ENV finds nothing
    # and the terminal is unavailable rather than local.
    import melete_plugin.terminal_backend as backend

    def missing(*_args: Any, **_kwargs: Any) -> Any:
        raise ImportError("no engine here")

    monkeypatch.setattr(backend, "engine_classes", missing)

    class Client(ScriptedBroker):
        base_url = "http://broker"
        token = "cap"

        def tools(self) -> List[Dict[str, Any]]:
            return [TERMINAL_ENTRY]

    ctx = RecordingContext()
    assert register(ctx, Client()) == [TERMINAL_TOOL]  # type: ignore[arg-type]
    assert ctx.providers == []


def test_the_plugin_registers_the_backend_beside_its_tools(monkeypatch):
    import melete_plugin.terminal_backend as backend

    real = backend.engine_classes
    monkeypatch.setattr(
        backend, "engine_classes", lambda *_a, **_k: real(StandInProvider, StandInEnvironment)
    )

    class Client(ScriptedBroker):
        base_url = "http://broker"
        token = "cap"

        def tools(self) -> List[Dict[str, Any]]:
            return [TERMINAL_ENTRY]

    ctx = RecordingContext()
    register(ctx, Client())  # type: ignore[arg-type]
    assert [provider.name for provider in ctx.providers] == [BACKEND_NAME]


def test_the_plugins_child_environment_never_carries_terminal_env(monkeypatch):
    monkeypatch.setenv("TERMINAL_ENV", BACKEND_NAME)
    monkeypatch.setenv("TERMINAL_CWD", "/work")
    env = child_environment()
    assert "TERMINAL_ENV" not in env and "TERMINAL_CWD" not in env


# -- one command, one broker action -------------------------------------------


def test_a_command_is_one_broker_action_and_its_output_comes_back():
    broker = ScriptedBroker()
    result = environment(broker).execute("ls -la", cwd="/work/src", timeout=30)
    assert result == {"output": "hello\n", "returncode": 0}
    [call] = broker.proposals
    assert call["kind"] == TERMINAL_TOOL
    assert call["connection_id"] == CONNECTION
    payload = call["payload"]
    assert payload["command"] == "ls -la"
    assert payload["cwd"] == "src"
    assert payload["timeout_ms"] == 30_000
    assert call["client_ref"].endswith(payload["run"])
    # The HTTP wait covers the broker's whole budget for the command.
    assert call["timeout"] >= 30 + SESSION_MARGIN_SECONDS
    assert broker.reads == [ACTION]


def test_the_same_command_twice_is_two_runs():
    broker = ScriptedBroker()
    env = environment(broker)
    env.execute("date")
    env.execute("date")
    runs = [call["payload"]["run"] for call in broker.proposals]
    assert len(runs) == 2 and runs[0] != runs[1]
    assert broker.proposals[0]["client_ref"] != broker.proposals[1]["client_ref"]


def test_the_workspace_root_sends_no_cwd_and_a_path_outside_it_sends_nothing():
    broker = ScriptedBroker()
    env = environment(broker)
    env.execute("pwd")
    assert "cwd" not in broker.proposals[0]["payload"]
    for outside in ("/etc", "/workshop", "/work/../etc", "../up", "C:\\work"):
        result = env.execute("pwd", cwd=outside)
        assert result["returncode"] != 0 and result["output"].startswith("[not run]")
    assert len(broker.proposals) == 1
    assert workspace_relative("/work/a/./b") == "a/b"
    assert workspace_relative("a/b") == "a/b"


def test_stdin_travels_inside_the_command_so_the_ledger_shows_it():
    broker = ScriptedBroker()
    environment(broker).execute("cat", stdin_data="piped\ntext")
    command = broker.proposals[0]["payload"]["command"]
    assert command.startswith("cat << 'MELETE_STDIN_")
    assert "\npiped\ntext\n" in command


def test_a_timeout_above_the_limit_is_held_to_it_and_said():
    broker = ScriptedBroker()
    result = environment(broker).execute("make", timeout=600)
    assert broker.proposals[0]["payload"]["timeout_ms"] == MAX_TIMEOUT_MS
    assert "held to the 120s limit" in result["output"]


# -- what the engine is told ---------------------------------------------------


def test_a_timed_out_command_reports_the_engines_timeout_status():
    broker = ScriptedBroker()
    broker.receipt = receipt(output="partial", exit_code=None, signal="SIGKILL", timed_out=True)
    result = environment(broker).execute("sleep 999", timeout=1)
    assert result["returncode"] == 124
    assert result["output"].startswith("partial\n[Command timed out")


def test_truncated_capped_and_binary_output_are_each_said():
    broker = ScriptedBroker()
    broker.receipt = receipt(
        output="\ufffd\ufffdhead",
        output_binary=True,
        truncated=True,
        output_path=".melete/exec/act_1.out",
        output_bytes=4_194_304,
        captured_bytes=4_194_304,
        total_bytes=9_000_000,
        capture_limited=True,
        exit_code=3,
    )
    result = environment(broker).execute("cat big.bin")
    assert result["returncode"] == 3
    output = result["output"]
    assert "[binary output" in output and "d" * 64 in output
    assert "the full capture is in the job workspace at .melete/exec/act_1.out" in output
    assert "wrote 9000000 bytes; only the first 4194304 were kept" in output


def test_a_command_with_no_exit_status_is_not_reported_as_success():
    broker = ScriptedBroker()
    broker.receipt = receipt(exit_code=None, signal="SIGTERM")
    result = environment(broker).execute("true")
    assert result["returncode"] != 0 and "SIGTERM" in result["output"]


def test_a_refusal_says_the_command_did_not_run():
    broker = ScriptedBroker()
    broker.error = BrokerError("scope_denied", "not granted", status=403)
    result = environment(broker).execute("rm -rf /work")
    assert result["returncode"] != 0 and result["output"].startswith("[not run] scope_denied")
    broker.error = None
    broker.response = {"action_id": ACTION, "status": "failed", "message": "the provider refused the start"}
    assert "[not run] the provider refused the start" in environment(broker).execute("x")["output"]
    broker.response = {"action_id": ACTION, "status": "needs_approval", "requires_approval": True}
    assert "not run" in environment(broker).execute("x")["output"]


@pytest.mark.parametrize(
    "error",
    [BrokerError("unreachable", "timed out"), BrokerError("internal_error", "Broker request failed", status=500)],
)
def test_a_lost_acknowledgement_is_unknown_and_is_never_sent_again(error):
    broker = ScriptedBroker()
    broker.error = error
    result = environment(broker).execute("deploy.sh")
    assert result["returncode"] != 0
    assert result["output"].startswith("[outcome unknown]")
    assert UNCERTAIN_INSTRUCTION in result["output"]
    assert len(broker.proposals) == 1
    assert broker.reads == []


def test_an_unknown_outcome_from_the_broker_is_reported_unknown_once():
    broker = ScriptedBroker()
    broker.response = {"action_id": ACTION, "status": "unknown", "message": "Melete cannot confirm"}
    result = environment(broker).execute("deploy.sh")
    assert result["output"].startswith(f"[outcome unknown (action {ACTION})]")
    assert len(broker.proposals) == 1 and broker.reads == []


def test_an_unreadable_receipt_is_read_again_but_the_command_is_not_sent_again():
    broker = ScriptedBroker()
    broker.receipt = None
    result = environment(broker).execute("build")
    assert "could not be read back" in result["output"] and "Do not run it again" in result["output"]
    assert len(broker.proposals) == 1 and broker.reads == [ACTION, ACTION]


def test_an_interrupt_stops_the_wait_and_reports_the_outcome_unknown():
    broker = ScriptedBroker()
    broker.hold = threading.Event()
    flag = threading.Event()
    beats: List[int] = []
    env = environment(broker, interrupted=flag.is_set, heartbeat=lambda: beats.append(1))
    timer = threading.Timer(0.5, flag.set)
    timer.start()
    try:
        result = env.execute("sleep 100", timeout=100)
    finally:
        broker.hold.set()
        timer.cancel()
    assert result["returncode"] == INTERRUPTED_STATUS
    assert "already sent" in result["output"] and UNCERTAIN_INSTRUCTION in result["output"]
    assert len(broker.proposals) == 1
    assert beats, "the engine's activity heartbeat ran while the command was waited on"


def test_execute_never_raises_because_the_engine_would_send_the_command_again():
    class Exploding(ScriptedBroker):
        def action(self, action_id: str) -> Dict[str, Any]:
            raise ValueError("boom")

    broker = Exploding()
    result = environment(broker).execute("make")
    assert result["output"].startswith("[outcome unknown]")
    assert len(broker.proposals) == 1


def test_cleanup_sends_nothing_and_can_run_twice():
    broker = ScriptedBroker()
    env = environment(broker)
    env.cleanup()
    env.cleanup()
    assert env.closed == 2
    assert broker.proposals == [] and broker.reads == []


def test_no_local_process_is_ever_started():
    env = environment(ScriptedBroker())
    with pytest.raises(RuntimeError):
        env._run_bash("true")
