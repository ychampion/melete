"""Running code in the cell: what the tool itself refuses, and what it records.

Everything here runs a real subprocess in a real temporary directory. Nothing
is mocked, because the thing under test is a process boundary.

What these tests do NOT establish is filesystem confinement. On a developer
laptop this module runs as an ordinary process with the developer's own
permissions, so a snippet that opens an absolute path outside the workspace
succeeds, and one test below asserts exactly that rather than pretending
otherwise. In the container the same snippet fails because the root filesystem
is read-only and `/work` is the only writable mount; that is the container's
property, asserted by the egress and isolation probe, not by this file.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import melete_plugin.execution as execution  # noqa: E402
from melete_plugin.execution import (  # noqa: E402
    MAX_OUTPUT_BYTES,
    SECRET_ENV,
    WORK_DIR_ENV,
    ExecRefused,
    child_environment,
    resolve_in_workspace,
    run_in_cell,
    workspace_root,
)


@pytest.fixture()
def workspace(tmp_path, monkeypatch):
    """A job workspace with a sibling job beside it, as /work's parent has."""
    root = tmp_path / "work" / "job_01J00000000000000000000000"
    root.mkdir(parents=True)
    other = tmp_path / "work" / "job_01J0000000000000000000000Z"
    other.mkdir(parents=True)
    (other / "secret.txt").write_text("another job's work", encoding="utf-8")
    monkeypatch.setenv(WORK_DIR_ENV, str(root))
    monkeypatch.setenv("MELETE_JOB_ID", "job_01J00000000000000000000000")
    for name in SECRET_ENV:
        monkeypatch.setenv(name, "a-secret-this-process-holds")
    return root


def test_the_workspace_is_the_mount_itself(monkeypatch):
    """Every launch mounts only this job's subpath at `/work`, so `/work` is the
    job's directory; a `/work/<job>` beneath it does not exist in the cell."""
    monkeypatch.delenv(WORK_DIR_ENV, raising=False)
    monkeypatch.setenv("MELETE_JOB_ID", "job_01J00000000000000000000000")
    assert workspace_root().as_posix() == "/work"
    monkeypatch.setenv(WORK_DIR_ENV, "/somewhere/else")
    assert workspace_root().as_posix() == "/somewhere/else"


def test_a_python_snippet_writes_a_file_and_the_record_describes_the_run(workspace):
    outcome = run_in_cell(
        "python",
        {
            "code": (
                "import csv\n"
                "with open('out.csv', 'w', newline='') as handle:\n"
                "    writer = csv.writer(handle)\n"
                "    writer.writerow(['item', 'amount'])\n"
                "    writer.writerow(['desk', '60'])\n"
                "print('wrote out.csv')\n"
            )
        },
    )
    record = outcome["record"]
    assert record["exit_code"] == 0
    assert record["timed_out"] is False
    assert record["truncated"] is False
    assert record["cwd"] == "."
    assert record["language"] == "python"
    assert len(record["output_digest"]) == 64
    assert "wrote out.csv" in outcome["display"]
    assert (workspace / "out.csv").read_text(encoding="utf-8").startswith("item,amount")


def test_a_failing_command_reports_its_exit_code_rather_than_raising(workspace):
    outcome = run_in_cell("python", {"code": "import sys; sys.exit(3)"})
    assert outcome["record"]["exit_code"] == 3
    assert outcome["record"]["timed_out"] is False


def test_a_working_directory_outside_the_workspace_starts_no_process(workspace):
    for cwd in ["..", "../job_01J0000000000000000000000Z", "/etc", "a/../.."]:
        with pytest.raises(ExecRefused):
            run_in_cell("python", {"code": "print(1)", "cwd": cwd})


def test_reading_another_jobs_directory_is_refused_by_the_path_guard(workspace):
    with pytest.raises(ExecRefused):
        resolve_in_workspace(workspace, "../job_01J0000000000000000000000Z/secret.txt")
    with pytest.raises(ExecRefused):
        resolve_in_workspace(workspace, "/etc/passwd")
    # A path that stays inside resolves to a real location under the workspace.
    inside = resolve_in_workspace(workspace, "reports/out.csv")
    assert str(inside).startswith(str(workspace.resolve()))


def test_a_command_past_the_time_cap_is_killed_and_the_kill_is_recorded(workspace):
    outcome = run_in_cell(
        "python",
        {"code": "import time\nprint('starting', flush=True)\ntime.sleep(30)\n", "timeout_ms": 1500},
    )
    record = outcome["record"]
    assert record["timed_out"] is True
    assert record["exit_code"] is None
    assert record["duration_ms"] < 20_000


