# Durable jobs and wakes

The state machine from `@melete/contracts` plus the machinery that keeps a
responsibility alive across restarts.

- One transaction commits the job transition, the domain event, and the pg-boss
  enqueue of the next wake.
- `next_wake_at` and the wait predicate live on the `job` row, independent of
  queue retention, so a lost timer is recoverable.
- A recovery scan every 60 seconds re-enqueues jobs whose wake time passed with
  no live wake, and fences attempts whose lease expired.
- Starting an attempt bumps `lease_epoch`. The capability token carries the
  epoch; the broker refuses anything stale.
- Every wake runs exactly one bounded attempt and then commits an outcome.
  Waiting never holds a process.

Owned by workstream W1.
