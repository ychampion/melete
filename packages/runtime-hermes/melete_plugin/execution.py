"""Running a command inside the cell, and recording what ran.

The cell is a container on a network with no route out, with a read-only root
filesystem and one writable mount. Inside that, running code is not a new power:
whatever a command does lands in `/work`, which the owner can read, diff and
delete. So the terminal is on, and no approval stands in front of it. What the
broker asks for instead is a record, and this module produces one.

The order is forced by the topology. The broker cannot run the command, because
the broker process holds the credentials this container must never reach. So the
broker admits the intent first; the command runs here and settles afterwards. The tool's
arguments and the action's payload are two different shapes.

What this file enforces, and what it does not:

* It enforces the *arguments*. A working directory that is not inside the job
  workspace is refused before any process starts, as is a path with a symbolic
  link, a drive letter, or `..` in it. The broker refuses the same thing again
  when the record arrives, so a cell that lied about where it ran is caught at
  the ledger even though the ledger could not have stopped it.
* It enforces the *caps*. Wall clock, captured bytes, and what the model is
  shown. A command past its cap is killed, and the kill is recorded rather than
  smoothed over.
* It scrubs the *environment*. The child gets no attempt capability and no model
  surrogate, so a snippet cannot read the credential this process authenticates
  with, and cannot spend the job's model budget behind the ledger's back.
* It does NOT enforce the filesystem. A snippet that opens an absolute path
  outside the workspace is stopped by the container's read-only root and by
  `/work` being its only writable mount, not by anything here. On a developer
  laptop, where this module runs as an ordinary process, that protection is
  absent, and the tests say so rather than pretending otherwise.
"""

from __future__ import annotations

import hashlib
import os
import re
import signal
import subprocess  # noqa: S404 - running a command is this module's whole purpose
import sys
import time
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

#: The job workspace. In the container this is the one writable mount and it is
#: the job's directory; locally it is wherever the harness put it.
WORK_DIR_ENV = "MELETE_WORK_DIR"
DEFAULT_WORK_DIR = "/work"

#: Mirrors packages/contracts/src/execution.ts. Both sides are checked against
#: these numbers, and the broker refuses a record that exceeds them.
DEFAULT_TIMEOUT_MS = 30_000
MAX_TIMEOUT_MS = 120_000
MAX_OUTPUT_BYTES = 16_384
MAX_CAPTURE_BYTES = 4_194_304
OUTPUT_DIR = ".melete/exec"

#: Names whose values would let a snippet act as the attempt. The child is given
#: an allow-list rather than a deny-list, but these are named so the reason is
#: readable and so a test can assert on them.
SECRET_ENV = ("MELETE_ATTEMPT_TOKEN", "MELETE_MODEL_KEY", "API_SERVER_KEY")

_SAFE_SEGMENT = re.compile(r"^[^\\/:*?\"<>|\x00]+$")


class ExecRefused(ValueError):
    """The arguments were refused. Nothing was started."""


def workspace_root() -> Path:
    """The directory every execution is confined to.

    In the container `/work` is the job's own directory: every launch mounts
    only that job's subpath of the work volume there, and makes it the working
    directory. The service reads the same directory as `<workRoot>/<job>` when
    it checks the record, and a record's paths are relative to it, so the two
    sides agree. `MELETE_WORK_DIR` overrides it for the local runs, where the
    workspace is a temporary directory rather than a mount.
    """
    override = os.environ.get(WORK_DIR_ENV)
    return Path(override) if override else Path(DEFAULT_WORK_DIR)


def resolve_in_workspace(root: Path, relative: str) -> Path:
    """Resolve a relative path inside the workspace, refusing every escape.

    Refused: absolute paths, drive letters, `..`, empty segments, and anything
    whose resolved location is outside the workspace root. Symbolic links are
    refused by resolving the whole path and comparing against the resolved root,
    so a link planted earlier in the same job cannot widen the next command.
    """
    if not relative or relative == ".":
        return Path(os.path.realpath(root))
    if "\x00" in relative:
        raise ExecRefused("a path may not contain a null byte")
    candidate = Path(relative)
    if candidate.is_absolute() or candidate.drive or relative.startswith(("/", "\\")):
        raise ExecRefused(f"path must be relative to the job workspace: {relative}")
    for part in candidate.parts:
        if part in ("..", "") or not _SAFE_SEGMENT.match(part):
            raise ExecRefused(f"path traversal is not allowed: {relative}")
    base = Path(os.path.realpath(root))
    resolved = Path(os.path.realpath(base / candidate))
    if resolved != base and base not in resolved.parents:
        raise ExecRefused(f"path resolves outside the job workspace: {relative}")
    return resolved


