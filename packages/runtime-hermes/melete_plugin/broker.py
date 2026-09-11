"""The only socket this process opens.

One host, one credential, no retries. The broker is the whole of the world from
inside the runtime container: `GET /tools` says what this attempt may do and
`POST /actions` is how it does any of it. Everything that decides anything --
canonicalisation, effect class, approval, budget, dispatch, the receipt --
happens on the other side of this file, where it is recorded.

There is no retry here on purpose. A retried POST is a second action unless the
broker is given the same `client_ref`, and deciding when to retry is a judgement
about whether an effect already happened. That judgement belongs to the broker's
verify step, not to a forwarder.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

#: Where the broker listens. In compose this is the service's internal address;
#: the container has no route anywhere else, so a wrong value fails closed.
BROKER_URL_ENV = "MELETE_BROKER_URL"

#: The capability token for exactly one attempt: one job, one epoch, one
#: revision, one set of scopes. The broker re-checks it on every call, so a
#: fenced attempt can still deliver a late receipt but can admit nothing new.
ATTEMPT_TOKEN_ENV = "MELETE_ATTEMPT_TOKEN"

#: Long enough for a connector round trip, short enough that a hung broker ends
#: the turn instead of holding a socket until the run's wall clock expires.
#: Waiting for a person happens on the ledger, never here.
DEFAULT_TIMEOUT_SECONDS = 30.0


class BrokerError(RuntimeError):
    """A broker call that produced no usable answer.

    Carries the broker's own error code when there was one. `unreachable` means
    the request never got an answer, which is the only case where the caller
    cannot tell whether anything happened.
    """

    def __init__(self, code: str, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class BrokerClient:
    """A forwarder. It holds a base URL and a token and adds nothing else."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        opener: Any = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get(BROKER_URL_ENV, "")).rstrip("/")
        self.token = token if token is not None else os.environ.get(ATTEMPT_TOKEN_ENV, "")
        self.timeout = timeout
        # Injected in tests so the unit suite never opens a socket. In the
        # container this stays None and urllib's default opener is used.
        self._opener = opener

    def _open(self, request: "urllib.request.Request") -> Any:
        if self._opener is not None:
            return self._opener(request, timeout=self.timeout)
        return urllib.request.urlopen(request, timeout=self.timeout)  # noqa: S310

    def _call(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        if not self.base_url:
            raise BrokerError("not_configured", f"{BROKER_URL_ENV} is not set")
        if not self.token:
            raise BrokerError("not_configured", f"{ATTEMPT_TOKEN_ENV} is not set")
        headers = {"accept": "application/json", "authorization": f"Bearer {self.token}"}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, method=method, headers=headers
        )
        try:
            with self._open(request) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise BrokerError(*_error_from_body(error), status=error.code) from error
        except urllib.error.URLError as error:
            raise BrokerError("unreachable", str(error.reason)) from error
        except (ValueError, OSError) as error:
            # A 200 whose body is not JSON is as unusable as no answer at all.
            raise BrokerError("unreachable", str(error)) from error

    def tools(self) -> List[Dict[str, Any]]:
        """The catalog for this attempt, already filtered by the job's scopes.

        Filtering on the broker side is what keeps an out-of-scope tool out of
        the model's context entirely, rather than letting it be proposed and
        then refused after a turn has been spent on it.
        """
        result = self._call("GET", "/tools")
        tools = result.get("tools") if isinstance(result, dict) else None
        return [tool for tool in tools if isinstance(tool, dict)] if isinstance(tools, list) else []

    def propose(
        self, kind: str, connection_id: str, payload: Dict[str, Any], client_ref: str
    ) -> Dict[str, Any]:
        """Propose one action. The broker's answer is the whole of the outcome."""
        body: Dict[str, Any] = {
            "kind": kind,
            "connection_id": connection_id,
            "payload": payload,
            "client_ref": client_ref,
        }
        return self._call("POST", "/actions", body)

    def action(self, action_id: str) -> Dict[str, Any]:
        """Read one action back, for the receipt a dispatch left on it."""
        result = self._call("GET", f"/actions/{action_id}")
        action = result.get("action") if isinstance(result, dict) else None
        return action if isinstance(action, dict) else {}

    def propose_procedure(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Refer an existing owner intervention; the service owns generation and evaluation."""
        return self._call("POST", "/tools/learning/propose", payload)


def _error_from_body(error: "urllib.error.HTTPError") -> tuple:
    """Pull the broker's own error code out of a non-2xx body.

    The broker names its refusals (`scope_denied`, `budget_exceeded`,
    `approval_required`, ...). Those names are worth more to the model than the
    status code, so they are preserved when the body carries one.
    """
    try:
        parsed = json.loads(error.read().decode("utf-8", errors="replace"))
    except Exception:  # noqa: BLE001 - a malformed error body is still an error
        return (f"http_{error.code}", f"broker returned HTTP {error.code}")
    detail = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(detail, dict):
        return (
            str(detail.get("code") or f"http_{error.code}"),
            str(detail.get("message") or f"broker returned HTTP {error.code}"),
        )
    return (f"http_{error.code}", f"broker returned HTTP {error.code}")
