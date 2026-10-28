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
import stat
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
DEFAULT_TIMEOUT_MS = 300_000
MAX_TIMEOUT_MS = 600_000
MAX_OUTPUT_BYTES = 16_384
PREVIEW_HEAD_BYTES = 4_096
PREVIEW_TAIL_BYTES = 12_288
MAX_CAPTURE_BYTES = 4_194_304
OUTPUT_DIR = ".melete/exec"

#: Where the cgroup counts its kills for memory, and its limit. Read before and
#: after a command that ended on a KILL, to tell a memory kill from any other.
MEMORY_EVENTS = "/sys/fs/cgroup/memory.events"
MEMORY_MAX = "/sys/fs/cgroup/memory.max"

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


#: Folders 2775 and files 0664 in the setgid workspace the service shares.
SHARED_UMASK = 0o002


def _shared_through_group(root: Path) -> bool:
    """Whether the workspace is shared with the service through a setgid group.

    Only then is what a command makes opened to the group: on a host where the
    engine runs as the person, their primary group is not the service's.
    """
    try:
        return bool(os.stat(root).st_mode & stat.S_ISGID)
    except OSError:
        return False


def _limits(shared: bool) -> Optional[Any]:
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
        # The workspace is shared with the service through a group: what the
        # command makes is group-writable, so the service can move it on.
        if shared:
            os.umask(SHARED_UMASK)
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
    """Drain the pipe, keeping the start of the output and its newest bytes.

    The first `PREVIEW_HEAD_BYTES` are kept as they come. After them only the
    newest bytes are kept, up to `MAX_CAPTURE_BYTES` in all, so a long run
    still shows how it ended. What is kept is stored once the pipe closes.
    """

    def __init__(self, root: Path):
        self.root = root
        self.head = bytearray()
        self.tail = bytearray()
        self.total_bytes = 0
        self.output_path = None
        self.error = None
        self.done = threading.Event()

    @property
    def kept(self) -> bytes:
        return bytes(self.head) + bytes(self.tail)

    @property
    def captured_bytes(self) -> int:
        return len(self.head) + len(self.tail)

    @property
    def gap(self) -> bool:
        """Whether bytes were dropped between the start and the newest ones."""
        return self.total_bytes > self.captured_bytes

    def drain(self, pipe) -> None:
        room = MAX_CAPTURE_BYTES - PREVIEW_HEAD_BYTES
        try:
            while chunk := pipe.read(65536):
                self.total_bytes += len(chunk)
                start = max(0, PREVIEW_HEAD_BYTES - len(self.head))
                self.head.extend(chunk[:start])
                self.tail.extend(chunk[start:])
                if len(self.tail) > room:
                    del self.tail[: len(self.tail) - room]
        except BaseException as error:
            self.error = error
        finally:
            pipe.close()
            self.done.set()

    def store(self) -> None:
        """Write what was kept, when it does not fit the preview."""
        kept = self.kept
        if len(kept) <= MAX_OUTPUT_BYTES and not self.gap:
            return
        resolve_in_workspace(self.root, OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
        self.output_path = f"{OUTPUT_DIR}/{uuid.uuid4().hex}.log"
        with resolve_in_workspace(self.root, self.output_path).open("xb") as store:
            store.write(kept)


def _head_end(data: bytes, room: int) -> int:
    """After the last whole line in the last quarter of the room, else a character boundary."""
    end = min(room, len(data))
    line = data.rfind(b"\n", 0, end)
    if line >= 0 and line + 1 >= end - room // 4:
        return line + 1
    while 0 < end < len(data) and data[end] & 0xC0 == 0x80:
        end -= 1
    return end


def _tail_start(data: bytes, room: int) -> int:
    """At a line's start in the first quarter of the room, else a character boundary."""
    start = max(0, len(data) - room)
    line = data.find(b"\n", start, start + room // 4)
    if line >= 0 and line + 1 < len(data):
        return line + 1
    while start < len(data) and data[start] & 0xC0 == 0x80:
        start += 1
    return start


def elision_line(elided: int, lines: int, path: Optional[str], at_least: bool) -> str:
    """Mirrors `execElisionLine` in packages/contracts/src/execution.ts."""
    more = "at least " if at_least else ""
    where = f"; the kept output is at {path}" if path else ""
    return f"\n⟦melete: {more}{elided} bytes ({more}{lines} lines) of output left out here{where}⟧\n"


def preview_of(kept: bytes, gap: bool, path: Optional[str]) -> Tuple[str, int, int]:
    """The start and the end of the output, with one line saying what was left out between them.

    Mirrors `previewOf` in apps/melete/src/sandbox/marker.ts: the whole preview,
    the line included, fits `MAX_OUTPUT_BYTES`, since the line's own bytes come
    out of the end's room.
    """
    if len(kept) <= MAX_OUTPUT_BYTES and not gap:
        return kept.decode("utf-8", errors="replace"), 0, 0
    head = _head_end(kept, PREVIEW_HEAD_BYTES)
    own_line = head == 0 or kept[head - 1 : head] == b"\n"

    def separator_for(tail: int) -> Tuple[int, int, bytes]:
        middle = kept[head:tail]
        elided = len(middle) + (1 if gap else 0)
        lines = middle.count(b"\n")
        line = elision_line(elided, lines, path, gap)
        return elided, lines, (line[1:] if own_line else line).encode("utf-8")

    # The line's digits only grow as the end shrinks, so this settles.
    reserved = 0
    tail = len(kept)
    elided, lines, separator = separator_for(tail)
    for _ in range(8):
        tail = max(head, _tail_start(kept, max(0, PREVIEW_TAIL_BYTES - reserved)))
        elided, lines, separator = separator_for(tail)
        if len(separator) <= reserved:
            break
        reserved = len(separator)
    # Only a cap smaller than the line itself leaves no room for it: the start alone, then.
    if head + len(separator) + len(kept) - tail > MAX_OUTPUT_BYTES:
        start = _head_end(kept, MAX_OUTPUT_BYTES)
        return kept[:start].decode("utf-8", errors="replace"), len(kept) - start, 0
    shown = (
        kept[:head].decode("utf-8", errors="replace")
        + separator.decode("utf-8")
        + kept[tail:].decode("utf-8", errors="replace")
    )
    return shown, elided, lines


def _oom_kills() -> Optional[int]:
    """How often the cgroup has killed for memory, or None where it does not say."""
    try:
        with open(MEMORY_EVENTS, encoding="utf-8") as handle:
            for line in handle:
                name, _, value = line.partition(" ")
                if name == "oom_kill":
                    return int(value)
    except (OSError, ValueError):
        return None
    return None


def _memory_limit() -> Optional[int]:
    try:
        with open(MEMORY_MAX, encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError:
        return None
    return int(value) if value.isdigit() and int(value) > 0 else None


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
    cancelled = False
    kills_before = _oom_kills()
    try:
        process = subprocess.Popen(  # noqa: S603 - argv is built here, never shell-interpolated
            argv,
            cwd=str(cwd),
            env=child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            preexec_fn=_limits(_shared_through_group(root)) if os.name != "nt" else None,  # noqa: PLW1509
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
                cancelled = not timed_out
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
        capture.store()
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

    kept = capture.kept
    digest = hashlib.sha256(kept).hexdigest()
    capture_limited = capture.gap
    truncated = len(kept) > MAX_OUTPUT_BYTES or capture.gap
    output_path = capture.output_path
    shown, elided_bytes, elided_lines = preview_of(kept, capture.gap, output_path)
    memory_limit = None
    killed = exit_code == 137 or (hasattr(signal, "SIGKILL") and exit_code == -signal.SIGKILL)
    if timed_out:
        stopped_by = "timeout"
    elif cancelled:
        stopped_by = "person"
    elif killed and kills_before is not None and (_oom_kills() or 0) > kills_before:
        stopped_by = "memory_limit"
        memory_limit = _memory_limit()
    elif exit_code is None or exit_code < 0:
        stopped_by = "signal"
    else:
        stopped_by = "exit"

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
        "elided_bytes": elided_bytes,
        "elided_lines": elided_lines,
        "stopped_by": stopped_by,
        "output_path": output_path,
    }
    if memory_limit is not None:
        record["memory_limit_bytes"] = memory_limit
    return {"record": record, "display": shown}

