"""Lifecycle callbacks are observers, including when capture fails."""
import contextvars
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime_support"))

from melete_runtime_hooks import HOOK_NAMES, bind_capture, observation, register_observers, reset_capture
from melete_runtime_hooks import failure_frame


class Context:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


def test_registered_hooks_preserve_order_and_erase_payloads():
    ctx = Context()
    register_observers(ctx)
    assert tuple(ctx.hooks) == HOOK_NAMES
    records = []
    token = bind_capture("att_test", records.append)
    names = ("on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "on_compaction", "api_request_error", "post_llm_call", "on_session_end")
    try:
        for name in names:
            assert ctx.hooks[name](tool_name="test.read", args={"body": "private text", "api_key": "secret-value"}, result="full result", error_message="credential text", duration_ms=12) is None
    finally:
        reset_capture(token)
    assert [record["name"] for record in records] == list(names)
    assert [record["capture_id"] for record in records] == [f"att_test:hook:{n}" for n in range(len(names))]
    assert all(record["event"] == "hook.event" for record in records)
    assert records[4]["outcome"] == "succeeded"
    assert records[5]["outcome"] == "failed"
    assert records[2]["redacted_args_digest"] == observation("pre_tool_call", {"args": {"body": "different", "api_key": "different-secret"}})["redacted_args_digest"]
    encoded = json.dumps(records)
    for secret in ("private text", "secret-value", "full result", "credential text", "api_key"):
        assert secret not in encoded


def test_on_compaction_scalars_survive_redaction():
    """A compaction's count and mode are the two facts the ledger needs from it."""
    ctx = Context()
    register_observers(ctx)
    records = []
    token = bind_capture("att_compaction", records.append)
    try:
        assert ctx.hooks["on_compaction"](
            session_id="ses_private_identifier", compression_count=2, in_place=True,
        ) is None
        # Every other boundary keeps no detail at all, whatever it is handed.
        assert ctx.hooks["post_tool_call"](compression_count=2, in_place=True) is None
    finally:
        reset_capture(token)
    assert records[0]["detail"] == {"compression_count": 2, "in_place": True}
    assert "detail" not in records[1]
    # The session id is an identifier, not a scalar, and never leaves the runtime.
    assert "ses_private_identifier" not in json.dumps(records)


def test_on_compaction_detail_refuses_anything_but_the_named_scalars():
    ctx = Context()
    register_observers(ctx)
    records = []
    token = bind_capture("att_compaction_bad", records.append)
    try:
        assert ctx.hooks["on_compaction"](compression_count="2", in_place="yes") is None
        assert ctx.hooks["on_compaction"](compression_count=True, in_place=1) is None
        assert ctx.hooks["on_compaction"](compression_count=-1) is None
    finally:
        reset_capture(token)
    assert all("detail" not in record for record in records)


def test_throwing_observer_records_hook_error_and_next_hook_still_runs():
    def throwing(name, payload):
        if name == "pre_tool_call":
            raise ValueError("secret exception text")
        return observation(name, payload)

    ctx = Context()
    register_observers(ctx, build=throwing)
    records = []
    token = bind_capture("att_failure", records.append)
    try:
        assert ctx.hooks["pre_tool_call"](args={"token": "secret"}) is None
        assert ctx.hooks["post_tool_call"](status="ok") is None
    finally:
        reset_capture(token)
    assert records[0]["event"] == "hook.error"
    assert records[0]["error_code"] == "observer_failed"
    assert records[1]["event"] == "hook.event"
    assert "secret" not in json.dumps(records)


def test_hermes_copied_context_workers_keep_attempts_separate():
    ctx = Context()
    register_observers(ctx)
    first, second = [], []
    with ThreadPoolExecutor(max_workers=2) as workers:
        token = bind_capture("att_first", first.append)
        first_context = contextvars.copy_context()
        nested = bind_capture("att_second", second.append)
        try:
            second_context = contextvars.copy_context()
            workers.submit(first_context.run, ctx.hooks["pre_tool_call"]).result()
            workers.submit(second_context.run, ctx.hooks["pre_tool_call"]).result()
        finally:
            reset_capture(nested)
            reset_capture(token)
    assert first[0]["attempt_id"] == "att_first"
    assert second[0]["attempt_id"] == "att_second"
    assert first[0]["capture_id"] != second[0]["capture_id"]


def test_observer_delivery_failure_cannot_veto_and_later_capture_reports_gap():
    ctx = Context()
    register_observers(ctx)
    records = []
    calls = 0

    def sink(record):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("unavailable")
        records.append(record)

    token = bind_capture("att_delivery", sink)
    try:
        assert ctx.hooks["pre_tool_call"]() is None
        assert ctx.hooks["post_tool_call"]() is None
    finally:
        reset_capture(token)
    assert records[0]["event"] == "hook.error"
    assert records[0]["error_code"] == "capture_gap"
    assert records[0]["capture_id"] == "att_delivery:hook:1"


def test_discovery_continuations_keep_attempt_identity_without_capture_collisions():
    ctx = Context()
    register_observers(ctx)
    records = []
    for key in ("att_discovery", "att_discovery:tools:1", "att_discovery:tools:2"):
        token = bind_capture(key, records.append)
        try:
            ctx.hooks["on_session_start"]()
        finally:
            reset_capture(token)
    assert {record["attempt_id"] for record in records} == {"att_discovery"}
    assert [record["capture_id"] for record in records] == [
        "att_discovery:hook:0", "att_discovery:hook:tools:1:0", "att_discovery:hook:tools:2:0",
    ]
    failure = failure_frame("att_discovery:tools:2")
    assert failure["attempt_id"] == "att_discovery"
    assert failure["capture_id"] == "att_discovery:hook:tools:2:runtime-error"
