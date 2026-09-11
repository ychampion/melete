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