def child_environment() -> Dict[str, str]:
    """The environment a command is given: enough to run, nothing to spend.

    An allow-list, because a deny-list is one forgotten name away from handing a
    snippet the attempt capability.
    """
    source = os.environ
    allowed = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT", "COMSPEC")
    env = {name: source[name] for name in allowed if name in source}
    env["MELETE_JOB_ID"] = source.get("MELETE_JOB_ID", "")
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # No network by topology, and no proxy hint either: a snippet that reads
    # HTTP_PROXY would otherwise learn the broker's address and try to use it
    # with a credential it does not have.
    return env


def _limits() -> Optional[Any]:
    """POSIX resource caps for the child, or None where they do not exist.

    Belt and braces on top of the container's own limits: a command cannot write
    a file larger than the capture cap, cannot map unbounded memory, and cannot
    spend more CPU than its wall clock allows.
    """
    try:
        import resource  # noqa: PLC0415 - POSIX only, imported where it is used
    except ImportError:
        return None

    def apply() -> None:  # pragma: no cover - runs in the forked child
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_CAPTURE_BYTES, MAX_CAPTURE_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (MAX_TIMEOUT_MS // 1000, MAX_TIMEOUT_MS // 1000))

    return apply


def _argv(language: str, command: str, root: Path, relative_cwd: str) -> Tuple[list, Optional[str]]:
    """The process to start, and the scratch file to remove afterwards.

    A Python snippet is written to a file rather than passed with `-c`, because
    a traceback from `-c` names `<string>` and the line numbers of a heredoc are
    the one thing a model cannot guess its way out of.
    """
    if language == "python":
        relative = (Path(relative_cwd) / f".melete-exec-{uuid.uuid4().hex}.py").as_posix()
        script = resolve_in_workspace(root, relative)
        # Exclusive creation prevents a pre-existing link from being followed.
        with script.open("x", encoding="utf-8") as handle:
            handle.write(command)
        return [sys.executable, str(script)], relative
    if os.name == "nt":
        return ["cmd.exe", "/d", "/c", command], None
    return ["/bin/sh", "-c", command], None


def _kill_tree(process: subprocess.Popen) -> None:
    """Terminate the command's descendants before reaping their parent."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait()


class _Capture:
    """Drain the pipe with a bounded preview and a capped spill file."""

    def __init__(self, root: Path):
        self.root = root
        self.preview = bytearray()
        self.captured_bytes = 0
        self.total_bytes = 0
        self.digest = hashlib.sha256()
        self.output_path = None
        self.error = None
        self.done = threading.Event()

    def drain(self, pipe) -> None:
        store = None
        try:
            while chunk := pipe.read(65536):
                self.total_bytes += len(chunk)
                retained = chunk[:max(0, MAX_CAPTURE_BYTES - self.captured_bytes)]
                if not retained:
                    continue
                if store is None and self.captured_bytes + len(retained) > MAX_OUTPUT_BYTES:
                    resolve_in_workspace(self.root, OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
                    self.output_path = f"{OUTPUT_DIR}/{uuid.uuid4().hex}.log"
                    store = resolve_in_workspace(self.root, self.output_path).open("xb")
                    store.write(self.preview)
                if store is not None:
                    resolve_in_workspace(self.root, self.output_path)
                    store.write(retained)
                self.preview.extend(retained[:max(0, MAX_OUTPUT_BYTES - len(self.preview))])
                self.digest.update(retained)
                self.captured_bytes += len(retained)
        except BaseException as error:
            self.error = error
        finally:
            if store is not None:
                store.close()
            pipe.close()
            self.done.set()


def run_in_cell(language: str, arguments: Dict[str, Any], cancel_event: Optional[threading.Event] = None) -> Dict[str, Any]:
    """Run one command and return both the record and what to show the model.

    Returns ``{"record": ..., "display": ...}``. The record is the action payload
    the broker validates against `EXEC_RECORD_JSON_SCHEMA`; the display is the
    truncated output the model reads. Refusals raise `ExecRefused` and start
    nothing, which is the difference between a command that was not allowed and
    a command that failed.
    """
    if language not in ("shell", "python"):
        raise ExecRefused(f"unknown execution language: {language}")
    command = arguments.get("code") if language == "python" else arguments.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ExecRefused("a command is required")
    if len(command) > 20_000:
        raise ExecRefused("the command is longer than the cell will run")

    root = Path(os.path.realpath(workspace_root()))
    if not root.is_dir():
        raise ExecRefused(f"the job workspace is not present at {root}")
    relative_cwd = arguments.get("cwd") or "."
    if not isinstance(relative_cwd, str):
        raise ExecRefused("cwd must be a string")
    cwd = resolve_in_workspace(root, relative_cwd)
    if not cwd.is_dir():
        raise ExecRefused(f"the working directory does not exist: {relative_cwd}")

    requested = arguments.get("timeout_ms", DEFAULT_TIMEOUT_MS)
    if not isinstance(requested, int) or isinstance(requested, bool) or requested <= 0:
        raise ExecRefused("timeout_ms must be a positive integer")
    timeout_ms = min(requested, MAX_TIMEOUT_MS)

    # Validate even when output is small: storage is a plugin-owned operation,
    # and an already redirected directory must refuse before code is started.
    resolve_in_workspace(root, OUTPUT_DIR)
    argv, scratch = _argv(language, command, root, relative_cwd)
    started = time.monotonic()
    timed_out = False
    signal_name = None
    process = None
    capture = _Capture(root)
    reader = None
    try:
        process = subprocess.Popen(  # noqa: S603 - argv is built here, never shell-interpolated
            argv,
            cwd=str(cwd),
            env=child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            preexec_fn=_limits() if os.name != "nt" else None,  # noqa: PLW1509
            start_new_session=os.name != "nt",
        )
        reader = threading.Thread(target=capture.drain, args=(process.stdout,), daemon=True)
        reader.start()
        while True:
            if capture.error is not None:
                raise capture.error
            if capture.done.is_set() and process.poll() is not None:
                exit_code = process.returncode
                break
            remaining = timeout_ms / 1000 - (time.monotonic() - started)
            if remaining <= 0 or (cancel_event is not None and cancel_event.is_set()):
                timed_out = remaining <= 0
                signal_name = "SIGKILL"
                _kill_tree(process)
                exit_code = None
                break
            time.sleep(min(remaining, 0.02))
        reader.join(timeout=5)
        if not capture.done.is_set():
            raise ExecRefused("command output pipe did not close after process-tree termination")
        if capture.error is not None:
            raise capture.error
        if exit_code is not None and exit_code < 0:
            signal_name = f"SIG{-exit_code}"
    except BaseException:
        # KeyboardInterrupt and cooperative cancellation must not strand a
        # command merely because no ordinary result will be returned.
        if process is not None:
            _kill_tree(process)
        if reader is not None:
            reader.join(timeout=5)
        raise
    finally:
        duration_ms = int((time.monotonic() - started) * 1000)
        if scratch is not None:
            try:
                resolve_in_workspace(root, scratch).unlink()
            except OSError:
                pass

    digest = capture.digest.hexdigest()
    capture_limited = capture.total_bytes > capture.captured_bytes
    truncated = capture.total_bytes > MAX_OUTPUT_BYTES
    output_path = capture.output_path
    shown = capture.preview.decode("utf-8", errors="replace")
    if truncated:
        label = "captured prefix" if capture_limited else "full output"
        loss = f", capture limit enforced; {capture.total_bytes} bytes emitted" if capture_limited else ""
        shown += (
            f"\n[melete: output truncated, {capture.captured_bytes} bytes captured{loss}"
            f"{', ' + label + ' at ' + output_path if output_path else ''}]\n"
        )

    record = {
        "language": language,
        "command": command,
        "cwd": relative_cwd,
        "exit_code": exit_code,
        "signal": signal_name,
        "timed_out": timed_out,
        "duration_ms": duration_ms,
        "output_digest": digest,
        "output_bytes": capture.captured_bytes,
        "captured_bytes": capture.captured_bytes,
        "total_bytes": capture.total_bytes,
        "capture_limited": capture_limited,
        "truncated": truncated,
        "output_path": output_path,
    }
    return {"record": record, "display": shown}

