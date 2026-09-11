"""The plugin against a fake broker.

The fake is a real HTTP server on loopback, not a stubbed client, so the URL
building, the bearer header, the JSON bodies and the error bodies are all
exercised rather than assumed. It contacts nothing else and needs no container.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from melete_plugin import TOOLSET, build_handler, register, tool_schema  # noqa: E402
from melete_plugin.broker import BrokerClient, BrokerError  # noqa: E402
from melete_plugin.results import (  # noqa: E402
    END_TURN_INSTRUCTION,
    UNCERTAIN_INSTRUCTION,
)

CONNECTION = "con_01J0000000000000000000000A"
ACTION = "act_01J0000000000000000000000B"
APPROVAL = "apr_01J0000000000000000000000C"
HASH = "a" * 64

CATALOG: List[Dict[str, Any]] = [
    {
        "name": "email.send",
        "description": "Send an email from the owner's mailbox.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to": {"type": "array", "items": {"type": "string"}},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
        "effect_class": "write_external",
        "connection_id": CONNECTION,
    },
    {
        "name": "email.search",
        "description": "Search the owner's mailbox.",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}},
        "effect_class": "read",
        "connection_id": CONNECTION,
    },
]


class FakeBroker:
    """One attempt's worth of broker, with scripted answers."""

    def __init__(self) -> None:
        self.catalog: List[Dict[str, Any]] = list(CATALOG)
        self.propose_response: Dict[str, Any] = {
            "action_id": ACTION,
            "status": "succeeded",
            "effect_class": "read",
            "payload_hash": HASH,
            "canonical_payload": {},
            "requires_approval": False,
            "approval_id": None,
        }
        self.action_record: Dict[str, Any] = {"id": ACTION, "receipt": {"external_ref": "mid-1"}}
        self.status_code = 200
        self.error_body: Dict[str, Any] | None = None
        self.requests: List[Dict[str, Any]] = []

    # -- the HTTP surface, matching apps/melete/src/broker/http.ts -------------
    def handle(self, method: str, path: str, body: Dict[str, Any] | None, auth: str | None):
        self.requests.append({"method": method, "path": path, "body": body, "auth": auth})
        if self.error_body is not None:
            return self.status_code, self.error_body
        if method == "GET" and path == "/tools":
            return 200, {"tools": self.catalog}
        if method == "POST" and path == "/actions":
            return 201, self.propose_response
        if method == "POST" and path == "/tools/learning/propose":
            return 200, {"status": "candidate_pending", "episode_id": "ep_recorded"}
        if method == "GET" and path.startswith("/actions/"):
            return 200, {"action": self.action_record}
        return 404, {"error": {"code": "not_found", "message": "no such route"}}


@pytest.fixture()
def broker():
    state = FakeBroker()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence the default stderr chatter
            return

        def _respond(self, method: str):
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw) if raw else None
            status, payload = state.handle(
                method, self.path, body, self.headers.get("authorization")
            )
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
            self._respond("GET")

        def do_POST(self):  # noqa: N802
            self._respond("POST")

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def client(broker):
    return BrokerClient(base_url=broker.base_url, token="cap-token", timeout=5)


class RecordingContext:
    """Stands in for Hermes's PluginContext with the one method we use."""

    def __init__(self) -> None:
        self.tools: List[Dict[str, Any]] = []

    def register_tool(self, **kwargs: Any) -> None:
        self.tools.append(kwargs)


# -- registration -------------------------------------------------------------


def test_registers_one_tool_per_catalog_entry(client, broker):
    ctx = RecordingContext()
    names = register(ctx, client)

    assert names == ["email.send", "email.search"]
    assert [t["name"] for t in ctx.tools] == ["email.send", "email.search"]
    assert {t["toolset"] for t in ctx.tools} == {TOOLSET}
    assert broker.requests[0]["path"] == "/tools"
    assert broker.requests[0]["auth"] == "Bearer cap-token"


def test_schema_is_the_openai_function_body_without_the_name():
    schema = tool_schema(CATALOG[0])
    # Hermes merges {"name": entry.name} over this, so a "name" here would be
    # redundant; "parameters" is what the provider actually reads.
    assert set(schema) == {"description", "parameters"}
    assert schema["parameters"] == CATALOG[0]["input_schema"]


def test_a_tool_with_no_schema_still_gets_a_valid_parameters_object():
    assert tool_schema({"name": "x"})["parameters"] == {"type": "object", "properties": {}}


def test_registration_is_refused_without_a_broker_url():
    assert register(RecordingContext(), BrokerClient(base_url="", token="t")) == []


def test_registration_is_refused_without_an_attempt_token(broker):
    assert register(RecordingContext(), BrokerClient(base_url=broker.base_url, token="")) == []


def test_an_empty_catalog_registers_nothing_but_does_not_raise(client, broker):
    broker.catalog = []
    assert register(RecordingContext(), client) == []


def test_a_refused_catalog_registers_nothing(client, broker):
    broker.status_code = 403
    broker.error_body = {"error": {"code": "stale_epoch", "message": "fenced"}}
    assert register(RecordingContext(), client) == []


# -- calling ------------------------------------------------------------------


