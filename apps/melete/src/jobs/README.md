# Durable jobs and wakes

`JobService`, `AttemptRunner` and pg-boss implement durable job transitions and
recoverable wakes. Conformance 1 tests `exactly one attempt is admitted for the
duplicated timer`; conformance 2 tests `A cannot admit an action: the broker
refuses it with stale_epoch`; conformance 5 tests `the job resumes from durable
state on the next wake`. These are scripted process/fixture checks, not a claim
of installed Hermes recovery.

Completion checks persisted evidence (`artifact completion requires a referenced
record matching the declared glob`; `message-sent completion checks connection
and the matching stored receipt`). Bounded transcript tests include
`fails closed when completed tool identities exceed either context cap`.

Questions are ranked and coalesced by the service. `three questions in the same
minute make one queue entry per job, and answering the middle one wakes only that
job`, `an attempt that emits two questions asks one and asks the other on the
next wake`, and `the outbox refuses a notification that cites nothing` cover
attention behavior.

Full reference-client support and autonomous task capability are **not claimed**.
See [ARCHITECTURE](../../../../docs/ARCHITECTURE.md) and
[ENGINEERING](../../../../docs/ENGINEERING.md).
