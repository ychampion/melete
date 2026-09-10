# Typed effects, approvals, budgets, receipts

The only path from a runtime to the world.

`propose -> authorize -> admit -> dispatch -> receipt -> verify`, exactly as in
`docs/ARCHITECTURE.md`. The rules that make it worth having:

- The payload is canonicalised and hashed on arrival. Approval binds to that
  hash and to the job revision; editing a draft creates a new action.
- Admission is a single transaction that re-checks epoch, policy, approval, and
  budget, and fails closed.
- `idempotency_key` is always the action id, so a retry is the same request.
- A dispatch that times out is `unknown`, never replayed. `verify` may resolve
  it; if it cannot, the action rests at `unresolved` and the job asks the owner.
- Receipts are persisted before the runtime learns the result. A late receipt
  from a fenced attempt is recorded and marked late.

Not implemented yet.
