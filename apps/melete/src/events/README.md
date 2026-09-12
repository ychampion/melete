# Persisted events and SSE

The event store and stream are implemented. They use persisted sequence cursors,
a database listener and bounded stream buffering. Evidence in
`test/integration/events.test.ts` includes:

- `receives an append concurrent with subscription establishment exactly once`.
- `duplicate event delivery emits one stored row and no duplicate frame`.
- `a slow consumer retains one page and receives every persisted event in order`.
- `replays across a terminated LISTEN connection and cleans it up on shutdown`.
- `a gap marker names its persisted notice and rollback holes never invent gaps`.

The contract helper labels text deltas non-durable, but the current attempt
runner persists incoming text-delta events. Conformance 5's `the gap in the
event stream is recorded, and history is never shown as missing` checks those
stored rows and the gap notice. The client helper's sequence-skip gap behavior
differs from explicit server gap notices; a jump alone is not proof that a
filtered stream lost durable history. Complete gap-aware reference-UI integration
is **not claimed**. See [CLIENT](../../../../docs/CLIENT.md).
