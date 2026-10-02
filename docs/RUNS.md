# Long work

A run is a goal an assistant keeps working on in the background for as long as
it takes: an afternoon, a week. It is started from a conversation (the
assistant calls `run.start` when a request is too big for one reply) or
directly with `POST /runs`, and it reports back as it goes.

## Shifts

A run works in shifts. Each shift is one ordinary bounded attempt with its own
ceilings (`RUN_SHIFT_BUDGET` in `apps/melete/src/runs/service.ts`: 45 minutes,
200 model calls, 400,000 output tokens, 200 actions). The ceilings only stop a
runaway shift; the run itself has no overall limit unless the person sets one
(`PUT /runs/{id}/limit`: hours, shifts or output tokens).

Between shifts the service decides what happens next from durable rows, with
no model call (`RunService.shiftEnded`):

| The shift ended… | What happens |
| --- | --- |
| after `run.finish` | the run completes with that result |
| asking the person, or parked on an approval | that wait stands, as for any job |
| with `run.checkpoint` | the next shift starts now, at the time it named, or when its helpers are done |
| without a handoff, or at its ceiling | a handoff is written for it from what it said, and the next shift starts |
| having done nothing but hand off to go on now, three times in a row | it stops and asks what to change |
| failing three times in a row | it stops and asks, naming the failure, instead of ending |
| at a limit the person set | it stops and asks before going on |

Failed shifts are counted in a row, not in total, so a run that has worked for
a hundred shifts is not near any attempt limit. Budget ledger rows for a run
are counted per shift.

## The record

Everything a run learns goes into `run_entry`, append-only and ordered: the
plan, notes, findings, decisions, tries and their measured results, progress
updates, each shift's handoff, helpers starting and finishing, and the result.
The next shift starts from the record (`runBrief` in
`apps/melete/src/runs/record.ts`), not from an ever-growing transcript: the
goal, the plan, where the last shift left off, the best try and the latest
ones, recent findings and what the helpers returned.

`GET /runs/{id}/record` pages through it and `GET /runs/{id}/export` returns
it as one Markdown document.

## Tries and their values

`run.log` with `kind: "experiment"` records a try: what was tried, the value it
measured, and whether it was kept. A try may cite the actions whose output
shows its value. The service checks the value against the stored output of
those actions (succeeded actions of the run or its helpers only), and marks it
checked when the number is there, exactly or rounded to two or more decimals.
The best try is chosen by the service: checked tries first, then the better
value in the run's direction. A value nobody measured does not win over one
that was measured.

## Helpers

`run.delegate` starts a helper: a separate job on the same or another
assistant (matched by name or role), working in parallel in its own shifts,
filing its entries under the run. A run may have six helpers working at once,
and a helper cannot start helpers of its own. A helper that answers without
asking to continue is done with that answer. A helper never stops to ask the
person, who does not see it: where a run would ask (a question of its own,
repeated failures, no progress), the helper ends instead and its run reads why
with its result. When the last helper is done, a
run waiting on them is woken; a run that is mid-shift reads their results at
its next shift, and a waiting run also wakes on its own after 30 minutes.

## Tools

| Tool | Offered to | Effect |
| --- | --- | --- |
| `run.start` | conversations | starts a run tied to the conversation |
| `run.log` | runs and helpers | adds to the record; a `report` also notifies the person |
| `run.delegate` | runs | starts a helper |
| `run.checkpoint` | runs and helpers | ends the shift with a handoff and when to continue |
| `run.finish` | runs and helpers | records the result; the work completes |

They are native broker tools, pinned in the attempt's core catalog for the
kinds of job their scopes are given to. Effects outside Melete go through the
broker and the person's approval rules exactly as in a conversation. Runs and
helpers read public web pages the way conversations do, unless the space turned
that off or the space or agent is private.

## The person's side

`GET /runs` lists runs (one conversation's with `conversation_id`),
`GET /runs/{id}` gives a status line, the latest update, what is next, the best
try, the helpers and any question. `POST /runs/{id}/message` answers a question,
wakes a resting run, is read at the next shift of a working one, or takes a
finished run up again. Pause lets a shift under way finish and starts no new
one; Stop ends the run and its helpers. A run that goes a day without an
update gets a short one written from its record.

## Evidence

`apps/melete/test/integration/runs.test.ts` covers shifts continuing from the
handoff, the automatic handoff, idle and failure stops, limits, per-shift
budgets, helpers waking their run, pause, resume and stop, checked tries, and
the broker path (which tools each kind of job is offered, and refusals a model
can read).
