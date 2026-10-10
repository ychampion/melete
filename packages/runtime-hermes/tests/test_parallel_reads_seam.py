"""The parallel-reads seam: Melete's web lookups in one batch run side by side.

The pinned engine source is read from the local checkout named by
``MELETE_HERMES_ROOT`` (or ``.hermes-src`` at the repository root). Without one
the tests that need it are skipped with the reason; the others need none.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

PACKAGE = Path(__file__).parents[1]
REPOSITORY = PACKAGE.parents[1]
NAME = "agent/tool_dispatch_helpers.py"
MARK = "Melete parallel-reads seam"


def bridge():
    spec = importlib.util.spec_from_file_location(
        "observer_bridge", PACKAGE / "patches" / "observer_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hooks():
    spec = importlib.util.spec_from_file_location(
        "melete_runtime_hooks", PACKAGE / "runtime_support" / "melete_runtime_hooks.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine_source() -> str:
    root = Path(os.environ.get("MELETE_HERMES_ROOT") or REPOSITORY / ".hermes-src")
    target = root / NAME
    if not target.exists():
        pytest.skip(f"No pinned engine checkout at {root}; set MELETE_HERMES_ROOT to run this.")
    return target.read_text(encoding="utf-8")


def planner(source: str, monkeypatch):
    """The engine's batch planner from this source, with the engine modules it
    imports at load time stood in for; the planner itself is the engine's."""
    stubs = {
        "agent": types.ModuleType("agent"),
        "agent.message_metadata": types.SimpleNamespace(stamp_message_timestamp=lambda *a, **k: None),
        "agent.tool_result_classification": types.SimpleNamespace(FILE_MUTATING_TOOL_NAMES=frozenset()),
        "tools": types.ModuleType("tools"),
        "tools.threat_patterns": types.SimpleNamespace(scan_for_threats=lambda *a, **k: []),
        "melete_runtime_hooks": hooks(),
    }
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    module = types.ModuleType("tool_dispatch_helpers")
    exec(compile(source, NAME, "exec"), module.__dict__)  # noqa: S102 - the pinned engine source
    return module._plan_tool_batch_segments


def call(name: str, **arguments):
    return types.SimpleNamespace(function=types.SimpleNamespace(name=name, arguments=json.dumps(arguments)))


def test_only_lookups_that_change_nothing_run_side_by_side():
    module = hooks()
    assert all(module.parallel_read(name) for name in ("web.search", "web.fetch", "web.weather"))
    # What speaks to the person, acts, or steers the work keeps its place in line.
    for name in ("say", "ask_person", "run.finish", "run.log", "email.send", "load_tool", "memory.save"):
        assert module.parallel_read(name) is False


def test_the_seam_applies_to_the_pinned_source_and_again_to_its_own_result():
    module = bridge()
    expected_hash, changes = module.PATCHES[NAME]
    once = module.patched(engine_source(), expected_hash, changes)
    assert once.count(MARK) == 2
    assert module.patched(once, expected_hash, changes) == once


def test_web_lookups_in_one_batch_run_together_and_the_rest_keep_their_order(monkeypatch):
    module = bridge()
    source = engine_source()
    lookups = [call("web.fetch", url=f"https://example.test/{n}") for n in range(3)]

    # At the pin they are read one after another.
    assert [kind for kind, _ in planner(source, monkeypatch)(lookups)] == ["sequential"]

    plan = planner(module.patched(source, *module.PATCHES[NAME]), monkeypatch)
    assert [(kind, len(calls)) for kind, calls in plan(lookups)] == [("parallel", 3)]
    # A call that is not a lookup is a barrier: nothing crosses it.
    mixed = [lookups[0], call("web.search", query="monitors"), call("run.log", kind="finding"), lookups[1]]
    assert [(kind, len(calls)) for kind, calls in plan(mixed)] == [("parallel", 2), ("sequential", 2)]


def test_a_source_that_is_not_the_audited_pin_is_refused():
    module = bridge()
    expected_hash, changes = module.PATCHES[NAME]
    with pytest.raises(ValueError):
        module.patched("def _batch_admission():\n    return None\n", expected_hash, changes)
