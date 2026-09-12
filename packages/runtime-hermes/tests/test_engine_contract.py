"""The registered handler must satisfy the pinned registry, not just our helper."""
import json

import pytest

from test_plugin import ACTION, RecordingContext, broker, client
from melete_plugin import register


@pytest.mark.parametrize("status", ["succeeded", "needs_approval", "unknown", "failed"])
def test_registered_results_are_json_text(client, broker, status):
    broker.propose_response.update(status=status, requires_approval=status == "needs_approval")
    ctx = RecordingContext()
    register(ctx, client)
    result = ctx.tools[1]["handler"]({"query": "café"})
    assert isinstance(result, str)
    assert json.loads(result)["status"] == status
    if status == "succeeded":
        assert json.loads(result)["receipt"] == {"external_ref": "mid-1"}
        assert json.loads(result)["action_id"] == ACTION


def test_runtime_metadata_is_not_proposed_or_hashed(client, broker):
    ctx = RecordingContext()
    register(ctx, client)
    handler = ctx.tools[1]["handler"]
    handler({"query": "owner request"}, task_id="first", session_id="s1")
    handler({"query": "owner request"}, task_id="second", session_id="s2")
    proposals = [r["body"] for r in broker.requests if r["path"] == "/actions"]
    assert len(proposals) == 2
    assert proposals[0]["payload"] == proposals[1]["payload"] == {"query": "owner request"}
    assert proposals[0]["client_ref"] == proposals[1]["client_ref"]


def test_refusals_are_serialized_without_claiming_success(client, broker):
    ctx = RecordingContext()
    register(ctx, client)
    broker.status_code = 403
    broker.error_body = {"error": {"code": "stale_epoch", "message": "fenced"}}
    result = json.loads(ctx.tools[1]["handler"]({"query": "anything"}))
    assert result["status"] == "failed"
    assert result["error"]["code"] == "stale_epoch"


@pytest.mark.parametrize("status", ["succeeded", "failed", "unknown", "unresolved", "denied"])
def test_effect_class_never_overrides_the_observed_outcome(client, broker, status):
    # External effects keep requires_approval=True even after a decision and dispatch.
    # That classification is not evidence that the action is still awaiting approval.
    broker.propose_response.update(status=status, requires_approval=True)
    ctx = RecordingContext()
    register(ctx, client)
    result = json.loads(ctx.tools[0]["handler"]({"to": "owner@example.test", "body": "once"}))
    assert result["status"] == status
    assert result["status"] != "needs_approval"


def test_read_refs_change_between_attempts_but_write_refs_do_not(monkeypatch):
    from melete_plugin import _client_ref

    monkeypatch.setenv("MELETE_JOB_ID", "job-fixture")
    monkeypatch.setenv("MELETE_ATTEMPT_ID", "attempt-1")
    first_read = _client_ref("files.read", {"path": "plan.md"}, read=True)
    first_write = _client_ref("email.send", {"body": "once"})
    monkeypatch.setenv("MELETE_ATTEMPT_ID", "attempt-2")
    assert _client_ref("files.read", {"path": "plan.md"}, read=True) != first_read
    assert _client_ref("email.send", {"body": "once"}) == first_write


def test_lifecycle_wait_does_not_become_a_connector_action():
    from melete_plugin import build_handler, engine_handler

    class LifecycleClient:
        def __init__(self):
            self.waits = []

        def wait(self, payload):
            self.waits.append(payload)
            return {"status": "waiting_for_event_or_time", "wait": payload}

        def propose(self, **kwargs):
            raise AssertionError("A wait must not be dispatched as a connector effect")

    client = LifecycleClient()
    handler = engine_handler(build_handler(client, {"name": "job.wait", "connection_id": None}))
    wait = {"kind": "timer", "wake_at": "2030-01-01T00:00:00Z"}
    result = json.loads(handler(wait, task_id="engine-only"))
    assert result["wait"] == wait
    assert client.waits == [wait]
