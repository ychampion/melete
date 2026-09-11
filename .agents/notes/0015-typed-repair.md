# 0015. Failures are classified and repaired, not retried

Status: accepted. Supersedes nothing; extends 0007 and 0010.

## The problem

Before this, a connector that failed handed the broker a string. The broker had
exactly two things it could do with a string: treat it as a failure, or treat it
as an unknown outcome. Both are honest and both are expensive. A socket that
closed before the request left is free to retry and was not retried. A
destination that renamed a field under a working call looked identical to one
that had gone away. A token that expired an hour ago produced a failed
responsibility instead of a refreshed token.

The alternative that is easy to reach for is worse. A blind retry is three lines
of code, and on the one class of failure where the answer was lost rather than
never given, it turns one message into three. That trade is the reason this note
exists: the value of classification is almost entirely in the retries it
*refuses*.

## The decision

A connector raises a `ConnectorFault` with a kind from a closed set, a
`may_have_committed` flag, an optional `retry_after`, and plain-words detail. The
broker's policy reads the class. Nine classes, nine dispositions:

| Fault class | What the policy does |
|---|---|
| `transient_before_dispatch` | retry the same bytes, exponential backoff with full jitter, at most three executions, and not at all if the deadline leaves no room |
| `rate_limited` | persist `retry_after_at`, put the action back to `admitted`, park the job on a timer, release the worker |
| `expired_credential` | borrow the credential inside the store's `withSecret`, once, then retry only if the connection row still permits the call |
| `revoked_credential` | stop. `failed{reason: connection_revoked}`, and one question asking for a reconnection. Never another identity |
| `schema_drift` | ask the connector to `describe()` itself, propose only a rename it vouches for, write it down as a candidate with a test, and retry only if that test passes |
| `unsupported_route` | take one equivalent authorized route for the same operation, same action id, same intent key, recorded as `change_route` |
| `uncertain_outcome` | reconcile through `verify`; stay `unknown` when the evidence is insufficient |
| `bad_output` | re-open, revise, re-validate, once, and only where the revision changes nothing the approval was given for. A file existing is never a delivery |
| `unclassified` | nothing is retried and nothing is resolved; the action rests at `unknown` exactly where the broker has always rested it |

A repair may change a selector, a wrapper, a route or a field's name. It may
never change a recipient, an amount, a resource, or the business intent. The
action row is not rewritten: a repaired attempt carries the same id, the same
`payload_hash`, the same `intent_key` and the same approval, and the only thing
the policy hands the connector differently is the payload on the wire. Every
line of the trace records the hash of the bytes that attempt sent, so the record
itself shows when the wire form changed and that it changed only under an
applied mapping.

## Why a retry re-asks for permission

The dispatch transaction checks the connection generation, the connection's
status and scopes, the effect binding and the origins the approval was given
against, and then marks the action dispatched. A repair sends a second request
to the world, minutes later in the case of a backoff, and permission is a
current fact rather than a remembered one: a grant revoked while the policy was
waiting has to fence the retry. Those checks are one method now, and the policy
asks it before every execution including the first. Anything but a clear answer
stops the action at `needs_reconnect`, and nothing is sent.

## Why a revision may not re-aim an effect

A revision exists to correct an output that failed its own validation. It is not
a second chance to choose a recipient. For `write_external` and `spend` the
person approved exact bytes and the action keeps that hash, so no revision of
one is permitted at all; a send that needs different content is a new request,
approved on its own. Everywhere else a revision may change content but never a
value read as a recipient, a destination, an amount or a resource, and never the
set of fields the person saw. The comparison is against the approved payload
rather than the last one sent, so two individually harmless-looking steps cannot
add up to a different effect.

## Why a drift mapping needs the connector to vouch for it

A missing field and a surplus field lining up is not evidence of anything. From
outside a payload, a recipient and a memo look exactly alike, and an earlier
version of this policy accepted `to` becoming `memo` as an obvious rename. Three
things are required now. The connector declares the equivalence in its
description, because only it knows what its destination renamed. A field that
decides where the effect lands keeps its name whatever the destination now calls
it. And the candidate's test states the operation and the decisive values that
must survive, then checks those against what the mapping produced, rather than
recomputing the expected payload with the same rename, which would prove only
that a function is itself.

## Why an untyped throw is treated as uncertain