def test_skill_creation_goes_to_learning_without_writing_live_skills(client, broker, tmp_path, monkeypatch):
    skills = tmp_path / "skills"
    skills.mkdir()
    existing = skills / "existing.md"
    existing.write_text("Owner-reviewed procedure", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    result = build_handler(client, {"name": "learning.propose", "connection_id": None})({})
    assert result == {"status": "candidate_pending", "episode_id": "ep_recorded"}
    assert broker.requests == [{
        "method": "POST", "path": "/tools/learning/propose", "body": {}, "auth": "Bearer cap-token"
    }]
    assert sorted(path.name for path in skills.iterdir()) == ["existing.md"]
    assert existing.read_text(encoding="utf-8") == "Owner-reviewed procedure"


def test_a_dispatched_call_returns_the_receipt(client, broker):
    handler = build_handler(client, CATALOG[1])
    result = handler(query="invoices")

    assert result["status"] == "succeeded"
    assert result["action_id"] == ACTION
    assert result["receipt"] == {"external_ref": "mid-1"}
    proposal = broker.requests[0]
    assert proposal["path"] == "/actions"
    assert proposal["body"]["kind"] == "email.search"
    # The connection comes from the catalog, never from the model's arguments.
    assert proposal["body"]["connection_id"] == CONNECTION
    assert proposal["body"]["payload"] == {"query": "invoices"}
    assert proposal["body"]["client_ref"]


def test_a_parked_action_tells_the_model_to_stop(client, broker):
    broker.propose_response = {
        "action_id": ACTION,
        "status": "needs_approval",
        "effect_class": "write_external",
        "payload_hash": HASH,
        "canonical_payload": {},
        "requires_approval": True,
        "approval_id": APPROVAL,
    }
    handler = build_handler(client, CATALOG[0])
    result = handler(to=["a@example.com"], subject="hi", body="hello")

    assert result == {
        "status": "needs_approval",
        "action_id": ACTION,
        "approval_id": APPROVAL,
        "payload_hash": HASH,
        "instruction": END_TURN_INSTRUCTION,
    }
    # No receipt read: nothing has happened yet, so there is nothing to read.
    assert [r["path"] for r in broker.requests] == ["/actions"]


def test_requires_approval_alone_is_enough_to_park(client, broker):
    broker.propose_response = {
        "action_id": ACTION,
        "status": "proposed",
        "requires_approval": True,
        "approval_id": APPROVAL,
        "payload_hash": HASH,
    }
    result = build_handler(client, CATALOG[0])(to=["a@example.com"], subject="s", body="b")
    assert result["status"] == "needs_approval"


def test_an_unknown_dispatch_is_never_presented_as_either_outcome(client, broker):
    broker.propose_response = {"action_id": ACTION, "status": "unknown"}
    result = build_handler(client, CATALOG[0])(to=["a@example.com"], subject="s", body="b")

    assert result["status"] == "unknown"
    assert result["instruction"] == UNCERTAIN_INSTRUCTION
    assert "receipt" not in result


def test_a_failed_dispatch_says_so(client, broker):
    broker.propose_response = {"action_id": ACTION, "status": "failed"}
    result = build_handler(client, CATALOG[0])(to=["a@example.com"], subject="s", body="b")
    assert result["status"] == "failed"
    assert "did not happen" in result["instruction"]


def test_a_broker_refusal_keeps_the_brokers_own_code(client, broker):
    broker.status_code = 403
    broker.error_body = {"error": {"code": "scope_denied", "message": "out of scope"}}
    result = build_handler(client, CATALOG[0])(to=["a@example.com"], subject="s", body="b")

    assert result["status"] == "failed"
    assert result["error"] == {"code": "scope_denied", "message": "out of scope"}


def test_an_unreachable_broker_is_uncertain_not_failed():
    # Nothing is listening on this port, so the request never got an answer and
    # the plugin cannot say whether the effect happened.
    client = BrokerClient(base_url="http://127.0.0.1:1", token="t", timeout=2)
    result = build_handler(client, CATALOG[0])(to=["a@example.com"], subject="s", body="b")

    assert result["status"] == "unknown"
    assert result["instruction"] == UNCERTAIN_INSTRUCTION


def test_a_catalog_entry_without_a_connection_is_refused(client):
    handler = build_handler(client, {"name": "email.send", "connection_id": None})
    assert handler(to=["a@example.com"])["error"]["code"] == "unknown_connection"


def test_an_unreadable_receipt_does_not_turn_success_into_failure(client, broker, monkeypatch):
    def explode(_action_id: str):
        raise BrokerError("http_500", "receipt read failed")

    monkeypatch.setattr(client, "action", explode)
    result = build_handler(client, CATALOG[1])(query="x")
    assert result["status"] == "succeeded"
    assert "receipt" not in result


def test_the_same_arguments_produce_the_same_client_ref(client, broker):
    handler = build_handler(client, CATALOG[1])
    handler(query="same")
    handler(query="same")
    handler(query="different")
    refs = [r["body"]["client_ref"] for r in broker.requests if r["path"] == "/actions"]
    assert refs[0] == refs[1]
    assert refs[2] != refs[0]


def test_the_handler_takes_the_arguments_as_one_positional_dict(client, broker):
    # Hermes dispatches as handler(args, **kwargs) with the model's arguments in
    # one positional dict (tools/registry.py:822). A keyword-only signature
    # raises TypeError before the broker is called, and the model is told the
    # tool is broken. The real engine caught this; the fake broker could not.
    handler = build_handler(client, CATALOG[1])
    result = handler({"query": "positional"})
    assert result["status"] == "succeeded"
    assert broker.requests[0]["body"]["payload"] == {"query": "positional"}


def test_the_handler_still_accepts_keyword_arguments(client, broker):
    build_handler(client, CATALOG[1])(query="keyword")
    assert broker.requests[0]["body"]["payload"] == {"query": "keyword"}


def test_the_client_opens_no_socket_without_configuration():
    with pytest.raises(BrokerError) as caught:
        BrokerClient(base_url="", token="t").tools()
    assert caught.value.code == "not_configured"