def test_output_above_the_cap_is_truncated_with_a_marker_and_stored_in_full(workspace):
    outcome = run_in_cell(
        "python",
        {"code": f"print('x' * {MAX_OUTPUT_BYTES * 2})", "timeout_ms": 30_000},
    )
    record = outcome["record"]
    assert record["truncated"] is True
    assert record["output_path"] is not None
    assert "of output left out here" in outcome["display"]
    assert len(outcome["display"].encode("utf-8")) < MAX_OUTPUT_BYTES + 512
    stored = (workspace / record["output_path"]).read_bytes()
    assert len(stored) == record["output_bytes"]
    import hashlib

    assert hashlib.sha256(stored).hexdigest() == record["output_digest"]


def test_the_child_never_sees_the_attempt_capability_or_the_model_key(workspace):
    environment = child_environment()
    for name in SECRET_ENV:
        assert name not in environment
    outcome = run_in_cell(
        "python",
        {
            "code": (
                "import os\n"
                "print('|'.join(n for n in ("
                "'MELETE_ATTEMPT_TOKEN','MELETE_MODEL_KEY','API_SERVER_KEY',"
                "'HTTP_PROXY','HTTPS_PROXY') if n in os.environ))\n"
            )
        },
    )
    assert outcome["record"]["exit_code"] == 0
    assert outcome["display"].strip() == ""


def test_an_empty_or_oversized_command_is_refused_before_anything_runs(workspace):
    with pytest.raises(ExecRefused):
        run_in_cell("python", {"code": "   "})
    with pytest.raises(ExecRefused):
        run_in_cell("python", {"code": "x" * 20_001})
    with pytest.raises(ExecRefused):
        run_in_cell("lisp", {"code": "(print 1)"})
    with pytest.raises(ExecRefused):
        run_in_cell("python", {"code": "print(1)", "timeout_ms": 0})


def test_a_shell_command_runs_in_the_workspace(workspace):
    (workspace / "hello.txt").write_text("hi", encoding="utf-8")
    command = "type hello.txt" if os.name == "nt" else "cat hello.txt"
    outcome = run_in_cell("shell", {"command": command})
    assert outcome["record"]["exit_code"] == 0
    assert "hi" in outcome["display"]


def test_the_filesystem_outside_the_workspace_is_the_containers_job_not_this_modules(
    workspace, tmp_path
):
    """Documented honestly: locally, a snippet can write outside /work.

    This is the boundary the cell's own image provides and this process does
    not. If this test ever starts failing on a developer machine it means the
    machine grew a sandbox, not that the plugin acquired one.
    """
    target = (tmp_path / "escaped.txt").as_posix()
    outcome = run_in_cell(
        "python",
        {"code": f"open({target!r}, 'w').write('out')"},
    )
    assert outcome["record"]["exit_code"] == 0
    assert (tmp_path / "escaped.txt").exists()



def _make_in_cell():
    previous = os.umask(0o022)
    try:
        return run_in_cell(
            "python",
            {
                "code": (
                    "import os\n"
                    "os.makedirs('output/slides')\n"
                    "open('output/slides/deck.pptx', 'wb').write(b'PK')\n"
                )
            },
        )
    finally:
        os.umask(previous)


@pytest.mark.skipif(os.name == "nt", reason="file modes and umask are POSIX")
def test_what_cell_code_makes_the_service_can_manage(workspace):
    """A workspace shared with the service through a setgid group: a folder or
    file the agent's code makes must be group-writable, or the service cannot
    move a file out of it into the person's Files."""
    workspace.chmod(0o2770)
    assert _make_in_cell()["record"]["exit_code"] == 0
    for made in ("output", "output/slides", "output/slides/deck.pptx"):
        assert (workspace / made).stat().st_mode & 0o020, f"{made} is not group-writable"


@pytest.mark.skipif(os.name == "nt", reason="file modes and umask are POSIX")
def test_a_workspace_shared_with_no_group_keeps_the_umask(workspace):
    """Run on a host with no shared group, the person's usual umask stands:
    what the agent makes is not opened to everyone in their primary group."""
    workspace.chmod(0o755)
    assert _make_in_cell()["record"]["exit_code"] == 0
    for made in ("output", "output/slides", "output/slides/deck.pptx"):
        assert not (workspace / made).stat().st_mode & 0o020, f"{made} is group-writable"


