"""Build-time check: a Claude model can reach Melete's gateway from this image.

Melete serves Anthropic models over the Messages API, so the engine talks to the
gateway with its own Anthropic client. That needs the `anthropic` package, and
the gateway answers only a call that carries the attempt's capability header.
This builds the engine's client exactly as an attempt does, sends one message to
a local stand-in for the broker, and fails the build unless the header arrived.
It also checks that a client pointed anywhere else is not given the header.

Run with the engine's interpreter from the engine's root:
    cd /opt/hermes && python /opt/melete-runtime/anthropic_check.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "build-check-capability"
REPLY = {
    "id": "msg_check",
    "type": "message",
    "role": "assistant",
    "model": "check-model",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}
seen: list[tuple[str, dict[str, str]]] = []


class Broker(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - the http.server interface
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
        body = json.dumps(REPLY).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def call(build, base_url: str) -> dict[str, str]:
    before = len(seen)
    try:
        client = build("melete-surrogate-check", base_url)
    except ImportError as error:
        raise SystemExit(f"anthropic check: the Anthropic SDK is not installed in the engine: {error}")
    client.messages.create(
        model="check-model", max_tokens=8, messages=[{"role": "user", "content": "ping"}]
    )
    if len(seen) != before + 1:
        raise SystemExit(f"anthropic check: no request reached the stand-in at {base_url}")
    return seen[-1][1]


def main() -> None:
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        os.environ.pop(name, None)
    # The engine writes into its home as it loads. The check runs as root during
    # the build, so it gets a home of its own and the image's stays untouched.
    home = tempfile.mkdtemp(prefix="anthropic-check-")
    os.environ["HERMES_HOME"] = home
    try:
        run()
    finally:
        shutil.rmtree(home, ignore_errors=True)


def run() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Broker)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    os.environ["MELETE_BROKER_URL"] = f"{origin}/broker"
    os.environ["MELETE_ATTEMPT_TOKEN"] = TOKEN
    sys.path.insert(0, os.getcwd())
    try:
        from agent.anthropic_adapter import build_anthropic_client
    except ImportError as error:
        raise SystemExit(f"anthropic check: the engine's Anthropic client cannot load: {error}")

    to_broker = call(build_anthropic_client, f"{origin}/broker/providers/anthropic/v1")
    if to_broker.get("x-melete-capability") != TOKEN:
        raise SystemExit(
            "anthropic check: a call to the broker did not carry the attempt's capability, "
            "so the gateway would refuse every Claude model call (401 capability_required)"
        )
    elsewhere = call(build_anthropic_client, f"{origin}/elsewhere/v1")
    if "x-melete-capability" in elsewhere:
        raise SystemExit("anthropic check: the capability was sent to an address that is not the broker")
    server.shutdown()
    print("anthropic check: the engine's Anthropic client reaches the gateway with its capability")


if __name__ == "__main__":
    main()
