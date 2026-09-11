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

`JobService` exposes create/read/list/input/cancel and objective revisions.
State changes use `contracts.transition` and pg-boss's Drizzle transaction adapter.
Both `/jobs/:id/input` and the frozen `/jobs/:id/messages` spelling accept input.
The integration tests walk every legal edge and reject every illegal input.

## Attention as a contract

`questions.ts` holds the owner's one question queue. A wake ends with at most one
question: `resolveQuestions` merges whatever the attempt raised with whatever the
job was already holding, keeps the first that blocks an external effect, else the
nearest deadline, else the oldest, and leaves the rest on `job.deferred_questions`
for a later wake. A partial unique index makes "one open question per job" a
database fact. Answering through `POST /questions/{id}/answer` is an ordinary
input submission, so it reuses the receipt, the reply obligation and the wake that
`submissions.ts` and `replies.ts` already provide, and it wakes that job alone.

`ReplyService.enqueue` is the only path into the notification outbox. It refuses a
row whose `because` is empty, and every row carries `if_ignored` in plain words
with a real date when the job row knows one. A quiet monitor whose check found no
delta has nothing to cite and therefore writes nothing; creating one owes no reply
at all, while sending it a message still does.
