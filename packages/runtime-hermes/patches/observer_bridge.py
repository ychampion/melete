"""Apply only the reviewed observer seams to Hermes v2026.9.7.

All three original source hashes are checked before any write. A subsequent
run accepts only the same patch, never an arbitrary nearby upstream version.
The support module is copied into the runtime's import root so plugin loading
and the HTTP executor share one context variable, independent of plugin aliases.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

PATCHES = {
    "hermes_cli/plugins.py": (
        "9dc62779a8bc8b3c84ac7856b9d808adeb58d07bd681f43673aee94c9c879b38",
        [("    \"on_session_finalize\", \"on_session_reset\",\n",
          "    \"on_session_finalize\", \"on_session_reset\", \"on_compaction\",  # Melete observer\n")],
    ),
    "agent/conversation_compression.py": (
        "d7296110769f0b2934cd31d43434d818c16de911463d564be068b5f169dc6aa6",
        [("    # Rotation-independent flag: the gateway uses it (not an id diff) to re-baseline\n",
          """    # Melete observer: expose actual successful compaction, without changing its result.
    if session_commit_succeeded and compression_made_progress and not compression_feasibility_skip:
        with _swallow('on_compaction observer failed: %s'):
            from hermes_cli.lifecycle import invoke_hook
            invoke_hook("on_compaction", session_id=agent.session_id,
                        compression_count=compressor.compression_count, in_place=in_place)

    # Rotation-independent flag: the gateway uses it (not an id diff) to re-baseline
""")],
    ),
    "gateway/platforms/api_server_runs.py": (
        "270f7e221b5486a6ac499732d0f5471f3f48dc0c0a0633186bc762bcb1345a39",
        [
            ("    browser_control_transport_family: Any\n",
             "    browser_control_transport_family: Any\n    attempt_id: str = \"\"  # Melete observer identity, from the idempotency header\n"),
            ("        browser_control_transport_family=_api_server._api_request_browser_control_transport_family.get())\n",
             "        browser_control_transport_family=_api_server._api_request_browser_control_transport_family.get(),\n        attempt_id=idempotency_key)\n"),
            ("def _run_agent_sync(self, run: _RunLaunch, agent, approval_notify, *, _api_server):\n",
             "def _run_agent_sync(self, run: _RunLaunch, agent, approval_notify, *, _api_server, hook_sink=None):\n"),
            ("    resets: list[tuple[Any, Callable]] = []\n    with self._profile_scope(run.request_profile):\n        try:\n",
             """    resets: list[tuple[Any, Callable]] = []
    with self._profile_scope(run.request_profile):
        try:
            # Melete observers only enqueue redacted frames. The broker owns enforcement.
            if hook_sink is not None and run.attempt_id:
                from melete_runtime_hooks import bind_capture, reset_capture
                resets.append((bind_capture(run.attempt_id, hook_sink), reset_capture))
"""),
            ("    def _text_cb(delta: Optional[str]) -> None:\n",
             """    def _hook_sink(record: dict) -> None:
        # No network or disk work on a hook callback; preserve the run queue's order.
        loop.call_soon_threadsafe(run.put_event, {**record, "run_id": run_id})

    def _text_cb(delta: Optional[str]) -> None:
"""),
            ("        extra = extra or {}\n        self._set_run_status(run_id, status, **fields, last_event=f\"run.{status}\", **extra)\n",
             """        extra = extra or {}
        if status == "failed" and run.attempt_id:
            from melete_runtime_hooks import failure_frame
            with suppress(Exception):
                run.put_event({**failure_frame(run.attempt_id), "run_id": run_id})
        self._set_run_status(run_id, status, **fields, last_event=f"run.{status}", **extra)
"""),
            ("            None, lambda: _run_agent_sync(self, run, agent, approval_notify, _api_server=_api_server))\n",
             "            None, lambda: _run_agent_sync(self, run, agent, approval_notify, _api_server=_api_server, hook_sink=_hook_sink))\n"),
        ],
    ),
}


def digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def patched(content: str, expected_hash: str, changes: list[tuple[str, str]]) -> str:
    original = content
    if digest(original) != expected_hash:
        for before, after in reversed(changes):
            if original.count(after) != 1:
                raise ValueError("Source is neither the audited pin nor the reviewed observer patch")
            original = original.replace(after, before, 1)
        if digest(original) != expected_hash:
            raise ValueError("Restored source does not match the audited pin")
    result = original
    for before, after in changes:
        if result.count(before) != 1:
            raise ValueError("Observer patch anchor is ambiguous or absent")
        result = result.replace(before, after, 1)
    return result


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    prepared = []
    for name, (expected_hash, changes) in PATCHES.items():
        target = root / name
        current = target.read_text(encoding="utf-8")
        prepared.append((target, patched(current, expected_hash, changes)))
    support = Path(__file__).resolve().parents[1] / "runtime_support" / "melete_runtime_hooks.py"
    prepared.append((root / "melete_runtime_hooks.py", support.read_text(encoding="utf-8")))
    for target, content in prepared:
        target.write_text(content, encoding="utf-8", newline="\n")
    print("Melete observer bridge applied: 3 checked source files and 1 support module")


if __name__ == "__main__":
    main()
