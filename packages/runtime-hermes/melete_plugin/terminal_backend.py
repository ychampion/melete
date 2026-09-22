"""The engine's terminal, run by the broker in the space's sandbox.

When a space has an active sandbox connection, the attempt's catalog carries
one `terminal.run` entry, the supervisor pins `TERMINAL_ENV` to
`melete_sandbox`, and the engine's own terminal tool sends every command here.
This backend runs nothing itself. Each command becomes one brokered
`terminal.run` action under the attempt capability: the broker admits it, runs
it in the sandbox it owns, records what came back and hands the result to this
process on the receipt. The cell holds no provider credential and never
contacts a provider.

What the engine is told follows the ledger, not a guess:

* A command the broker ran returns its exit status and the output preview the
  service kept, with the truncation, capture limit and binary marking it
  recorded.
* A command the broker refused, or that parked for approval, returns a nonzero
  status and says it did not run.
* A command whose answer never arrived -- the broker said `unknown`, the
  connection dropped, or the wait was interrupted -- is reported as unknown and
  is never sent again from here. `execute()` never raises once a command may
  have been sent, because the engine's terminal retries a raising `execute()`
  and a retry would be a second run.

The engine-facing classes are built on the engine's own base classes, imported
only when a space has a sandbox. Everything that decides what happens lives in
`SandboxTerminal`, which imports nothing from the engine.
"""

from __future__ import annotations

import logging
import os
import posixpath
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from .broker import BrokerClient, BrokerError
from .results import END_TURN_INSTRUCTION, FAILURE_INSTRUCTION, SUCCEEDED, UNCERTAIN_INSTRUCTION

logger = logging.getLogger("melete.plugin.terminal")

#: The `terminal.backend` / `TERMINAL_ENV` value. Mirrors `TerminalBackend` in
#: packages/runtime-hermes/src/engine-config.ts. Not a built-in engine name, so
#: the engine's registry accepts it and nothing can shadow a built-in with it.
BACKEND_NAME = "melete_sandbox"

#: The brokered tool every command becomes.
TERMINAL_TOOL = "terminal.run"

#: The sandbox's job workspace. Commands run here or below it.
WORK_DIR = "/work"

#: Mirrors EXEC_LIMITS in packages/contracts/src/execution.ts: the broker
#: refuses a timeout outside these bounds.
MIN_TIMEOUT_MS = 100
MAX_TIMEOUT_MS = 120_000

#: Mirrors SESSION_MARGIN_MS in apps/melete/src/connectors/sandbox-exec.ts: the
#: broker may take this long beyond the command's own timeout to open the
#: session and sync the workspace before it calls the outcome unknown.
SESSION_MARGIN_SECONDS = 120

#: Past the broker's own budget, so the broker's answer arrives before this
#: process gives up on it.
ANSWER_SLACK_SECONDS = 30

#: How often the wait checks for an interrupt.
POLL_SECONDS = 0.2

#: What a command that never answered returns. The engine reads nonzero as
#: "did not succeed"; the text says why and that it must not be run again.
UNKNOWN_STATUS = -1
REFUSED_STATUS = -1
TIMED_OUT_STATUS = 124
INTERRUPTED_STATUS = 130


def sandbox_connection(catalog: List[Dict[str, Any]]) -> Optional[str]:
    """The sandbox connection this attempt's terminal runs through, or None.

    Exactly one `terminal.run` entry with a connection is required: a space has
    one execution backend, and with two the choice would be this process's,
    which is not a choice it may make.
    """
    connections = {
        str(tool["connection_id"])
        for tool in catalog
        if isinstance(tool, dict) and tool.get("name") == TERMINAL_TOOL and tool.get("connection_id")
    }
    if len(connections) != 1:
        if connections:
            logger.error("melete: %d sandbox connections offered; the terminal uses none", len(connections))
        return None
    return connections.pop()


