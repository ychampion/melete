# 0003 - Job state lives in Postgres as a bounded state machine

Status: accepted
Date: 2026-09-11

## Problem

The promise is that you can close the tab. That means a responsibility has to
outlive the process working on it, the machine rebooting, and the queue losing a
message. It also means the number of things a job can be has to be small enough
to reason about, or "waiting" quietly becomes "stuck".

## Decision

Nine states, one pure transition function, one database.

Jobs, waits, approvals, actions, and receipts live in Postgres. pg-boss runs in
the same database, so a job transition, its domain event, and the enqueue of its
next wake commit in a single transaction. Due times and wait predicates live on
the job row independently of queue retention, and a recovery scan every 60
seconds re-enqueues anything whose wake passed with no live wake.

Starting an attempt increments `lease_epoch`. The attempt's capability token
carries the epoch, and the broker refuses any action whose epoch is not current.
A fenced attempt can still deliver a late receipt for something it already
dispatched, which is recorded and marked late, and cannot restart work.

Every wake runs exactly one bounded attempt and then commits an outcome. Waiting
never holds a process.

`transition(state, input)` is pure and returns a `Result`. It is the same
function the service calls and the tests call.

## Alternatives

- **Redis or an in-memory queue.** A restart loses due work, which breaks the one
  promise the product makes.
- **A separate queue service.** Two systems that must agree, with no transaction
  spanning both.
- **Free-form status strings.** Every new state gets invented at the call site
  and nothing is exhaustive.

## Evidence

The state machine ships with a test that walks every legal edge in the
specification plus a set of illegal ones, including the rule that nothing at all
moves a finished job. Completion requires the attempt outcome, every action
terminal, and the deliverable predicate together, so a "final answer" with no
evidence becomes `waiting_for_input`. That is a test, not a hope.
