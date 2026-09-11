"""The only plugin the Melete runtime loads.

It registers one tool per entry in the broker's catalog and nothing else. Every
handler is a forwarder: it posts the proposed payload to the broker over the
internal network and returns what the broker says.

The plugin holds no credentials, contains no connector code, and makes no
decisions. Canonicalisation, effect classification, approval, budget, dispatch
and the receipt all happen on the broker side, where they can be recorded.

It imports nothing from Hermes beyond the `ctx` object it is handed. That is not
tidiness: the internal compatibility import paths are removed on 2026-09-14, and
a plugin that reaches past `ctx` stops loading on that date.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from .broker import ATTEMPT_TOKEN_ENV, BROKER_URL_ENV, BrokerClient, BrokerError
from .results import SUCCEEDED, from_error, from_response, needs_approval

logger = logging.getLogger("melete.plugin")

#: Every broker tool lands in this one toolset. `platform_toolsets.api_server`
#: names it and nothing else, which is how the built-ins stay off: the model's
#: entire catalog is what the broker served for this job.
TOOLSET = "melete"

#: The job this container is working on. It scopes the proposal reference, and
#: it is the JOB and not the attempt on purpose: an action that parked for
#: approval is dispatched when the NEXT attempt proposes the same thing again,
#: and an attempt-scoped reference would make that a second action with the
#: approval still sitting on the first. See _client_ref.
JOB_ID_ENV = "MELETE_JOB_ID"

#: Carried for correlation in logs and for a fallback reference when the job id
#: is absent. Not the idempotency scope.
ATTEMPT_ID_ENV = "MELETE_ATTEMPT_ID"

__all__ = ["register", "TOOLSET", "build_handler", "tool_schema"]


def tool_schema(tool: Dict[str, Any]) -> Dict[str, Any]:
    """The OpenAI function body for one catalog entry.

    Hermes injects the name (`tools/registry.py`: ``{**entry.schema, "name":
    entry.name}``), so this carries the description and the parameters and
    nothing else. Passing a bare JSON Schema here instead produces a definition
    with no ``parameters`` key at all, which no provider will accept.
    """
    return {
        "description": tool.get("description", ""),
        "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
    }


def build_handler(client: BrokerClient, tool: Dict[str, Any]) -> Callable[..., Dict[str, Any]]:
    """Build the forwarder for one catalog entry.

    The arguments the model produced are the proposed payload, unexamined. The
    connection id comes from the catalog rather than from the model: letting the
    model name the connection would let it choose which mailbox an email leaves
    from, which is a policy decision and not its to make.
    """
    name = str(tool.get("name"))
    connection_id = tool.get("connection_id")

    def handler(args: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
        # Hermes dispatches as `handler(args, **kwargs)` with the model's
        # arguments in one positional dict (`tools/registry.py:822`), not as
        # keyword arguments. A `**kwargs`-only signature raises TypeError before
        # the broker is ever called, and the model is told the tool is broken.
        arguments: Dict[str, Any] = dict(args or {})
        arguments.update(extra)
        if name == "react" and connection_id is None:
            # Reactions belong to the attempt's job, not an external connection.
            # The broker checks that ownership before persisting the glyph.
            try:
                return {"status": SUCCEEDED, "reaction": client.react(arguments)}
            except BrokerError as error:
                return from_error(error.code, error.message)
        if not connection_id:
            # A catalog entry with no connection cannot be dispatched anywhere.
            # It should not have been served; refuse rather than invent one.
            return from_error("unknown_connection", f"{name} has no connection in the catalog")
        try:
            response = client.propose(
                kind=name,
                connection_id=str(connection_id),
                payload=arguments,
                client_ref=_client_ref(name, arguments),
            )
        except BrokerError as error:
            return from_error(error.code, error.message)

        if needs_approval(response):
            return from_response(response)

        receipt = None
        if response.get("status") == SUCCEEDED and response.get("action_id"):
            # The receipt is the evidence a completion has to point at. If it
            # cannot be read back the action still succeeded, so report it
            # without one rather than turning a success into a failure.
            try:
                receipt = client.action(str(response["action_id"])).get("receipt")
            except BrokerError as error:
                logger.warning("melete: receipt read failed for %s: %s", name, error.message)
        return from_response(response, receipt)

    handler.__name__ = "melete_" + name.replace(".", "_").replace("-", "_")
    handler.__doc__ = f"Forward {name} to the Melete broker."
    return handler


def _client_ref(name: str, arguments: Dict[str, Any]) -> str:
    """A stable name for this proposal within this job.

    The broker keys a proposal on this and refuses a second one under the same
    reference whose content differs, so a resent request resolves to the action
    it already created rather than making another.

    Scoped to the JOB, not the attempt. An action that parked for approval is
    carried out when the next attempt proposes the same thing again: the broker
    finds the approved action under this reference and dispatches it. An
    attempt-scoped reference makes that a brand new action instead, and the
    approval the owner gave stays attached to one nobody will ever execute.

    The cost is that two genuinely separate but byte-identical effects in one
    job collapse into one. That is the safer direction: an approval binds to a
    payload hash, so a second identical send is indistinguishable from a retry,
    and sending twice is the failure that cannot be taken back.
    """
    scope = os.environ.get(JOB_ID_ENV) or os.environ.get(ATTEMPT_ID_ENV, "job")
    digest = hashlib.sha256(
        json.dumps(arguments, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:32]
    return f"{scope}:{name}:{digest}"


def register(ctx: Any, client: Optional[BrokerClient] = None) -> List[str]:
    """Register the broker's tools. Called once by the plugin loader.

    Returns the names that were registered, which is what the tests assert on
    and what the log line reports. A run with an empty catalog is allowed to
    start: the model can still answer a question or ask one, and refusing to
    load would turn a scope-less job into a crash rather than a conversation.
    """
    client = client or BrokerClient()
    if not client.base_url:
        logger.error("melete: %s is not set; no tools will be registered", BROKER_URL_ENV)
        return []
    if not client.token:
        logger.error("melete: %s is not set; no tools will be registered", ATTEMPT_TOKEN_ENV)
        return []

    try:
        catalog = client.tools()
    except BrokerError as error:
        logger.error("melete: the broker refused the catalog (%s): %s", error.code, error.message)
        return []

    registered: List[str] = []
    for tool in catalog:
        name = tool.get("name")
        if not isinstance(name, str) or not name:
            continue
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=tool_schema(tool),
            handler=build_handler(client, tool),
            description=str(tool.get("description", "")),
            emoji="",
        )
        registered.append(name)

    if not registered:
        logger.warning("melete: the broker served no tools; this attempt has no way to act")
    else:
        logger.info("melete: registered %d broker tools", len(registered))
    return registered