def workspace_relative(cwd: Optional[str]) -> Optional[str]:
    """A working directory as the broker takes it: relative to `/work`.

    None when the directory is outside the workspace, which the broker would
    refuse anyway; refusing here means nothing is proposed at all.
    """
    raw = (cwd or WORK_DIR).strip() or WORK_DIR
    if "\x00" in raw or "\\" in raw:
        return None
    if raw.startswith("/"):
        normal = posixpath.normpath(raw)
        if normal == WORK_DIR:
            return "."
        if not normal.startswith(WORK_DIR + "/"):
            return None
        relative = normal[len(WORK_DIR) + 1:]
    else:
        relative = posixpath.normpath(raw)
    if relative == ".":
        return "."
    if relative.startswith("..") or any(part in ("", "..") for part in relative.split("/")):
        return None
    return relative


def _with_stdin(command: str, stdin_data: Optional[str]) -> str:
    """Stdin travels inside the command as a heredoc, so the ledger shows it.

    The broker's `terminal.run` takes a command and nothing else; the engine's
    own cloud backends embed stdin the same way.
    """
    if not stdin_data:
        return command
    delimiter = f"MELETE_STDIN_{uuid.uuid4().hex[:12]}"
    return f"{command} << '{delimiter}'\n{stdin_data}\n{delimiter}"


def _result(output: str, returncode: int) -> Dict[str, Any]:
    return {"output": output, "returncode": returncode}


def _unknown(reason: str, action_id: Optional[str] = None) -> Dict[str, Any]:
    named = f" (action {action_id})" if action_id else ""
    return _result(
        f"[outcome unknown{named}] {reason}. The command may have run in the sandbox. "
        + UNCERTAIN_INSTRUCTION,
        UNKNOWN_STATUS,
    )


def _refused(message: str) -> Dict[str, Any]:
    return _result(f"[not run] {message}. {FAILURE_INSTRUCTION}", REFUSED_STATUS)


class SandboxTerminal:
    """Forwards one command at a time to the broker and reports what it said."""

    def __init__(
        self,
        client: BrokerClient,
        connection_id: str,
        *,
        interrupted: Callable[[], bool] = lambda: False,
        heartbeat: Callable[[], None] = lambda: None,
        run_name: Callable[[], str] = lambda: uuid.uuid4().hex,
    ) -> None:
        self._client = client
        self._connection_id = connection_id
        self._interrupted = interrupted
        self._heartbeat = heartbeat
        self._run_name = run_name

    def run(
        self,
        command: str,
        cwd: Optional[str],
        timeout_seconds: Optional[float],
        stdin_data: Optional[str] = None,
    ) -> Dict[str, Any]:
        relative = workspace_relative(cwd)
        if relative is None:
            return _refused(f"commands run inside the job workspace {WORK_DIR}, not in {cwd!r}")
        requested_ms = int(float(timeout_seconds or MAX_TIMEOUT_MS / 1000) * 1000)
        timeout_ms = max(MIN_TIMEOUT_MS, min(requested_ms, MAX_TIMEOUT_MS))
        run = self._run_name()
        payload: Dict[str, Any] = {
            "command": _with_stdin(command, stdin_data),
            "timeout_ms": timeout_ms,
            # A fresh name per call: running the same command again is a new
            # run, not a repeat the broker would answer from the first one.
            "run": run,
        }
        if relative != ".":
            payload["cwd"] = relative
        scope = os.environ.get("MELETE_JOB_ID") or os.environ.get("MELETE_ATTEMPT_ID") or "job"
        answer = self._propose(payload, f"{scope}:{TERMINAL_TOOL}:{run}", timeout_ms)
        if "result" in answer:
            return answer["result"]
        result = self._settle(answer["response"])
        if requested_ms > MAX_TIMEOUT_MS:
            result["output"] += f"\n[the timeout was held to the {MAX_TIMEOUT_MS // 1000}s limit]"
        return result

    def _propose(self, payload: Dict[str, Any], client_ref: str, timeout_ms: int) -> Dict[str, Any]:
        """Send once and wait, watching for an interrupt. Never re-sent."""
        wait_seconds = timeout_ms / 1000 + SESSION_MARGIN_SECONDS + ANSWER_SLACK_SECONDS
        box: Dict[str, Any] = {}
        done = threading.Event()

        def send() -> None:
            try:
                box["response"] = self._client.propose(
                    kind=TERMINAL_TOOL,
                    connection_id=self._connection_id,
                    payload=payload,
                    client_ref=client_ref,
                    timeout=wait_seconds,
                )
            except BrokerError as error:
                box["error"] = error
            except Exception as error:  # noqa: BLE001 - anything else is an unanswered send
                box["error"] = BrokerError("unreachable", str(error))
            finally:
                done.set()

        threading.Thread(target=send, name="melete-terminal-send", daemon=True).start()
        while not done.wait(POLL_SECONDS):
            self._heartbeat()
            if self._interrupted():
                # The broker keeps the command; this process only stops waiting.
                return {
                    "result": _result(
                        "[Command interrupted] The command was already sent to the sandbox and "
                        "its outcome is unknown here. " + UNCERTAIN_INSTRUCTION,
                        INTERRUPTED_STATUS,
                    )
                }
        error = box.get("error")
        if isinstance(error, BrokerError):
            if error.code == "unreachable" or (error.status or 0) >= 500:
                return {"result": _unknown(f"the broker's answer was lost: {error.message}")}
            return {"result": _refused(f"{error.code}: {error.message}")}
        response = box.get("response")
        if not isinstance(response, dict):
            return {"result": _unknown("the broker answered with nothing usable")}
        return {"response": response}

    def _settle(self, response: Dict[str, Any]) -> Dict[str, Any]:
        status = response.get("status")
        action_id = response.get("action_id")
        message = str(response.get("message") or status or "no reason given")
        if status == "needs_approval" or (status == "proposed" and response.get("requires_approval")):
            return _result(f"[waiting for approval, not run] {END_TURN_INSTRUCTION}", REFUSED_STATUS)
        if status in ("failed", "denied"):
            return _refused(message)
        if status != SUCCEEDED or not action_id:
            return _unknown(message, str(action_id) if action_id else None)
        receipt = self._receipt(str(action_id))
        detail = receipt.get("detail") if isinstance(receipt, dict) else None
        if not isinstance(detail, dict):
            # It ran; only the read-back failed. Reads are safe to repeat, and
            # were, so say what is known without inventing a status.
            return _result(
                f"[the command ran (action {action_id}) but its result could not be read back] "
                "Do not run it again; read the action's receipt instead.",
                UNKNOWN_STATUS,
            )
        return _from_detail(detail)

    def _receipt(self, action_id: str) -> Optional[Dict[str, Any]]:
        for _ in range(2):
            try:
                receipt = self._client.action(action_id).get("receipt")
                if isinstance(receipt, dict):
                    return receipt
            except BrokerError as error:
                logger.warning("melete: terminal receipt read failed for %s: %s", action_id, error.message)
        return None


