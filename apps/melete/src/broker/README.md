# Typed effects, approvals, budgets, receipts

The only path from a runtime to the world.

`propose -> authorize -> admit -> dispatch -> receipt -> verify`, exactly as in
`docs/ARCHITECTURE.md`. The rules that make it worth having:

- The payload is canonicalised and hashed on arrival. Approval binds the action
  id, hash, resource, recipient, connection id, acting principal, expiry, and job
  revision; editing a draft creates a new action.
- Admission is a single transaction that re-checks epoch, policy, approval, and
  budget, and fails closed.
- `idempotency_key` is always the action id, so a retry is the same request.
- A dispatch that times out is `unknown`, never replayed. `verify` may resolve
  it; if it cannot, the action rests at `unresolved` and the job asks the owner.
- Receipts are persisted before the runtime learns the result. A late receipt
  from a fenced attempt is recorded and marked late.

`BrokerService` persists these transitions under the job row lock. The internal
Hono surface provides the attempt-scoped tool catalog and action routes, plus
API-only approval decisions under a distinct service credential. The combined
listener also runs the model gateway on local W2 port 3112. The API uses port
3110 when configured locally; compose publishes only its API port.

`resolveAuthority(tx, { job, action, phase })` injects current policy and account
authority at proposal, decision, admission and execution. It may return current
`policyGeneration`, `connectionGeneration`, `actingPrincipal`, `resource`,
`recipient`, and `allowed`. The defaults use generation zero, the single owner,
and targets derived from the canonical payload. W1's resolver must read its
generation columns using the supplied transaction and lock the applicable policy
row so policy changes serialize with admission. The broker itself locks the
connection row and checks current status/scopes. A generation change requires a
new reviewed action. `startEffectBoundary` accepts this resolver as a dependency.

The full tuple and its hash are stored in a deterministic `effect_binding` event;
the admission event records the reviewed generations. This uses the frozen
event JSON contract until the generation columns merge. Approval expiry defaults
to 24 hours and may be shortened with service-owned `approvalTtlMs`; changing its
stored expiry cannot extend an existing authorization. No runtime payload can
choose policy, principal, expiry, or a generation.

At execution, a revoked or replaced connection returns a fenced disposition and
the broker records `failed` with `reconciliation.reason: "connection_generation"`.
It releases the unused reservation without setting `dispatched_at` or calling
the connector. The connection check and dispatch marker share a transaction;
revocation after that marker cannot retroactively undo an outgoing request.

An admitted action left by a process crash can continue under its original id;
an `unknown` or `unresolved` action cannot execute again. Authentic connector
receipts and verification results can settle uncertain actions after a fence,
with `late: true`, while leaving cancelled jobs and terminal attempts unchanged.
Runtime HTTP requests cannot submit receipts directly.

The API read adapter in `src/api/actions.ts` returns actions regardless of job
state, with uncertain actions ordered first. On the internal listener,
`GET /actions?job_id=<id>` requires the API service bearer and
`x-melete-space-id`; an attempt capability cannot use this read route. W1 may
mount the same read adapter behind its owner authentication. Cancellation stays
visible alongside any unconfirmed send.

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

`repair_candidate` holds a drift mapping as a proposal with the test it must
pass. It becomes `applied` only after that test passed and after the send it
carried landed; anything ambiguous is `rejected` and the action stops.

Per-class counters and the disposition live on the action row, and
`GET /jobs/{id}/repairs` reports them with the trace and the candidates.
`completed` is the only disposition that means the effect happened; every other
one is a safe stop and is never summed with a completion.

## Effect identity across attempts

At proposal the broker derives
`intent_key = sha256(job_id, job_revision, connection_id, kind, payload_hash)`,
stores it on the action, and holds it under a unique index. A proposal whose key
already exists returns that action and its current state and never makes a second
one; `unknown` is returned as `unknown` and nothing is dispatched. The response
carries `intent_key`, `repeated`, and a `message` built from the record, so a
repeat of a send that already happened reports the time and the receipt instead
of a fresh send. One changed byte is a different payload hash and therefore a
different key, so an edited draft is a new action with its own approval. A
`client_ref` still short-circuits earlier and still refuses changed content under
a reused reference.

## Trust-class admission

`resolveTrust(tx, input)` answers where each recipient, destination, amount and
resource field in the canonical payload came from: `owner`, `verified_connector`,
`external_content`, `inferred`, or `unknown`, with the handle it came from. It is
asked at proposal, at admission, and again at dispatch. For `write_external` and
`spend`, any field that is not `owner` or `verified_connector` becomes an
`origin_warning` in plain words, stored on the approval record and carried in the
`approval_requested` event and the `/approvals` response.

The set of warnings is hashed and the approval is bound to it. An approval taken
before an origin was known is set aside when the origin becomes known: the action
returns to `needs_approval`, the person is asked again with the warnings
attached, the superseded answer is recorded as an `approval_superseded` notice,
and admission is refused with `untrusted_recipient_origin`. Resetting an approval
keeps the expiry the effect binding already fixed, so no answer can extend an
authorization.

`resolveStandingGrant(tx, { job, action, tool })` may remove the approval
requirement, but only when nothing about the payload is in doubt. v0.1 ships no
grants: the option defaults to absent and every external send is approved once,
per payload hash. Without `resolveTrust` nothing is asked and nothing is warned
about, which is the shipped behaviour until the memory lane supplies a resolver.
