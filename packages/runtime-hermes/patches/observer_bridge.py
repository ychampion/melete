"""Apply only the reviewed seams to Hermes v2026.9.7.

Three observer seams, one prompt seam, one reasoning seam and one picture
seam. The prompt seam: `agent.host_prompt: false` leaves out the engine's own
product pointer, its profile line and its host runtime block, which describe
the engine's install rather than the attempt. It is inert unless that key is
set. The reasoning seam puts the model's reasoning on a run's event stream as
`reasoning.delta`, beside the `message.delta` text the stream already carries.
The picture seam keeps a screenshot in the session store, so the next run of
the same session still shows it to the model.

All five original source hashes are checked before any write. A subsequent
run accepts only the same patch, or a named earlier version of it, never an
arbitrary nearby upstream version.
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
          """    # Melete observer: expose the actual compaction, without changing its result.
    # A pre-LLM feasibility skip drops the middle deterministically instead of
    # summarizing it; it is reported as observed, never as a summarized success,
    # so the ledger shows the drop for what it was.
    if session_commit_succeeded and compression_made_progress:
        with _swallow('on_compaction observer failed: %s'):
            from hermes_cli.lifecycle import invoke_hook
            invoke_hook("on_compaction", session_id=agent.session_id,
                        compression_count=compressor.compression_count, in_place=in_place,
                        used_fallback=compression_used_fallback,
                        status="observed" if compression_feasibility_skip else "succeeded")

    # Rotation-independent flag: the gateway uses it (not an id diff) to re-baseline
""")],
    ),
    "agent/system_prompt.py": (
        "0ed123e2360daab3c3fe839624c971a132b8ba56ee30c602a00c77d5828a621f",
        [
            ("def _join_tier(parts: List[Optional[str]]) -> str:\n",
             """def _host_prompt(agent: Any) -> bool:  # Melete prompt seam
    \"\"\"``agent.host_prompt`` (default true). False leaves out the blocks that
    describe the engine's own install rather than the run: the product pointer,
    the profile line and the host runtime environment. A configuration that
    cannot be read leaves them out too: they are never shown by accident.\"\"\"
    try:
        from hermes_cli.config import load_config_readonly
        section = load_config_readonly().get("agent") or {}
    except Exception:
        return False
    return bool(section.get("host_prompt", True)) if isinstance(section, dict) else True


def _join_tier(parts: List[Optional[str]]) -> str:
"""),
            ("    parts += [_active_profile_line(agent), _platform_hint(agent)]\n",
             "    parts += [_active_profile_line(agent) if _host_prompt(agent) else \"\", _platform_hint(agent)]  # Melete prompt seam\n"),
            ("    stable_parts.extend(_alibaba_identity_part(agent))\n",
             """    if not _host_prompt(agent):  # Melete prompt seam
        stable_parts[_help_guidance_slot] = ""
    stable_parts.extend(_alibaba_identity_part(agent))
"""),
            ("    environment_hints = _pb.build_environment_hints()\n",
             "    environment_hints = _pb.build_environment_hints() if _host_prompt(agent) else \"\"  # Melete prompt seam\n"),
        ],
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
            # The reasoning seam: what the model writes as reasoning reaches the
            # run's stream as it is written, as its text already does.
            ("    def _finish(status: str, extra: Optional[dict] = None, **fields: Any) -> None:\n",
             """    def _reasoning_cb(delta: Optional[str]) -> None:  # Melete reasoning seam
        if not delta or run_id not in self._run_streams:
            return
        with suppress(Exception):
            loop.call_soon_threadsafe(run.put_event, _run_event(run_id, "reasoning.delta", delta=delta))

    def _finish(status: str, extra: Optional[dict] = None, **fields: Any) -> None:
"""),
            ("        self._active_run_agents[run_id] = agent\n",
             "        agent.reasoning_callback = _reasoning_cb  # Melete reasoning seam\n        self._active_run_agents[run_id] = agent\n"),
        ],
    ),
    # The picture seam. Each tool message is written to the session store as it
    # lands, and the next run of the same session reads its history back from
    # there. At the pin a picture is stored as the word "[screenshot]", so a
    # screenshot taken just before the adapter starts another run (after a tool
    # is loaded) reached the model as its receipt and that word. A tool result
    # made only of text and pictures is stored whole instead; the store already
    # keeps list content as JSON and gives it back as a list.
    "agent/session_persistence.py": (
        "e6c6c9787ec6d8140b58978efc6208ca9f6e0bc0aaaa2e07574a90120217adda",
        [
            ("def _durable_content(content: Any) -> Any:\n",
             """def _keeps_pictures(role: Any, content: Any) -> bool:  # Melete picture seam
    \"\"\"A tool result of text and pictures only, with at least one picture.\"\"\"
    return (role == "tool" and isinstance(content, list)
            and any(isinstance(p, dict) and p.get("type") in _IMAGE_PART_TYPES for p in content)
            and all(isinstance(p, dict) and (p.get("type") == "text" or p.get("type") in _IMAGE_PART_TYPES)
                    for p in content))


def _durable_content(content: Any) -> Any:
"""),
            ("        \"role\": role, \"content\": _durable_content(content), \"tool_name\": msg.get(\"tool_name\"),\n",
             "        \"role\": role,  # Melete picture seam\n"
             "        \"content\": content if _keeps_pictures(role, content) else _durable_content(content),\n"
             "        \"tool_name\": msg.get(\"tool_name\"),\n"),
        ],
    ),
}

# A checkout patched by an earlier reviewed version of a file's patch is
# restored through that version, named by how many of the current changes it made.
EARLIER_VERSIONS = {
    # Before the reasoning seam.
    "gateway/platforms/api_server_runs.py": (7,),
}


def digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


def restored(content: str, changes: list[tuple[str, str]]) -> str | None:
    """The source with these changes taken out, or None when it does not carry them."""
    original = content
    for before, after in reversed(changes):
        if original.count(after) != 1:
            return None
        original = original.replace(after, before, 1)
    return original


def patched(
    content: str,
    expected_hash: str,
    changes: list[tuple[str, str]],
    earlier: tuple[int, ...] = (),
) -> str:
    original = content
    if digest(original) != expected_hash:
        candidates = [restored(content, changes)]
        candidates += [restored(content, changes[:count]) for count in earlier]
        found = [candidate for candidate in candidates if candidate is not None]
        if not found:
            raise ValueError(
                "Source is neither the audited pin nor a reviewed version of the observer "
                "patch. A checkout carrying another patch has to be restored to the pinned "
                "commit before this one is applied."
            )
        pinned = [candidate for candidate in found if digest(candidate) == expected_hash]
        if not pinned:
            raise ValueError("Restored source does not match the audited pin")
        original = pinned[0]
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
        prepared.append(
            (target, patched(current, expected_hash, changes, EARLIER_VERSIONS.get(name, ())))
        )
    support = Path(__file__).resolve().parents[1] / "runtime_support" / "melete_runtime_hooks.py"
    prepared.append((root / "melete_runtime_hooks.py", support.read_text(encoding="utf-8")))
    for target, content in prepared:
        target.write_text(content, encoding="utf-8", newline="\n")
    print("Melete observer bridge applied: 5 checked source files and 1 support module")


if __name__ == "__main__":
    main()
