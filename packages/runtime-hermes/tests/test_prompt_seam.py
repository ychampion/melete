"""The prompt seam is applied only to the audited source, and fails closed otherwise.

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
SEAM_FILE = "agent/system_prompt.py"


def bridge():
    spec = importlib.util.spec_from_file_location(
        "observer_bridge", PACKAGE / "patches" / "observer_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def engine_source() -> str:
    root = Path(os.environ.get("MELETE_HERMES_ROOT") or REPOSITORY / ".hermes-src")
    target = root / SEAM_FILE
    if not target.exists():
        pytest.skip(f"No pinned engine checkout at {root}; set MELETE_HERMES_ROOT to run this.")
    return target.read_text(encoding="utf-8")


def test_the_seam_applies_to_the_pinned_source_and_again_to_its_own_result():
    module = bridge()
    expected_hash, changes = module.PATCHES[SEAM_FILE]
    once = module.patched(engine_source(), expected_hash, changes)
    assert once.count("# Melete prompt seam") == 4
    assert "def _host_prompt(agent: Any) -> bool:" in once
    # A checkout that already carries this seam is restored and patched to the same bytes.
    assert module.patched(once, expected_hash, changes) == once


def test_an_unreadable_configuration_keeps_the_host_blocks_out(monkeypatch):
    """The seam's own reader, run as it is inserted: a configuration that cannot
    be read leaves the host blocks out; an unset key keeps them; false drops them."""
    import sys
    import types
    from typing import Any

    module = bridge()
    _, changes = module.PATCHES[SEAM_FILE]
    helper = changes[0][1].split("def _join_tier", 1)[0]
    config = types.ModuleType("hermes_cli.config")
    package = types.ModuleType("hermes_cli")
    package.config = config
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)
    scope: dict = {"Any": Any}
    exec(compile(helper, "system_prompt.py", "exec"), scope)
    host_prompt = scope["_host_prompt"]

    def unreadable():
        raise OSError("config.yaml is unreadable")

    config.load_config_readonly = unreadable
    assert host_prompt(object()) is False
    config.load_config_readonly = lambda: {}
    assert host_prompt(object()) is True
    config.load_config_readonly = lambda: {"agent": {"host_prompt": False}}
    assert host_prompt(object()) is False


def test_a_source_that_is_not_the_audited_pin_is_refused():
    module = bridge()
    expected_hash, changes = module.PATCHES[SEAM_FILE]
    drifted = "def _join_tier(parts: List[Optional[str]]) -> str:\n    return ''\n"
    with pytest.raises(ValueError):
        module.patched(drifted, expected_hash, changes)


def test_the_image_installs_melete_identity_as_the_engine_soul():
    script = (PACKAGE / "entrypoint.sh").read_text(encoding="utf-8")
    assert 'cp /opt/melete-runtime/SOUL.md "$HERMES_HOME/SOUL.md"' in script
    assert "COPY config/SOUL.md /opt/melete-runtime/SOUL.md" in (
        PACKAGE / "Dockerfile").read_text(encoding="utf-8")