def test_output_that_does_not_fit_shows_its_start_and_its_end_with_what_was_left_out(workspace):
    # Bytes, not print: a line ends in \n on every platform.
    code = (
        "import sys\n"
        "out = sys.stdout.buffer\n"
        "for n in range(1, 3001):\n"
        "    out.write(f'ok test_{n}\\n'.encode())\n"
        "out.write(b'FAILED test_checkout_rounding: expected 10.00, got 9.99\\n')\n"
        "out.flush()\n"
        "raise SystemExit(1)\n"
    )
    outcome = run_in_cell("python", {"code": code, "timeout_ms": 30_000})
    record = outcome["record"]
    shown = outcome["display"]
    assert record["exit_code"] == 1
    assert record["stopped_by"] == "exit"
    assert record["capture_limited"] is False
    assert shown.startswith("ok test_1\nok test_2\n")
    assert shown.endswith("FAILED test_checkout_rounding: expected 10.00, got 9.99\n")
    separator = next(line for line in shown.split("\n") if line.startswith("⟦melete:"))
    assert separator == (
        f"⟦melete: {record['elided_bytes']} bytes ({record['elided_lines']} lines) of output left out "
        f"here; the kept output is at {record['output_path']}⟧"
    )
    head, tail = shown.split(separator + "\n")
    assert len(head.encode()) <= 4096 and len(tail.encode()) <= 12_288
    assert len(head.encode()) + len(tail.encode()) + record["elided_bytes"] == record["output_bytes"]
    stored = (workspace / record["output_path"]).read_bytes()
    assert stored.decode().count("\n") == 3001


def test_above_the_capture_cap_the_start_and_the_newest_output_are_kept(workspace, monkeypatch):
    monkeypatch.setattr(execution, "MAX_CAPTURE_BYTES", 10_000)
    monkeypatch.setattr(execution, "MAX_OUTPUT_BYTES", 2_000)
    monkeypatch.setattr(execution, "PREVIEW_HEAD_BYTES", 500)
    monkeypatch.setattr(execution, "PREVIEW_TAIL_BYTES", 1_500)
    code = (
        "import sys\n"
        "for n in range(5000):\n"
        "    sys.stdout.buffer.write(f'line {n:05d}\\n'.encode())\n"
    )
    outcome = run_in_cell("python", {"code": code, "timeout_ms": 30_000})
    record = outcome["record"]
    everything = "".join(f"line {n:05d}\n" for n in range(5000)).encode()
    assert record["total_bytes"] == len(everything)
    assert record["captured_bytes"] == 10_000
    assert record["capture_limited"] is True
    stored = (workspace / record["output_path"]).read_bytes()
    assert stored == everything[:500] + everything[-9_500:]
    assert outcome["display"].startswith("line 00000\n")
    assert outcome["display"].endswith("line 04999\n")
    assert "⟦melete: at least " in outcome["display"]


def test_a_command_stopped_by_its_time_says_so(workspace):
    outcome = run_in_cell(
        "python", {"code": "import time\ntime.sleep(30)\n", "timeout_ms": 500}
    )
    assert outcome["record"]["stopped_by"] == "timeout"
    assert "memory_limit_bytes" not in outcome["record"]


def test_a_kill_for_memory_is_told_apart_from_any_other_kill(workspace, monkeypatch, tmp_path):
    events = tmp_path / "memory.events"
    limit = tmp_path / "memory.max"
    events.write_text("oom 0\noom_kill 0\n", encoding="utf-8")
    limit.write_text("268435456\n", encoding="utf-8")
    monkeypatch.setattr(execution, "MEMORY_EVENTS", str(events))
    monkeypatch.setattr(execution, "MEMORY_MAX", str(limit))
    code = (
        "import pathlib\n"
        f"pathlib.Path({str(events)!r}).write_text('oom 1\\noom_kill 1\\n')\n"
        "raise SystemExit(137)\n"
    )
    record = run_in_cell("python", {"code": code, "timeout_ms": 30_000})["record"]
    assert record["stopped_by"] == "memory_limit"
    assert record["memory_limit_bytes"] == 268_435_456
    # The same exit with the count unchanged is an ordinary exit.
    record = run_in_cell("python", {"code": "raise SystemExit(137)", "timeout_ms": 30_000})["record"]
    assert record["stopped_by"] == "exit"
    assert "memory_limit_bytes" not in record