`may_have_committed` defaults to true for anything nobody classified. A bare
`Error` says nothing about whether the request left the process, and the only
safe reading of "I do not know" is "it might have happened". That is also what
keeps the change additive: a connector that was never taught to raise typed
faults behaves exactly as it did before, and conformance scenario 3 still passes
unchanged. Typing a fault can make a failure more repairable; it can never make
one less so.

## Why a rate limit parks rather than sleeps

Holding a worker for the minute a destination asked for is a worker not doing
anything else, and a fleet of them is a thundering herd with a delay on it. The
action goes back to `admitted` with `retry_after_at` set, the job moves to
`waiting_for_event_or_time` with a `timer` wait and a `timer_or_event` substrate
disposition, and the recovery scan's `resumeParked` dispatches it when it is
due, under its own id. This is only safe because the fault is a definitive
non-execution: nothing that `may_have_committed` is ever un-dispatched.

Parking ends the attempt as well, because a job that waits while its attempt
still holds a lease is a worker nobody will reclaim: the runner's recovery sweep
only fences attempts whose job is still `running`, and the heartbeat that would
renew the lease belongs to a process that has moved on. `parkAttempt` is the
seam for the jobs module to own that release; without one the broker performs
the equivalent itself, ending the attempt and emitting `attempt_ended`.

The due time is enforced under the dispatch row lock, so a wake, a repeated
proposal and a queue redelivery all serialize on it rather than racing past it.
The recovery scan passes the instant it selected with into the dispatch, because
two clocks disagreeing is how an action gets chosen by one and refused by the
other.

A resumed action appends to its trace and counters rather than replacing them. A
completion that erased the rate limit which caused the wait would make a
recurring rate limit invisible on the only record that survives.

## Why a drift mapping is a record before it is a change

`repair_candidate` holds the proposal, the shape re-discovery found, the test the
mapping must pass, and its evaluation. A mapping becomes `applied` only after
its test passed and only after the send it carried actually landed. Anything
ambiguous, two missing fields, two surplus ones, a rename that would drop or
alter a value, is `rejected` and the action stops with a question instead. The
safety judgement is `isSafeFieldMapping`, which compares the multiset of values
before and after; it is a function with tests, not a model's opinion.

## What is measured

Per-class counters and the disposition live on the action row, and
`GET /jobs/{id}/repairs` reports them with the ordered trace and the candidates.
Completions and safe stops are counted apart and must never be summed:
eleven safe stops delivered nothing, and reporting them as eleven successes or
eleven failures is wrong in opposite directions. `CLIENT.md` carries the rule.

## What the fixtures may hold

Every test fixture applies the committed migration journal in the order the
journal gives. Naming migrations by filename let a fixture hold a schema no
install has ever had, and a property proved against a schema nobody runs is not
proved.

## Falsifiers

`apps/melete/src/broker/repair.test.ts` runs every class against a deterministic
destination double, adapted from the reviewer's eleven-case fixture plus bad
output and rate-limit timing. For each case it asserts the disposition, that the
destination holds one effect or none, and that every value the owner approved
survived. A blind-retry control runs the same cases with the policy switched off
and produces the duplicate the classification prevents.

`apps/melete/test/integration/repair.test.ts` runs the same classes through the
broker against real Postgres and the durable test destination: identity and
approval preserved, the trace and counters persisted, the job parked and
resumed, the candidate applied, and one question in the owner's queue however
many times the same failure recurs.

## What was not done

Only the `test` connector implements a store-backed credential refresh, and it
does so by borrowing the value inside the store's `withSecret` and keeping
nothing but the fact that a refresh happened; the falsifier asserts the value
appears in no action row, event, receipt, question or destination record. A
connector with no credential store cannot refresh and stops at
`needs_reconnect`, which is the honest outcome rather than a silent retry.

`calendar` and `files` classify only what they can classify honestly: a CalDAV
429, 401 and 403, and a file whose content is not what the action recorded or
what was written. `web` and `email` classify nothing yet. A web fetch already
reports the destination's status in its receipt rather than failing on it, and a
mail transport error is not yet distinguishable enough to name a class without
guessing, which is the guess this note exists to refuse. Both keep their present
behaviour exactly, which now reads as `unclassified`.

A write in the files connector is now read back and compared before it answers
`succeeded`. That is the smallest real form of "never mark delivered because a
file exists": the receipt's hash is the hash of what is on disk.

`reviseOutput` is a seam, not an implementation: absent a reviser, a bad output
stops at `needs_input`. Nothing here invents a revision.
