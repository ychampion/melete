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
read adapter and the model gateway. Live exclusive-broker reachability is
**not claimed**: the container probes are **written, not run**, and Postgres
shares the declared runtime network.

See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md),
[ENGINEERING](../../../../docs/ENGINEERING.md), and
[THREAT-MODEL](../../../../docs/THREAT-MODEL.md) for evidence and limits.