def _from_detail(detail: Dict[str, Any]) -> Dict[str, Any]:
    """The engine's `{"output", "returncode"}` from the receipt the broker wrote."""
    output = str(detail.get("output") or "")
    notes: List[str] = []
    if detail.get("output_binary"):
        notes.append(
            "[binary output: bytes that are not text are shown replaced; "
            f"sha256 of the real bytes {detail.get('output_digest')}]"
        )
    if detail.get("truncated"):
        stored = detail.get("output_path")
        where = f"; the full capture is in the job workspace at {stored}" if stored else ""
        notes.append(
            f"[output truncated: showing the start of {detail.get('output_bytes')} captured bytes{where}]"
        )
    if detail.get("capture_limited"):
        notes.append(
            f"[the command wrote {detail.get('total_bytes')} bytes; "
            f"only the first {detail.get('captured_bytes')} were kept]"
        )
    exit_code = detail.get("exit_code")
    if detail.get("timed_out"):
        returncode = TIMED_OUT_STATUS
        notes.append("[Command timed out and was stopped in the sandbox]")
    elif isinstance(exit_code, int) and not isinstance(exit_code, bool):
        returncode = exit_code
    else:
        returncode = UNKNOWN_STATUS
        notes.append(f"[the command ended without an exit status (signal {detail.get('signal')})]")
    if notes:
        output = (output + "\n" if output else "") + "\n".join(notes)
    return _result(output, returncode)


