# Brokered effects

`BrokerService` records canonical actions, checks authority and approvals,
reserves budgets, dispatches and reconciles. Conformance 3 tests
`the action is never dispatched a second time, including after broker restart`;
conformance 4 tests `admission is rejected when the payload hash no longer
matches the approval`.

`intent_key` binds job, revision, connection, kind and canonical payload hash.
Tests include `the database itself refuses a second action for one intent key`
and `one changed byte is a different effect that needs its own approval`.
Semantic deduplication beyond that identity is **not claimed**.

`resume` (`POST /actions/{id}/resume`, attempt capability only, no body read)
carries out an approved action by id. It checks the attempt, the job, the chat
send rule and the tool scope, then calls the same `admit` and `dispatch` a
byte-identical proposal reaches, so the stored bytes, their hash and revision
binding, the budget reservation and the fence are the existing ones. Every
other status reads back its disposition; an unknown outcome is never replayed.
`resume.ts` offers the `resume_action` tool only while an unexpired approval
for the current revision waits.

`startEffectBoundary` installs `createMemoryTrustResolver` by default.
`an address read off a page is refused as untrusted_recipient_origin` exercises
the memory/broker seam; it is no longer an unwired table-only stub.
Recognized payload origin fields and their warnings are checked again before
admission. `an approval given before the origin was known does not count`
tests changed origin information.

The optional authority resolver can supply current policy/connection generations.
Without injection, `authority.ts` defaults those generations to zero;
universal integration with every policy-generation source is **not claimed**.
The permissive authorization callback used by tests is not a shipped owner
configuration feature; reusable send authorization is **not claimed**.

The internal listener combines broker routes, a service-authenticated action
read adapter and the model gateway. Scenario 6 on the Linux Compose stack
(2026-09-12) showed this listener as the cell's only reachable peer: Postgres,
the web service and the owner control plane were unreachable from a claimed
attempt and from the warm cell.

See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md),
[ENGINEERING](../../../../docs/ENGINEERING.md), and
[THREAT-MODEL](../../../../docs/THREAT-MODEL.md) for evidence and limits.

## Typed faults and the repair policy

`repair.ts` is the policy: one pure decision function and a driver that performs
only what the decision chose. A connector raises a typed `ConnectorFault`; the
policy reads the class and repairs the cause. It retries a transient failure
with jittered backoff inside the dispatch deadline, parks a rate limit on a
timer and releases the worker, refreshes an expired credential once and rechecks
the grant, stops dead on a revoked one, re-discovers a drifted schema and
proposes a mapping, takes one equivalent authorized route for the same
operation, reconciles an uncertain outcome through `verify`, and escalates one
diagnosis when nothing else applies.

A repair may change a selector, a wrapper, the route, the credential, or a
field's name under a mapping whose every value survives unchanged. It may never
change a recipient, an amount, a resource, or the business intent. The action
row is not rewritten: the id, the `payload_hash`, the `intent_key` and the
approval are the same on every attempt, and only the payload handed to the
connector differs. Each line of `action.repair_trace` carries the hash of the
bytes that attempt sent, so the record shows exactly when and why the wire form
changed.

`checkAuthority(tx, job, action)` is everything that has to be true for those
bytes to leave: the connection is still this connection and still active, the
generation admission reviewed is current, the tool and scopes are still held,
the binding still matches, and the origins are still the approved ones. The
dispatch asks it once before marking the action dispatched, and the policy asks
it again before every further execution, so a grant revoked during a backoff
fences the retry instead of being out-run by it.

A revision never re-aims an effect. For `write_external` and `spend` the person
approved exact bytes and the action keeps that hash, so no revision is accepted
at all; elsewhere a revision may correct content but never a recipient, a
destination, an amount, a resource, or the set of fields the person saw, and it
is measured against the approved payload rather than the last one sent.

`repair_candidate` holds a drift mapping as a proposal with the test it must
pass. The connector must have declared the rename, a field that decides where
the effect lands keeps its name, and the test names the operation and the values
that must survive rather than recomputing the expected payload with the same
rename. A candidate becomes `applied` only after that test passed and after the
send it carried landed; anything ambiguous is `rejected` and the action stops.

Parking a rate-limited action ends its attempt as well as moving the job onto a
timer, because the runner's recovery sweep only fences attempts whose job is
still running. `parkAttempt` is the seam for the jobs module to own that
release. The due time is enforced under the dispatch row lock, and the recovery
scan passes the instant it selected with, so two clocks cannot disagree about
whether an action is ready.

Per-class counters and the disposition live on the action row, and
`GET /jobs/{id}/repairs` reports them with the trace and the candidates.
`completed` is the only disposition that means the effect happened; every other
one is a safe stop and is never summed with a completion.

## Execution in the cell

`exec.run` and `exec.python` are `in_cell` tools: the cell proposes the intent,
claims one dispatch with `POST /actions/{id}/execution/start` (a lost response
is never replayed), runs the command inside its own workspace, and settles the
recorded outcome with `POST /actions/{id}/execution/settle`. Settlement accepts
late evidence and checks the record against the tool's declared record schema;
`execution-admission.test.ts` proves the real broker refuses a stale epoch or an
exhausted budget before anything runs.

