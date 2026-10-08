"""The only plugin the Melete runtime loads.

It registers broker tools and bounded lifecycle observers. Every tool
handler is a forwarder: it posts the proposed payload to the broker over the
internal network and returns what the broker says.

The plugin holds no credentials, contains no connector code, and makes no
decisions. Canonicalisation, effect classification, approval, budget, dispatch
and the receipt all happen on the broker side, where they can be recorded.

It imports nothing from Hermes beyond the `ctx` object it is handed. That is not
tidiness: the internal compatibility import paths are removed on 2026-09-14, and
a plugin that reaches past `ctx` stops loading on that date. The one exception is
the sandbox terminal (`terminal_backend.py`): the engine's registrar checks a
terminal backend's type, so when an attempt has a sandbox that module subclasses
the engine's published provider and environment base classes. Neither is a
compatibility path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from .broker import ATTEMPT_TOKEN_ENV, BROKER_URL_ENV, BrokerClient, BrokerError
from .execution import ExecRefused, run_in_cell
from .results import SUCCEEDED, from_error, from_response, needs_approval
from .terminal_backend import (
    ANSWER_SLACK_SECONDS,
    MAX_TIMEOUT_MS,
    SESSION_MARGIN_SECONDS,
    TERMINAL_TOOL,
    command_wait_seconds,
    register_terminal_backend,
)
from .vision import attach as attach_picture
from .vision import restore as restore_picture

#: `run.try` runs its first command, then its variants side by side, each up
#: to the command limit plus the time the broker allows around a sandbox command.
RUN_TRY_WAIT_SECONDS = 2 * (MAX_TIMEOUT_MS / 1000 + SESSION_MARGIN_SECONDS) + ANSWER_SLACK_SECONDS

logger = logging.getLogger("melete.plugin")

#: Set in an engine started before its attempt; see `register`.
SPARE_ENV = "MELETE_RUNTIME_SPARE"

#: Every broker tool lands in this one toolset. `platform_toolsets.api_server`
#: names it beside only the engine's task list and, for a budget that can carry
#: them, its helpers, which act inside the engine, so every effect the model can
#: have is a tool the broker served for this job.
TOOLSET = "melete"

#: The job this container is working on. It scopes the proposal reference, and
#: it is the JOB and not the attempt on purpose: an action that parked for
#: approval is carried out by resume_action or when the NEXT attempt proposes
#: the same thing again, and an attempt-scoped reference would make the second
#: path a new action with the approval still sitting on the first. See _client_ref.
JOB_ID_ENV = "MELETE_JOB_ID"

#: Carried for correlation in logs and for a fallback reference when the job id
#: is absent. Not the idempotency scope.
ATTEMPT_ID_ENV = "MELETE_ATTEMPT_ID"

__all__ = ["register", "TOOLSET", "build_handler", "tool_schema"]

#: What a helper reads when its action parks. Unlike the parent, it does not
#: ask the person: the parent is handed the parked action and decides.
HELPER_PARKED_INSTRUCTION = (
    "This action is waiting for the person's decision and has NOT happened. "
    "Stop now. Do not retry it, do not work around it, and do not say it is "
    "done. Finish with a summary that says it is waiting for the person's approval."
)


def _parent_only(name: str) -> bool:
    try:
        from melete_runtime_hooks import parent_only
    except ImportError:  # the support module ships beside the plugin in every engine
        return False
    return parent_only(name)


def _in_helper() -> bool:
    try:
        from melete_runtime_hooks import in_helper
    except ImportError:
        return False
    return in_helper()


def _note_helper_parked(action_id: Any, name: str) -> None:
    from melete_runtime_hooks import note_helper_parked

    note_helper_parked(action_id, name)


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


#: Catalog entries this container carries out itself. Everything else is
#: forwarded untouched. The broker says which is which; the plugin does not
#: decide, so a tool cannot become locally executed by being named cleverly.
IN_CELL = "in_cell"

#: How a locally executed tool maps to a language. A catalog entry outside this
#: table that claims in_cell execution is refused rather than guessed at.
IN_CELL_LANGUAGES = {"exec.run": "shell", "exec.python": "python"}


def build_handler(
    client: BrokerClient,
    tool: Dict[str, Any],
    register_loaded: Optional[Callable[[Dict[str, Any]], bool]] = None,
) -> Callable[..., Dict[str, Any]]:
    """Build the forwarder for one catalog entry.

    The arguments the model produced are the proposed payload, unexamined. The
    connection id comes from the catalog rather than from the model: letting the
    model name the connection would let it choose which mailbox an email leaves
    from, which is a policy decision and not its to make.

    An `in_cell` entry reserves its intent before starting. A one-use dispatch
    claim prevents a retried proposal from running it twice; its result settles
    that same action after execution.
    """
    name = str(tool.get("name"))
    connection_id = tool.get("connection_id")
    language = IN_CELL_LANGUAGES.get(name) if tool.get("execution") == IN_CELL else None
    terminal_error: Optional[Dict[str, Any]] = None

    def refuse(error: BrokerError) -> Dict[str, Any]:
        nonlocal terminal_error
        result = from_error(error.code, error.message)
        if error.code == "schema_invalid":
            # Arguments cannot fix the operator's schema; prevent another request.
            terminal_error = result
        return result

    def settle(response: Dict[str, Any]) -> Dict[str, Any]:
        """Turn a broker disposition into what the model reads, with its receipt."""
        if needs_approval(response):
            parked = from_response(response)
            if _in_helper():
                # The parent is handed it when the delegation returns, and the
                # helper is not sent to ask the person itself.
                _note_helper_parked(response.get("action_id"), name)
                parked["instruction"] = HELPER_PARKED_INSTRUCTION
            return parked
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

    def handler(args: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
        if terminal_error is not None:
            return terminal_error
        if _parent_only(name) and _in_helper():
            return from_error(
                "parent_only",
                f"A helper cannot use {name}. Finish, and say in your summary what the person "
                "should be asked or told; the agent that handed you this task decides.",
            )
        # Hermes dispatches as `handler(args, **kwargs)` with the model's
        # arguments in one positional dict (`tools/registry.py:822`), not as
        # keyword arguments. A `**kwargs`-only signature raises TypeError before
        # the broker is ever called, and the model is told the tool is broken.
        # model_tools.py:758-767 puts task_id, session_id and user_task in
        # kwargs as execution context. Only the positional dict is model
        # input, including when empty; context must not change the proposed
        # payload, approval hash, or stable proposal reference. Keyword-only
        # calls remain a convenience for direct callers outside the engine.
        arguments: Dict[str, Any] = dict(args if args is not None else extra)
        if name == "react" and connection_id is None:
            # Reactions belong to the attempt's job, not an external connection.
            # The broker checks that ownership before persisting the glyph.
            try:
                return {"status": SUCCEEDED, "reaction": client.react(arguments)}
            except BrokerError as error:
                return refuse(error)
        try:
            if name == "search_tools":
                return client.search_tools(arguments)
            if name == "load_tool":
                loaded = client.load_tool(arguments)
                schema = loaded.get("tool")
                if not isinstance(schema, dict) or not isinstance(schema.get("name"), str):
                    return from_error("invalid_catalog", "The broker returned no tool schema.")
                if register_loaded is None:
                    return from_error("registration_unavailable", "The runtime cannot register tools.")
                if register_loaded(schema) is False:
                    # The engine's own terminal already runs commands in the
                    # sandbox; a second copy of the same tool is not offered.
                    return from_error(
                        "unknown_tool",
                        f"{schema['name']} is not loaded here: use the terminal tool, which runs in the sandbox.",
                    )
                return _loaded_result(schema, loaded.get("schema_fingerprint"))
            # ask_person records a question for the person; the broker decides
            # whether it may be asked and the service makes the job wait on it.
            if connection_id is None and (
                name.startswith(("skills.", "run.", "intent."))
                or name in ("compose", "chase.follow_up", "ask_person")
            ):
                # A measured try runs its commands in the sandbox before it answers.
                wait = RUN_TRY_WAIT_SECONDS if name == "run.try" else None
                return client.call_native(name, arguments, wait)
        except BrokerError as error:
            return refuse(error)
        if name == "learning.propose" and connection_id is None:
            # This catalog entry refers recorded evidence. It cannot publish a
            # skill or act on a connection; the service owns generation and evaluation.
            try:
                return client.propose_procedure(arguments)
            except BrokerError as error:
                return refuse(error)
        if name == "say" and connection_id is None:
            # Narration for the person: no effect, no approval, recorded by the broker.
            try:
                return client.say(str(arguments.get("text", "")), _client_ref(name, arguments))
            except BrokerError as error:
                return refuse(error)
        if name == "job.wait" and connection_id is None:
            try:
                return client.wait(arguments)
            except BrokerError as error:
                return refuse(error)
        if name == "resume_action" and connection_id is None:
            # Only the id travels. Whatever else the model typed is dropped, so
            # the approved bytes on the ledger are the only ones that can leave.
            action_id = arguments.get("action_id")
            if not isinstance(action_id, str) or not action_id:
                return from_error("payload_invalid", "resume_action needs the approved action_id.")
            try:
                return settle(client.resume(action_id))
            except BrokerError as error:
                return refuse(error)
        if not connection_id:
            # A catalog entry with no connection cannot be dispatched anywhere.
            # It should not have been served; refuse rather than invent one.
            return from_error("unknown_connection", f"{name} has no connection in the catalog")
        if tool.get("execution") == IN_CELL and language is None:
            # The broker asked for local execution of something this plugin has
            # no way to run. Refusing is the only honest answer: proposing the
            # arguments as if they were a record would put a fiction in the ledger.
            return from_error("unknown_tool", f"{name} cannot be carried out in this runtime")

        display = None
        payload = {"intent": arguments} if language is not None else arguments

        # A sandbox command is run by the broker before it answers, for as long
        # as the command's own timeout and the sandbox's setup allow. The
        # ordinary round-trip timeout would stop waiting while it still runs.
        wait = command_wait_seconds(arguments.get("timeout_ms")) if name == TERMINAL_TOOL else None
        try:
            response = client.propose(
                kind=name,
                connection_id=str(connection_id),
                payload=payload,
                client_ref=_client_ref(name, payload, read=tool.get("effect_class") == "read"),
                timeout=wait,
            )
        except BrokerError as error:
            return refuse(error)

        if language is not None and response.get("status") == "admitted":
            action_id = str(response["action_id"])
            try:
                if not client.start_execution(action_id).get("execute"):
                    return from_response({"action_id": action_id, "status": "dispatched"})
                # Execute the admitted canonical arguments, which are also what
                # settlement checks. The fallback supports older broker fakes.
                admitted = response.get("canonical_payload", {}).get("intent", arguments)
                try:
                    display = run_in_cell(language, admitted)
                except (ExecRefused, OSError) as failure:
                    client.settle_execution(action_id, error=str(failure))
                    return from_error("payload_invalid", str(failure))
                settled = client.settle_execution(action_id, record=display["record"])["action"]
                result = from_response({"action_id": action_id, "status": settled["status"]}, settled.get("receipt"))
                result["execution"] = _execution_view(display)
                return result
            except BrokerError as error:
                result = from_error(error.code, error.message)
                if display is not None:
                    result["execution"] = _execution_view(display)
                return result

        result = settle(response)
        if display is not None:
            result["execution"] = _execution_view(display)
        return result

    handler.__name__ = "melete_" + name.replace(".", "_").replace("-", "_")
    handler.__doc__ = f"Forward {name} to the Melete broker."
    return handler


#: Says a loaded tool could not join the running agent's list, so the run has
#: to end and continue in a fresh one. Kept under ``error`` on purpose: the
#: engine marks a result carrying one as failed on the run's event stream, and
#: that mark is how the adapter tells this case from a tool the model can call
#: at once. The broker's catalog, not this text, decides whether a tool loaded.
CONTINUES_IN_A_NEW_RUN = "continues_in_a_new_run"


def _loaded_result(schema: Dict[str, Any], fingerprint: Any) -> Dict[str, Any]:
    """What the model reads after a load, and what the adapter acts on.

    The engine builds a run's tool list when the run starts. The support module
    asks the engine to add the newly registered tool to the running agent's list
    (its own live refresh, the one it uses for a tool server that connects
    late), so the model calls it on its next request and the run goes on. When
    that is not possible the adapter observes the broker's new catalog, stops
    this run, and starts a fresh one in the same attempt with the tool in it.
    Model text never controls either path.
    """
    name = schema["name"]
    try:
        from melete_runtime_hooks import refresh_live_tools

        live = refresh_live_tools(name)
    except Exception as error:  # noqa: BLE001 - no live refresh means a fresh run
        logger.warning("melete: %s continues in a new run: %s", name, type(error).__name__)
        live = False
    if live:
        return {
            "status": "loaded",
            "name": name,
            "schema_fingerprint": fingerprint,
            "instruction": f"{name} is in your tools now. Call it directly.",
        }
    return {
        "status": "tools_loaded",
        "name": name,
        "schema_fingerprint": fingerprint,
        "error": CONTINUES_IN_A_NEW_RUN,
        "instruction": "The tool is loaded. This run will continue with its schema.",
    }


def _execution_view(outcome: Dict[str, Any]) -> Dict[str, Any]:
    """What the model reads about a command it ran.

    The record distinguishes emitted and retained bytes. A capped capture names
    a stored prefix and explicitly reports that the rest was discarded.
    """
    record = outcome["record"]
    return {
        "exit_code": record["exit_code"],
        "timed_out": record["timed_out"],
        "duration_ms": record["duration_ms"],
        "truncated": record["truncated"],
        "output_path": record["output_path"],
        "output": outcome["display"],
        "captured_bytes": record.get("captured_bytes", record["output_bytes"]),
        "total_bytes": record.get("total_bytes"),
        "capture_limited": record.get("capture_limited"),
    }


def _client_ref(name: str, arguments: Dict[str, Any], *, read: bool = False) -> str:
    """A stable name for this proposal within this job.

    The broker keys a proposal on this and refuses a second one under the same
    reference whose content differs, so a resent request resolves to the action
    it already created rather than making another.

    Scoped to the JOB, not the attempt. An action that parked for approval is
    carried out by resume_action, which sends only its id, or when the next
    attempt proposes the same thing again: the broker finds the approved action
    under this reference and dispatches it. An
    attempt-scoped reference makes that a brand new action instead, and the
    approval the owner gave stays attached to one nobody will ever execute.

    The cost is that two genuinely separate but byte-identical effects in one
    job collapse into one. That is the safer direction: an approval binds to a
    payload hash, so a second identical send is indistinguishable from a retry,
    and sending twice is the failure that cannot be taken back.
    """
    scope = (os.environ.get(ATTEMPT_ID_ENV) if read else os.environ.get(JOB_ID_ENV)) or os.environ.get(ATTEMPT_ID_ENV, "job")
    digest = hashlib.sha256(
        json.dumps(arguments, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:32]
    return f"{scope}:{name}:{digest}"


def engine_result(name: str, result: Dict[str, Any], client: Optional[BrokerClient] = None) -> Any:
    """What the engine's registry is handed for one result.

    A JSON string (tools/registry.py:792), except for a screenshot shown to a
    model that reads images: then the engine's multimodal envelope, which the
    registry passes through as it is (``_normalize_handler_result``).
    """
    shaped = attach_picture(
        name, result, getattr(client, "screenshot", None), getattr(client, "describe_picture", None)
    )
    if isinstance(shaped, dict) and shaped.get("_multimodal") is True:
        return shaped
    # The receipt, with what was said about a picture that is not shown.
    return json.dumps(shaped if isinstance(shaped, dict) else result, ensure_ascii=False)


def engine_handler(
    handler: Callable[..., Dict[str, Any]],
    name: str = "",
    client: Optional[BrokerClient] = None,
) -> Callable[..., Any]:
    """Serialize results; engine keyword metadata is not a connector payload."""
    def forward(args: Optional[Dict[str, Any]] = None, **_runtime_context: Any) -> Any:
        return engine_result(name, handler(dict(args or {})), client)

    return forward


def register(ctx: Any, client: Optional[BrokerClient] = None) -> List[str]:
    """Register the broker's tools. Called once by the plugin loader.

    Returns the names that were registered, which is what the tests assert on
    and what the log line reports. A run with an empty catalog is allowed to
    start: the model can still answer a question or ask one, and refusing to
    load would turn a scope-less job into a crash rather than a conversation.
    """
    # The pinned HTTP bridge supplies a per-run queue; these observers never
    # veto tools or return modified arguments. Enforcement stays in the broker.
    from melete_runtime_hooks import register_observers, when_attempt_arrives
    register_observers(ctx)
    if client is None and os.environ.get(SPARE_ENV) == "1":
        # An engine started ahead of its attempt loads this plugin before the
        # attempt, and so its capability, exists. The attempt's tools are
        # fetched and registered once it is handed one, before it serves.
        when_attempt_arrives(lambda: register_tools(ctx, BrokerClient()))
        return []
    return register_tools(ctx, client or BrokerClient())


def register_tools(ctx: Any, client: BrokerClient) -> List[str]:
    """Fetch this attempt's catalog from the broker and register each tool."""
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

    # A paired computer's picture is never kept in the engine's session store;
    # the next run of the session asks the broker for it again.
    from melete_runtime_hooks import register_picture_restorer
    register_picture_restorer(lambda name, content: restore_picture(name, content, client.screenshot))

    # A space with a sandbox runs the engine's own terminal there. Selecting it
    # is the rendered configuration's job (TERMINAL_ENV); this only makes the
    # backend exist, and only when the broker offered its tool. Once it exists
    # the model sees one terminal, the engine's, which forwards to the broker;
    # the broker's own terminal.run entry is not registered beside it, whether
    # it arrives in the catalog or later through load_tool.
    sandbox_terminal = register_terminal_backend(ctx, client, catalog) is not None

    def register_one(tool: Dict[str, Any]) -> bool:
        """Register one entry; False when it is deliberately not offered."""
        name = tool.get("name")
        if not isinstance(name, str) or not name or name in registered:
            return True
        if sandbox_terminal and name == TERMINAL_TOOL:
            return False
        forward = build_handler(client, tool, register_one)

        def wire_handler(args: Optional[Dict[str, Any]] = None, **_metadata: Any) -> Any:
            # model_tools supplies task/session/user_task as keyword metadata;
            # none belongs in the proposed payload. Registry results must be
            # JSON strings (tools/registry.py:792), not ordinary Python dicts,
            # or the engine's multimodal envelope for a screenshot.
            return engine_result(name, forward(args), client)

        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=tool_schema(tool),
            handler=wire_handler,
            description=str(tool.get("description", "")),
            emoji="",
        )
        registered.append(name)
        return True

    for tool in catalog:
        register_one(tool)

    if not registered:
        logger.warning("melete: the broker served no tools; this attempt has no way to act")
    else:
        logger.info("melete: registered %d broker tools", len(registered))
    return registered
