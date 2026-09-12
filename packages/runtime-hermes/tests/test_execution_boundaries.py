"""The boundaries around a running command: its children, its output, its files.

Separate from test_execution.py because these three are about what the cell does
around the command rather than about the record it produces, and because each of
them starts real processes that outlive a naive kill if the code is wrong.

None of this is filesystem isolation. A snippet that opens an absolute path
outside the workspace still succeeds here, and test_execution.py asserts that it
does. What these tests cover is the part the plugin is genuinely responsible
for: not leaving processes behind, not holding a command's output in memory, and
not writing its own files anywhere it has not checked.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
import threading
import tracemalloc
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from melete_plugin import execution as execution_module  # noqa: E402
from melete_plugin.execution import (  # noqa: E402
    MAX_CAPTURE_BYTES,
    MAX_OUTPUT_BYTES,
    WORK_DIR_ENV,
    ExecRefused,
    run_in_cell,
)

NL = chr(10)


def test_capture_above_limit(workspace):
    total = MAX_CAPTURE_BYTES + 1024
    outcome = run_in_cell("python", {"code": f"import sys; sys.stdout.buffer.write(b'x' * {total})", "timeout_ms": 30_000})
    record = outcome["record"]
    assert record["captured_bytes"] == MAX_CAPTURE_BYTES
    assert record["total_bytes"] == total
    assert record["capture_limited"] is True
    assert record["truncated"] is True
    stored = (workspace / record["output_path"]).read_bytes()
    assert len(stored) == record["output_bytes"] == record["captured_bytes"]
    assert hashlib.sha256(stored).hexdigest() == record["output_digest"]
    assert "capture limit" in outcome["display"]
    assert "full output" not in outcome["display"]
    assert len(outcome["display"].encode()) < MAX_OUTPUT_BYTES + 512


def test_capture_memory_is_bounded_while_draining_both_streams(workspace):
    tracemalloc.start()
    try:
        outcome = run_in_cell("python", {"code": "import sys\nfor _ in range(128):\n sys.stdout.buffer.write(b'x' * 65536)\n sys.stderr.buffer.write(b'y' * 65536)", "timeout_ms": 30_000})
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 2_000_000, "pipe capture grew with emitted output"
    assert outcome["record"]["total_bytes"] == 2 * 128 * 65536
    assert outcome["record"]["captured_bytes"] == MAX_CAPTURE_BYTES


def test_a_command_within_the_cap_stores_nothing_and_still_reports_no_limit(workspace):
    outcome = run_in_cell("python", {"code": "print('small')"})
    record = outcome["record"]
    assert record["capture_limited"] is False
    assert record["total_bytes"] == record["captured_bytes"]
    assert record["truncated"] is False
    assert record["output_path"] is None
    assert list(workspace.glob(".melete-exec-*.py")) == []


def test_timeout_descendant(workspace):
    child = "import time; time.sleep(1.3); open('descendant-marker', 'w').write('alive')"
    parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {child!r}]); print('spawned',flush=True); time.sleep(30)"
    outcome = run_in_cell("python", {"code": parent, "timeout_ms": 350})
    assert outcome["record"]["timed_out"] is True
    assert outcome["record"]["exit_code"] is None
    assert "spawned" in outcome["display"], "the probe must create a descendant before timing out"
    time.sleep(1.5)
    assert not (workspace / "descendant-marker").exists(), "a descendant outlived its command"


def test_cancellation_descendant(workspace):
    child = "import time; time.sleep(1.3); open('cancel-marker', 'w').write('alive')"
    parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {child!r}]); print('spawned',flush=True); time.sleep(30)"
    cancel = threading.Event()
    timer = threading.Timer(0.35, cancel.set)
    timer.start()
    try:
        outcome = run_in_cell("python", {"code": parent}, cancel_event=cancel)
    finally:
        timer.cancel()
    assert outcome["record"]["exit_code"] is None
    assert outcome["record"]["signal"] == "SIGKILL"
    assert "spawned" in outcome["display"], "the probe must create a descendant before cancellation"
    time.sleep(1.5)
    assert not (workspace / "cancel-marker").exists(), "a cancelled descendant survived"


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    root = tmp_path / "work" / "job_01J00000000000000000000000"
    root.mkdir(parents=True)
    monkeypatch.setenv(WORK_DIR_ENV, str(root))
    monkeypatch.setenv("MELETE_JOB_ID", "job_01J00000000000000000000000")
    return root


def test_every_file_the_plugin_writes_goes_through_the_workspace_guard(workspace, monkeypatch):
    """The guard is not only for the caller's arguments.

    The scratch script and the captured output are files this module creates.
    If their location is ever computed rather than resolved, an escape there is
    one nobody is checking, so the directory they live in is resolved through
    the same guard and a value that points outside refuses the whole call.
    """
    monkeypatch.setattr(execution_module, "OUTPUT_DIR", "../outside/exec")
    with pytest.raises(ExecRefused):
        run_in_cell("python", {"code": "print(1)" + NL})
    monkeypatch.setattr(execution_module, "OUTPUT_DIR", "/etc/melete")
    with pytest.raises(ExecRefused):
        run_in_cell("python", {"code": "print(1)" + NL})


@pytest.mark.parametrize("when", ["before", "during"])
def test_plugin_output_path_escape(workspace, tmp_path, when):
    outside = tmp_path / "outside"
    outside.mkdir()
    redirected = workspace / ".melete"
    if os.name == "nt":
        redirect = f"subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', {str(redirected)!r}, {str(outside)!r}], check=True, stdout=subprocess.DEVNULL)"
    else:
        redirect = f"os.symlink({str(outside)!r}, {str(redirected)!r}, target_is_directory=True)"
    if when == "before":
        exec(redirect)
        code = f"print('x' * {MAX_OUTPUT_BYTES + 100})"
    else:
        code = "import os, subprocess, shutil\n"
        code += f"shutil.rmtree({str(redirected)!r}, ignore_errors=True)\n"
        code += redirect + f"\nprint('x' * {MAX_OUTPUT_BYTES + 100})"
    try:
        with pytest.raises(ExecRefused):
            run_in_cell("python", {"code": code})
        assert list(outside.iterdir()) == [], "plugin wrote through a redirected output directory"
    finally:
        if redirected.exists():
            if os.name == "nt":
                redirected.rmdir()
            else:
                redirected.unlink()