def engine_classes(provider_base: Any = None, environment_base: Any = None) -> Any:
    """Build the provider and environment on the engine's base classes.

    The engine's registrar checks the provider's type, so these subclass its
    ABCs; the imports happen only here, and tests may pass stand-ins.
    """
    hooks: Dict[str, Callable[..., Any]] = {}
    if provider_base is None:
        from agent.terminal_env_provider import TerminalEnvironmentProvider as provider_base  # noqa: N813
    if environment_base is None:
        from tools.environments.base import BaseEnvironment as environment_base  # noqa: N813
        from tools.environments.base import touch_activity_if_due
        from tools.interrupt import is_interrupted

        state = {"last_touch": time.monotonic(), "start": time.monotonic()}
        hooks["interrupted"] = is_interrupted
        hooks["heartbeat"] = lambda: touch_activity_if_due(state, "sandbox command running")

    class MeleteSandboxEnvironment(environment_base):  # type: ignore[misc, valid-type]
        """One engine task's terminal. Every command is one broker action."""

        def __init__(self, terminal: SandboxTerminal, cwd: str, timeout: int) -> None:
            environment_base.__init__(self, cwd=cwd, timeout=timeout)
            self._terminal = terminal
            self.closed = 0

        def execute(
            self,
            command: str,
            cwd: str = "",
            *,
            timeout: Optional[int] = None,
            stdin_data: Optional[str] = None,
            **_engine_options: Any,
        ) -> Dict[str, Any]:
            try:
                return self._terminal.run(command, cwd or self.cwd, timeout or self.timeout, stdin_data)
            except Exception as error:  # noqa: BLE001 - raising would make the engine send it again
                logger.exception("melete: the sandbox terminal failed")
                return _unknown(f"the sandbox terminal failed: {type(error).__name__}")

        def _run_bash(self, cmd_string: str, **_options: Any) -> Any:
            # Commands are forwarded whole through execute(); there is no local shell.
            raise RuntimeError("the Melete sandbox terminal runs no local process")

        def cleanup(self) -> None:
            # The broker owns the sandbox session and its lease; there is
            # nothing in this process to release, and nothing is sent.
            self.closed += 1

    class MeleteSandboxProvider(provider_base):  # type: ignore[misc, valid-type]
        """Declares itself as what it is: a remote, disposable Linux sandbox."""

        is_remote = True
        is_container = True
        session_isolated_when_nonpersistent = True

        def __init__(self, terminal: SandboxTerminal) -> None:
            self._terminal = terminal

        @property
        def name(self) -> str:
            return BACKEND_NAME

        @property
        def display_name(self) -> str:
            return "Melete sandbox"

        @property
        def env_description(self) -> str:
            return "a remote Linux sandbox with the job workspace at /work"

        @property
        def cache_path_base(self) -> Optional[str]:
            # The sandbox user's own home; the provider picks the user.
            return "~/.hermes"

        @property
        def strip_env_keys(self) -> frozenset:
            # No provider credential exists in this process to strip.
            return frozenset()

        def is_available(self) -> bool:
            return True

        def create_environment(self, *, cwd: str = WORK_DIR, timeout: int = 120, **_kwargs: Any) -> Any:
            return MeleteSandboxEnvironment(self._terminal, cwd or WORK_DIR, timeout)

    return MeleteSandboxProvider, MeleteSandboxEnvironment, hooks


def register_terminal_backend(
    ctx: Any,
    client: BrokerClient,
    catalog: List[Dict[str, Any]],
    *,
    provider_base: Any = None,
    environment_base: Any = None,
) -> Optional[Any]:
    """Register the backend when this attempt has a sandbox; None otherwise.

    With no sandbox nothing is registered, so a `TERMINAL_ENV` naming this
    backend finds no such backend and the terminal is unavailable, never local.
    """
    connection_id = sandbox_connection(catalog)
    if connection_id is None:
        return None
    registrar = getattr(ctx, "register_terminal_environment_provider", None)
    if registrar is None:
        logger.error("melete: this engine has no terminal backend seam; the sandbox terminal is off")
        return None
    try:
        provider_cls, _environment_cls, hooks = engine_classes(provider_base, environment_base)
    except ImportError as error:
        logger.error("melete: the engine's terminal base classes are missing (%s)", error)
        return None
    provider = provider_cls(SandboxTerminal(client, connection_id, **hooks))
    if registrar(provider) is None:
        logger.error("melete: the engine refused the sandbox terminal backend")
        return None
    logger.info("melete: terminal commands run in the sandbox of connection %s", connection_id)
    return provider
