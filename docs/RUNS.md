# Long work

A run is a goal an assistant keeps working on in the background for as long as
it takes: an afternoon, a week. It is started from a conversation (the
assistant calls `run.start` when a request is too big for one reply) or
directly with `POST /runs`, and it reports back as it goes. A run started from
a conversation keeps that conversation's limits on what it reads (its allowed
sites and whether it stays out of private knowledge), and so do its helpers.
A goal the person typed into `POST /runs` is recorded as theirs; one an
assistant wrote is recorded as derived.

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
| after `run.finish` | the run completes with that result, or, when it has a definition of done, its result is checked first (below) |
| asking the person, or parked on an approval | that wait stands, as for any job |
| with `run.checkpoint` | the next shift starts now, at the time it named, or when its helpers are done |
| without a handoff, or at its ceiling | a handoff is written for it from what it said, and the next shift starts |
| having done nothing but hand off to go on now, three times in a row | it stops and asks what to change |
| failing three times in a row | it stops and asks, naming the failure, instead of ending |
| lost after it gave its result | it completes with that result instead of trying again |
| at a limit the person set | it stops and asks before going on |

Failed shifts are counted in a row, not in total, so a run that has worked for
a hundred shifts is not near any attempt limit. Lost shifts count as failed
ones, and the count starts again whenever the person writes to the run
("continue" or anything else). Budget ledger rows for a run
are counted per shift.

## Checking the result

Long work most often goes wrong by calling itself done too early. When a run
that has a `done_when` calls `run.finish`, the result is not given yet: it is
recorded as offered, and a helper with a fresh start checks it. That helper is
given only the goal, what done means, the result offered and the evidence in
the record: the tries and whether each was measured, the findings, and the
output of the actions the result cites (`evidence` on `run.finish`). It
confirms, it does not redo the work, and it ends with `run.finish` and a
`verdict`: `passes`, or `gaps` with each gap named. Its shifts are bounded like
any helper's.

| The check… | What happens |
| --- | --- |
| passes | the run completes with its result; the record, the view (`check.state: "passed"`) and the status line say it was checked |
| finds gaps | the gaps go into the record and the next shift starts with them at the top of its brief; the next `run.finish` is checked again |
| finds gaps a second time (`RUN_CHECK_LIMIT`) | the run completes anyway, and the result the person sees ends with what could not be confirmed |
| ends without a verdict | the run completes, and its result says the check could not be finished |

The run is given its result by a shift that only records it, with no model
call (`RunService.settle`, called when the shift is claimed). `run.finish`
while the check is under way is refused with a reason the model can read.
Helpers' results are never checked, nor is a run without a `done_when`. The
person can turn the check off for one piece of work: `check_result: false` on
`POST /runs` or `PUT /runs/{id}/limit`.

## The record

Everything a run learns goes into `run_entry`, append-only and ordered: the
plan, notes, findings, decisions, tries and their measured results, progress
updates, each shift's handoff, helpers starting and finishing, and the result.
The next shift starts from the record (`runBrief` in
`apps/melete/src/runs/record.ts`), not from an ever-growing transcript: the
goal, the plan, where the last shift left off, the best try and the latest
ones, what was already tried and did not work, recent findings and what the
helpers returned. "Already tried, didn't work" lists failed and discarded tries
and notes logged with `dead_end: true`, so later shifts do not repeat them.

`GET /runs/{id}/record` pages through it and `GET /runs/{id}/export` returns
it as one Markdown document.

## Tries and their values

`run.log` with `kind: "experiment"` records a try: what was tried, the value it
measured, and whether it was kept. A try may cite the actions whose output
shows its value. The service checks the value against the stored output of
those actions (succeeded actions of the run or its helpers only), and marks it
checked when the number is there, exactly or rounded to two or more decimals.
Numbers are read whole: digits inside a longer number, an identifier, a date
or a version do not count.
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
repeated failures, no progress, an action it cannot read back), the helper
ends instead and its run reads why with its result. When the last helper is done,
however it ended (finished, failed, or cancelled through any route), a run
waiting on them is woken; a run that is mid-shift reads their results at
its next shift, and a waiting run also wakes on its own after 30 minutes.

## Tools

| Tool | Offered to | Effect |
| --- | --- | --- |
| `run.start` | conversations | starts a run tied to the conversation |
| `run.log` | runs and helpers | adds to the record; a `report` also notifies the person; `dead_end` marks an approach not to repeat |
| `run.delegate` | runs | starts a helper; refused once the shift has given its result |
| `run.checkpoint` | runs and helpers | ends the shift with a handoff and when to continue |
| `run.finish` | runs and helpers | records the result, with the actions it rests on; the work completes, or its result is checked first; a check gives its `verdict` here |

They are native broker tools, pinned in the attempt's core catalog for the
kinds of job their scopes are given to. Effects outside Melete go through the
broker and the person's approval rules exactly as in a conversation. Runs and
helpers read public web pages the way conversations do, unless the space turned
that off or the space or agent is private.

A model that has lost its way tends to repeat itself. Within one shift of a run
or a helper, the broker answers the same tool call (same name, same arguments)
three times and refuses the fourth, telling the model it already has that
result and to change its approach (`apps/melete/src/broker/repeats.ts`). A
retried delivery with the same client reference is not counted again.

## The person's side

`GET /runs` lists runs (one conversation's with `conversation_id`),
`GET /runs/{id}` gives a status line, the latest update, what is next, the best
try, the helpers and any question. `POST /runs/{id}/message` answers a question,
wakes a resting run, is read at the next shift of a working one, or takes a
finished run up again. Pause lets a shift under way finish and starts no new
one; Stop ends the run and its helpers. A run that goes a day without an
update gets a short one written from its record. Progress notifications go
out at most once every 30 minutes for a run; the rest stay in the record and
the view, and the result always goes out. `GET /runs` reads every run in the
list together, with a fixed number of queries and at most ten recent tries
each.

## Evidence

`apps/melete/test/integration/runs.test.ts` covers shifts continuing from the
handoff, the automatic handoff, idle and failure stops, limits, per-shift
budgets, helpers waking their run, pause, resume and stop, checked tries, and
the broker path (which tools each kind of job is offered, and refusals a model
can read). `apps/melete/test/integration/runs-check.test.ts` covers the check
of a result (passing, gaps sent back, given anyway after two, no verdict,
refused while under way, turned off), the "already tried" list, the repeat
guard, a cancelled helper waking its run, helpers ending at once, the failure
count starting again, a shift lost after its result, helpers that cannot read
an action back, the limits a run keeps, spaced-out notifications, and the
list agreeing with each view.
