# Background work and what it costs

Much of what Melete does happens while nobody is waiting on it: standing work
that wakes on a schedule or a watch, routines, memory reading what was said,
learning from corrections. Every model call is recorded as either
`interactive`, when a person is waiting on it, or `background`, when nobody
is. The two are counted, reported and limited apart, so an operator can see
what background work costs each person per day, and a person's own messages
never wait behind it.

## Counting

Each model call any of the service's gateways settles is a row in
`model_usage` with its class, its step, the trigger behind it, and its tokens
and estimated cost (see [Spending caps](DEPLOYMENT.md#spending-caps) for the
price table).

| A call is… | When it is |
| --- | --- |
| `interactive` | an agent turn whose new input is the person's message or their answer to a question, or their decision on an approval; the first shift of a run the person started with `POST /runs`; a routine's run the person asked for with `POST /automations/{id}/test`; an attempt that picks up an interactive one cut off before it finished; a voice aside; a companies scan the person started; a web search or an action review made inside an interactive turn |
| `background` | an agent turn a trigger, a schedule or a timer woke (standing runs, routines, watches), in a conversation the person has written in as much as anywhere; memory reading what was said; learning proposals; a search or review made inside a background turn; any side call not listed above |

The class of an agent turn is decided from what caused that attempt alone, when
it starts, and written on the attempt (`attempt.class`, with
`attempt.trigger_id` when a trigger's event woke it), so every call the attempt
makes is counted the same way. A search or a review takes the class of the
turn that made it.

The step (`tier`) says which part of the service made the call:

| `tier` | The call |
| --- | --- |
| `interactive` | an agent turn a person is waiting on |
| `t2` | an agent turn something else woke |
| `service` | one of the service's own side calls: memory, learning, voice, reviews, searches, scans |
| `t1` | a batched look at what came in, for the step that sorts observations before anything wakes |

Each row also keeps `charged_input_tokens` (the input at full-price-equivalent
tokens, with cached reads and cache writes at their own prices) and
`cache_write_tokens`, so what the prompt cache saves shows per purpose.

## Daily totals

Each finished UTC day is rolled up into `usage_day`: one row per day, person,
space, class, step and purpose, with calls, input, cached input, cache
writes, charged input, output and dollars. One instance writes them, within
the hour after midnight UTC and for any earlier day of the last five weeks
that has calls and no rollup; a day is always replaced whole from
`model_usage`, so its rows match the calls they sum. Two writers of the same
day take their turn on a lock for that day. After its first pass, an instance
looks only at the days since its last one.

`GET /usage` gives the signed-in person, beside their day and month:

- `background`: the part of their day and month that ran in the background;
- `by_purpose` and `by_tier`: this month's calls, dollars and tokens by
  purpose (with its class) and by step;
- `days`: their last 30 UTC days, oldest first, with dollars, background
  dollars and calls (from the rollup, and from `model_usage` for today);
- `limits.background`: their background limits.

The installation's owner also gets `background_per_person_day`: background
cost per active person-day over the last seven finished days.

## Background cost per active person-day

A person-day is active when the person made at least one model call that day.
Its background cost is that day's background dollars for that person, zero
included. The median, 95th percentile and mean over a period, with the
background dollars split by step and by purpose, come from `usage_day`
(`backgroundCostPerPersonDay` in `apps/melete/src/gateway/usage-day.ts`).

A scripted week measures it end to end: two people's standing watches, memory
reads and conversations run through the model gateway on its fake transport at
the default model's prices, are recorded, rolled up and read back, and the
week and the figure are printed. It makes no paid call:

```bash
bun test apps/melete/test/integration/background-week.test.ts
```

## Limits

An installation runs without spending limits unless its operator sets them.
Each person's background calls have their own limits, beside the person's and
the installation's:

| Setting | Limit |
| --- | --- |
| `MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD`, `MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD` | Dollars one person's background calls may spend in a UTC day or month |
| `MELETE_SPEND_PERSON_BACKGROUND_DAILY_TOKENS`, `MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_TOKENS` | Input and output tokens for them |

At a background limit, no new background call is made, and background work
that would start does not. A run rests until the limit resets, and the person
is told once: "Background work has reached today's limit; it starts again on
October 16 at 00:00 UTC. Your own messages still go through." What arrives for
it meanwhile is kept and reaches it once it runs again. Other background work
ends with the same sentence. A person's own messages, and every call their
turn makes, never count against a background limit and are never held back by
one. The person's and the installation's limits still apply to everything.

Admissions in one service instance are judged one after another, each with
the calls before it held at the most they may cost, so calls started side by
side are refused exactly as calls made in turn would be. Several instances
each hold their own calls, so between them they can pass a limit by the calls
each is running at that moment.

A job's dollar limit (`max_usd_est`) counts its actions and the model's search
fees. With `MELETE_JOB_USD_COUNTS_MODELS=true`, it counts each of the job's
model calls at its estimated cost as well: a call is admitted while the limit
is not yet spent and charged when it reports, and the next call past it is
refused.

## The wake guard

The wake guard is always on, whatever the limits. Work woken 30 times in a
row within an hour, each time running the model and going back to rest with
nothing to show for it, is paused before its next wake starts anything, and
the person is told once: "It woke 30 times in the last hour with nothing new
to show, so it is paused. Resume it when you want it to keep going." It is a
notice on the work and a notification.

What counts is chosen so that only work that really spends and really finds
nothing is stopped:

- a wake counts only if the model ran in it; mail a watch's test turns away
  starts no attempt at all, and a wake held at a spending limit ran no model;
- something to show is a finding or an effect: an entry in a run's record
  other than its plan, notes and handoffs, an action that does more than read,
  a question, or an answer. One such wake starts the count again, and so does
  resuming the work. Reading alone, however often, is not progress.

Pausing loses nothing. A run's or routine's schedule is turned off, since a
missed time is not something that happened, but its watches and connection
triggers stay on with their place kept: what arrives while it is paused waits
and reaches it after it is resumed, one wake at a time. A paused run resumes
with `POST /runs/{id}/resume` and a paused routine with
`POST /automations/{id}/resume`; other work woken this way (a conversation an
assistant left watching, say) asks the person instead, and goes on when they
answer. An attempt that is held this way, or at a limit, reads none of what
woke it, so the next one does.

## Operator alerts on spending

Two spending checks join the operator's health alerts when set (see
[Alerts](DEPLOYMENT.md#alerts)):

| Setting | Alerts when |
| --- | --- |
| `MELETE_ALERT_SPEND_HOURLY_MULTIPLE` | the last hour's model calls cost more than this many times the installation's usual hour (the median hour of the week before) |
| `MELETE_ALERT_SPEND_PERSON_PERCENT` | one person accounts for more than this percent of today's spending while others spend too |
| `MELETE_ALERT_SPEND_MIN_USD` | neither alert fires below this many dollars (default `1`) |

## Evidence

`apps/melete/test/integration/background.test.ts`:

- "background and interactive are counted apart and the rollup matches to the
  micro-dollar": a person's message, a watch and a timer wake three attempts
  with the right classes and trigger; their calls, a search, a voice aside and
  memory reads are recorded with their class, step and charged input; the
  day's rollup matches `model_usage` to the micro-dollar, line by line, and
  writing it again replaces it.
- "a person's own message always still runs at the background limit".
- "calls admitted side by side are judged one after another, as if made in
  turn".
- "rollups of the same day at once all finish, and the day matches its
  calls".
- "a job's model calls count against its dollar limit when the operator turns
  that on".
- "the operator is alerted when an hour runs far above the usual, or one
  person dominates the day".
- "GET /usage reports the background part, by purpose and tier, the last 30
  days, and the owner sees cost per person-day".

`apps/melete/test/integration/wake-guard.test.ts`:

- "a run woken thirty times an hour with nothing to show is paused and the
  person told once";
- "one wake with a finding starts the count again; notes and reads alone do
  not";
- "wakes that ran no model are not counted";
- "mail that arrives while a watch is paused reaches it once it is resumed";
- "wakes refused at the background limit are not counted; the work rests
  until the limit resets and the person is told the limit";
- "a later wake in a conversation the person spoke in is background, and is
  stopped at thirty";
- "a routine's test run is the person's, and its scheduled runs are
  background".

`apps/melete/test/integration/background-week.test.ts`: "the scripted week
prints background cost per active person-day from recorded calls".
