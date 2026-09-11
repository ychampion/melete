# 0011 - Attention is a contract, not a feed

Status: accepted
Date: 2026-09-11

## Problem

A responsibility that runs while nobody is watching accumulates things it would
like to say. Left alone, that becomes a feed: several questions from one job,
notifications whose only justification is that the model felt like sending one,
and a monitor that reports "still nothing" every hour. A feed trains the owner
to stop reading, and an assistant nobody reads is worse than one that says less.

The pieces to hold together were already in the service. W1 built reply
obligations, a notification outbox, submissions with idempotent receipts, and
attention counters that reduce a routine job's cadence once its results go
unread. What was missing was the rule that decides what may reach a person at
all.

## Decision

Three rules, enforced by the service rather than asked of the model.

**A wake ends with at most one question.** An attempt may raise several; the
service keeps one and holds the rest on the job row as `deferred_questions`,
asking them on later wakes. The one it keeps is the first that blocks an
external effect, else the one with the nearest deadline, else the oldest. The
attempt bundle states the budget rather than implying it: `attention.guidance`
says one question, and `attention.questions_allowed` is zero while a question is
already open.

**One queue, one entry per job.** `GET /questions` is the owner's whole inbox,
ordered by the same rule. A partial unique index on `question (job_id) where
state = 'open'` makes "one open question per job" a database fact rather than a
convention. Answering is `POST /questions/{id}/answer`, which admits the text
through the existing submission path: the same idempotency key, the same
receipt, the same reply obligation, the same wake. There is no second inbox and
no second way to deliver an input.

**Nothing is sent without a reason and a consequence.** Every question and every
notification carries `because`, a non-empty list of durable handles such as
`event:4821` or `obligation:obl_01J...`, and `if_ignored`, one plain sentence
that carries a real date when the service knows one. `ReplyService.enqueue` is
the only path into the outbox and refuses an empty `because` with
`notification_without_because`; a check constraint refuses it again below.

The consequence of that third rule is the quiet monitor: a check that found no
delta has no handle to cite, so it writes nothing. Creating a quiet monitor owes
no reply either, because the owner asked to be left alone until something
changes. Sending one a message still owes a reply, because that is a person
asking a question.

## Alternatives

- **Let the model decide how much to send.** The model has no view of the other
  jobs, so it cannot know whether its question is the one that matters this
  hour. The ordering rule needs the queue, and the queue is the service's.
- **A separate question inbox with its own delivery.** Two inboxes drift: one
  would have idempotent receipts and recovery, and the other would grow them
  badly a year later. Answering as an ordinary input keeps one path.
- **Advisory `because` rather than an enforced one.** Optional provenance is
  provenance nobody fills in. Making the outbox refuse the row is what keeps the
  field honest, and it is what makes "no delta, no notification" fall out rather
  than be remembered.

## Cost

A question the runtime raised inside an attempt that then died is lost with the
attempt, because the frozen runtime event stream carries the outcome and not the
questions. That matches the existing rule that an interrupted run is a dead
attempt and is never resumed; the deferred questions already on the job row
survive, because they are job state rather than attempt state.

## Evidence

`bun test apps/melete/test/integration/attention.test.ts` covers the four
falsifiers: three jobs reaching a question in the same minute produce one queue
entry each in the ranked order, and answering the middle one leaves the other
two waiting and enqueues exactly one wake; a quiet monitor across five checks
writes no outbox row for the four that saw nothing new and one row citing
`event:<seq>` for the check that did; an attempt emitting two questions asks the
blocking one and asks the other on the next wake; and an outbox row without a
`because` is refused by the service with a typed error and by the database with
`notification_because_not_empty`.
