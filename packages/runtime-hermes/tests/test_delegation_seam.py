"""The delegation seam is applied only to the audited source, and fails closed otherwise.

The pinned engine source is read from the local checkout named by
``MELETE_HERMES_ROOT`` (or ``.hermes-src`` at the repository root). Without one
the tests that need it are skipped with the reason; the refusal test needs none.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

PACKAGE = Path(__file__).parents[1]
REPOSITORY = PACKAGE.parents[1]
SEAM_FILES = ("run_agent.py", "tools/delegate_tool.py")


def bridge():
    spec = importlib.util.spec_from_file_location(
        "observer_bridge", PACKAGE / "patches" / "observer_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine_source(name: str) -> str:
    root = Path(os.environ.get("MELETE_HERMES_ROOT") or REPOSITORY / ".hermes-src")
    target = root / name
    if not target.exists():
        pytest.skip(f"No pinned engine checkout at {root}; set MELETE_HERMES_ROOT to run this.")
    return target.read_text(encoding="utf-8")


@pytest.mark.parametrize("name, marks", [("run_agent.py", 1), ("tools/delegate_tool.py", 2)])
def test_the_seam_applies_to_the_pinned_source_and_again_to_its_own_result(name, marks):
    module = bridge()
    expected_hash, changes = module.PATCHES[name]
    once = module.patched(engine_source(name), expected_hash, changes)
    assert once.count("Melete delegation seam") == marks
    # A checkout that already carries this seam is restored and patched to the same bytes.
    assert module.patched(once, expected_hash, changes) == once


def test_no_top_level_delegation_is_left_in_the_background():
    module = bridge()
    agent = module.patched(engine_source("run_agent.py"), *module.PATCHES["run_agent.py"])
    assert 'background=not (getattr(self, "_delegate_depth", 0) > 0)' not in agent
    tool = module.patched(engine_source("tools/delegate_tool.py"), *module.PATCHES["tools/delegate_tool.py"])
    assert 'return not getattr(parent_agent, "_delegate_depth", 0) > 0' not in tool
    assert "END YOUR TURN" not in tool


@pytest.mark.parametrize("name", SEAM_FILES)
def test_a_source_that_is_not_the_audited_pin_is_refused(name):
    module = bridge()
    expected_hash, changes = module.PATCHES[name]
    with pytest.raises(ValueError):
        module.patched("def delegate_task():\n    return ''\n", expected_hash, changes)
