"""The only plugin the Melete runtime loads.

It registers one tool per entry in the broker's catalog and nothing else. Every
handler is a thin forwarder: it posts the proposed payload to the broker on the
internal network and returns whatever the broker says. No connector code, no
credentials, and no network access of its own live in this process.

Status: v0.1 skeleton. `register` builds the tool set from the catalog the
broker serves and wires the forwarder; the forwarder itself is completed in the
runtime work that also owns the approval bridge.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

#: The broker is the only host this process may talk to. The container has no
#: route anywhere else, so a mistake here fails closed rather than leaking.
BROKER_URL = os.environ.get("MELETE_BROKER_URL", "http://melete:8788")

#: Set by the service when it starts the run. Scopes every broker call to one
#: attempt, one epoch, one revision.
ATTEMPT_TOKEN_ENV = "MELETE_ATTEMPT_TOKEN"

TOOLSET = "melete"

#: Seconds to wait for the broker. Longer than an approval round trip would be
#: wrong: waiting belongs in the job, not in a held socket.
BROKER_TIMEOUT_SECONDS = 30


def _broker_request(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """POST to the broker with the attempt token. Never raises past the caller."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{BROKER_URL}{path}",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {os.environ.get(ATTEMPT_TOKEN_ENV, '')}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=BROKER_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": {"code": f"http_{error.code}", "message": detail}}
    except Exception as error:  # noqa: BLE001 - the model gets a message, not a traceback
        return {"ok": False, "error": {"code": "broker_unreachable", "message": str(error)}}


def _fetch_catalog() -> List[Dict[str, Any]]:
    """Ask the broker which tools this attempt may see.

    The catalog is already filtered by the job's scopes, so an out-of-scope tool
    never appears in the model's context rather than being refused at call time.
    """
    result = _broker_request("/catalog", {})
    tools = result.get("tools")
    return tools if isinstance(tools, list) else []


def _make_handler(name: str):
    """Build the forwarder for one tool.

    Everything the model wants to do arrives here as a plain payload and leaves
    as a proposal. The broker canonicalises it, classifies its effect, asks for
    approval if the class requires one, and returns the outcome. This function
    makes no decisions of its own.
    """

    def handler(**arguments: Any) -> Dict[str, Any]:
        return _broker_request("/actions", {"kind": name, "payload": arguments})

    handler.__name__ = f"melete_{name.replace('.', '_')}"
    return handler


def register(ctx) -> None:  # noqa: ANN001 - ctx is Hermes's plugin context
    """Register the broker's tools. Called once by the plugin loader."""
    catalog = _fetch_catalog()
    if not catalog:
        logger.warning(
            "melete plugin: the broker returned no tools; this attempt has no way to act"
        )

    for tool in catalog:
        name = tool.get("name")
        if not name:
            continue
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema={
                "name": name,
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {"type": "object"}),
            },
            handler=_make_handler(name),
        )

    logger.info("melete plugin: registered %d broker tools", len(catalog))
