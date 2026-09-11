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
