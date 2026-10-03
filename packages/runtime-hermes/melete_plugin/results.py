"""What a broker answer looks like by the time the model reads it.

Three shapes and no others: a receipt, a parked approval, or a refusal. Each one
says plainly what happened, because the failure this file exists to prevent is a
model that reads a queued action as a sent one and tells the owner it is done.

The needs-approval shape carries an instruction to stop. Hermes has no way to
suspend a run mid-turn and resume it days later once a person has decided, so
the attempt ends and the job parks on Melete's ledger. The next wake is a fresh
attempt that starts by being told what was decided.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: Statuses the broker can put on an action. Anything outside this set is
#: reported as it arrived rather than guessed at.
SUCCEEDED = "succeeded"
NEEDS_APPROVAL = "needs_approval"
DENIED = "denied"
FAILED = "failed"
UNKNOWN = "unknown"
UNRESOLVED = "unresolved"

#: The exact words the model is given when an action parks. It has to stop: a
#: second attempt at the same effect while the first is pending approval is how
#: one approved send becomes two. Asking the person a question is not a second
#: attempt at the effect, and the question is kept beside the approval, so a
#: turn that also needs an answer may still ask it before it ends.
END_TURN_INSTRUCTION = (
    "This action is waiting for the person's decision and has NOT happened. "
    "Stop now. Do not retry it, do not work around it, and do not say it is "
    "done. If this task also needs the person to answer a question, ask it with "
    "ask_person before you end; say a question is on their screen only when "
    "ask_person accepted it. End your turn with a short note of what you are "
    "waiting on. You will be started again with the decision once it has been made."
)

FAILURE_INSTRUCTION = (
    "This action did not happen. Do not claim that it did. Either fix the cause "
    "and propose it again, or end your turn and say what blocked you."
)

UNCERTAIN_INSTRUCTION = (
    "The broker cannot tell whether this action happened. Do NOT retry it and do "
    "NOT claim either outcome. End your turn and say that it is unconfirmed; the "
    "person will be asked."
)

#: For a step on the agent's own computer: the agent checks, the owner is not asked.
OWN_COMPUTER_INSTRUCTION = (
    "Whether this step happened on your own computer is not known. Do NOT repeat it "
    "yet and do NOT claim either outcome. Check first: take a screenshot, read the "
    "page, or look for the files or output it would have left, then carry on from "
    "what you find. The person is not asked about it."
)


def needs_approval(response: Dict[str, Any]) -> bool:
    """True when the broker parked the action instead of dispatching it."""
    status = response.get("status")
    return status == NEEDS_APPROVAL or (status in (None, "proposed") and bool(response.get("requires_approval")))


def from_response(response: Dict[str, Any], receipt: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Turn one `POST /actions` answer into the object the model sees."""
    action_id = response.get("action_id")
    status = response.get("status")

    if needs_approval(response):
        return {
            "status": NEEDS_APPROVAL,
            "action_id": action_id,
            "approval_id": response.get("approval_id"),
            "payload_hash": response.get("payload_hash"),
            "instruction": END_TURN_INSTRUCTION,
        }

    if status == SUCCEEDED:
        out: Dict[str, Any] = {"status": SUCCEEDED, "action_id": action_id}
        # The receipt is the evidence. Without one there is nothing to point at,
        # and the identity forbids claiming success without evidence.
        if receipt is not None:
            out["receipt"] = receipt
        return out

    if status in (UNKNOWN, UNRESOLVED):
        return {
            "status": status,
            "action_id": action_id,
            "instruction": OWN_COMPUTER_INSTRUCTION if response.get("own_computer") else UNCERTAIN_INSTRUCTION,
        }

    return {
        "status": status or FAILED,
        "action_id": action_id,
        "instruction": FAILURE_INSTRUCTION,
    }


def from_error(code: str, message: str) -> Dict[str, Any]:
    """A broker refusal, or a broker that never answered.

    `unreachable` is deliberately given the uncertain instruction rather than
    the failure one: a request that got no answer may still have been received.
    """
    if code == "schema_invalid":
        return {
            "status": FAILED,
            "error": {"code": code, "message": message},
            "retryable": False,
            "instruction": "The tool schema needs operator repair. Stop now. Do not retry this tool.",
        }
    uncertain = code == "unreachable"
    return {
        "status": UNKNOWN if uncertain else FAILED,
        "error": {"code": code, "message": message},
        "instruction": UNCERTAIN_INSTRUCTION if uncertain else FAILURE_INSTRUCTION,
    }
