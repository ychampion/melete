"""Bounded observer capture shared by the plugin and the pinned HTTP bridge.

No broker decision, network call or disk write belongs here. Context variables
keep concurrent runs separate and are copied by Hermes's bounded hook workers.
The supplied sink only queues a redacted frame; Melete persists it before fan-out.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import re
import threading
from datetime import datetime, timezone
from typing import Any, Callable

HOOK_NAMES = (
    "on_session_start", "on_session_end", "on_session_finalize", "on_session_reset",
    "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call",
    "pre_api_request", "post_api_request", "api_request_error",
    "pre_approval_request", "post_approval_response", "subagent_start", "subagent_stop",
    "on_skill_lifecycle", "on_stream_start", "on_stream_end", "pre_verify", "on_compaction",
)
_ARGUMENT_NAMES = frozenset((
    "to", "subject", "body", "query", "limit", "path", "url", "method", "headers",
    "payload", "arguments", "connection_id",
))
_TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,127}\Z")


class Capture:
    def __init__(self, attempt_id: str, sink: Callable[[dict], None]):
        self.attempt_id = attempt_id
        self.sink = sink
        self.seq = 0
        self.lock = threading.Lock()
        self.delivery_failed = False
        self.closed = False


_current: contextvars.ContextVar[Capture | None] = contextvars.ContextVar("melete_hook_capture", default=None)


def bind_capture(attempt_id: str, sink: Callable[[dict], None]):
    return _current.set(Capture(attempt_id, sink))


def reset_capture(token) -> None:
    capture = _current.get()
    if capture is not None:
        with capture.lock:
            capture.closed = True
    _current.reset(token)


def observation(name: str, payload: dict[str, Any]) -> dict:
    """Only allow-listed field names survive; every argument value is erased."""
    tool = payload.get("tool_name")
    tool = tool if isinstance(tool, str) and _TOOL_NAME.fullmatch(tool) else None
    duration = payload.get("duration_ms")
    duration = duration if type(duration) in (int, float) and math.isfinite(duration) and 0 <= duration <= 86_400_000 else None
    arguments = payload.get("args")
    digest = None
    if isinstance(arguments, dict):
        # Iterate the fixed allow-list, not unbounded or attacker-named dictionary keys.
        shape = {key: "[redacted]" for key in sorted(_ARGUMENT_NAMES) if key in arguments}
        digest = hashlib.sha256(json.dumps(shape, sort_keys=True).encode()).hexdigest()
    status = payload.get("status")
    if name in ("api_request_error", "runtime_error") or status in ("error", "failed"):
        outcome = "failed"
    elif status in ("interrupted", "cancelled"):
        outcome = "interrupted"
    elif name.startswith("pre_") or name in ("on_session_start", "on_stream_start", "subagent_start"):
        outcome = "started"
    elif name.startswith("post_") or name in ("on_compaction", "on_session_end", "on_stream_end", "subagent_stop"):
        outcome = "succeeded" if status not in ("unknown", "blocked", "denied") else "unknown"
    else:
        outcome = "observed"
    return {
        "name": name,
        "tool_name": tool,
        "timing": {"captured_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "duration_ms": duration},
        "outcome": outcome,
        "redacted_args_digest": digest,
    }


def observe(name: str, payload: dict | None = None, *, build: Callable = observation) -> None:
    """Observe without vetoing or changing the run, even when the observer raises."""
    capture = _current.get()
    if capture is None:
        return
    try:
        record = build(name, payload or {})
        record["event"] = "hook.event"
    except Exception:
        record = observation(name, {})
        record.update(event="hook.error", outcome="failed", error_code="observer_failed")
    with capture.lock:
        if capture.closed:
            return
        record.update(attempt_id=capture.attempt_id, capture_id=f"{capture.attempt_id}:hook:{capture.seq}")
        capture.seq += 1
        if capture.delivery_failed:
            record.update(event="hook.error", outcome="failed", error_code="capture_gap")
        try:
            capture.sink(record)
            capture.delivery_failed = False
        except Exception:
            # A later successful capture reports the gap. No claim of durability
            # is made if the transport stays unavailable; the adapter records a gap.
            capture.delivery_failed = True


def register_observers(ctx, *, build: Callable = observation) -> None:
    for name in HOOK_NAMES:
        def callback(_name=name, **payload):
            observe(_name, payload, build=build)
            return None
        callback.__name__ = f"melete_observe_{name}"
        ctx.register_hook(name, callback)


def failure_frame(attempt_id: str) -> dict:
    """The outer HTTP failure has no plugin payload and never copies its error text."""
    return {
        **observation("runtime_error", {}),
        "event": "hook.event",
        "attempt_id": attempt_id,
        "capture_id": f"{attempt_id}:hook:runtime-error",
    }
