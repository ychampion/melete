# The memory conformance runner

Melete claims its memory does specific things: a correction sticks, an older
email that arrives late does not win, a forgotten fact stays forgotten across a
restore, and irrelevant preferences do not turn into personalisation. This
directory is where those claims are checked instead of asserted. It is the
scenario half of [E6 in docs/ENGINEERING.md](../../docs/ENGINEERING.md), and the
behaviour it exercises is described in [docs/MEMORY.md](../../docs/MEMORY.md).

## Running it

```bash
bun install
bun run conformance:memory
```

With no `DATABASE_URL` the runner starts a disposable Postgres 17 of its own on
port 3126 and a scripted model on port 3124, and removes both when it finishes.
With `DATABASE_URL` set it creates a separate disposable database on that
server, so it never migrates or touches the database you gave it; the configured
user therefore needs permission to create a database.

Nothing leaves the machine and nothing is paid for. The extractor and the
assistant that answers questions are both scripted, both deterministic, and both
reached over real HTTP, so the service is doing exactly what it does in
production apart from which model answers.

It takes a few seconds after Postgres starts. If the embedded Postgres binary
cannot be downloaded, the runner prints the usual skip line and says plainly
that a skip is not evidence that anything passed.

```bash
bun test conformance/memory/breaks.test.ts   # the suite's own falsifier
```

That test turns three memory rules off on purpose and asserts the scenarios
resting on them go red, then turns them back on. It exists because a suite
nobody has watched fail is a suite nobody has a reason to believe.

## What the columns mean

```
family                  passed  todo  obsolete  unsupported  question  correction ms  recall p50  recall p95
```

| Column | What it counts |
|---|---|
| `passed` | Scenarios in the family whose every check held, over the scenarios that ran |
| `todo` | Scenarios listed with their assertion and not executed, because the behaviour is a roadmap item |
| `obsolete` | Answers equal to a value memory had already superseded, and that the head or the owner's latest correction contradicts |
| `unsupported` | Answers with no handle, or citing a handle recall did not deliver |
| `question` | Questions asked where the scenario says the delivered evidence was enough to answer |
| `correction ms` | The longest gap in the family between an owner correction committing and recall serving it |
| `recall p50` / `recall p95` | Milliseconds per `recall` call in that family |

The same figures, plus every check and every failure, land in `report.json`
next to this file.

Three of those columns should be zero, and a non-zero one is a finding rather
than a rounding error: an obsolete fact means a correction did not take, an
unsupported claim means something was produced that memory cannot account for,
and a needless question means memory had the answer and did not serve it.

## The counterfactual arm

Every scenario declares `memory_required`. Each one that does is run a second
time with recall replaced by an injected function that reports `complete` with
zero items. A scenario that still passes without memory is not evidence about
memory, so it fails the suite with `memory not exercised` rather than
contributing a green row. This is the fourth arm E6 asks for, and it is the
reason the table can be read as a claim about memory at all.

## Adding a scenario

Write one JSON file under `scenarios/<family>/<id>.json`. The schema is
[`schema.ts`](schema.ts), and the runner refuses a file that does not match it,
naming the field.

```json
{
  "id": "my-scenario",
  "family": "corrections-and-time",
  "title": "One line a reader can check the run against",
  "narrative": "The perturbation, and what success looks like from outside.",
  "memory_required": true,
  "steps": [
    {
      "step": "say",
      "name": "first",
      "event_time": "2026-06-01T09:00:00Z",
      "text": "Our trip is on 10 July 2026.",
      "claim": { "key": "event.trip.date", "content": "10 July 2026" }
    },
    {
      "step": "ask",
      "name": "check",
      "query": "trip date",
      "key": "event.trip.date",
      "expect": { "kind": "answer", "content": "10 July 2026" }
    }
  ]
}
```

The steps, and what each one actually does to the service:

| Step | What happens |
|---|---|
| `say` | The owner's own message is ingested, and extraction runs over it |
| `import` | A document, message or assistant transcript arrives with its own `event_time` and `source_type` |
| `observe` | A structured connector observation; Tier 0 reads it and no model is called |
| `correct` | An explicit owner correction on a key, which also measures correction-to-serving latency |
| `forget` | `POST /memory/forget` for one claim, or for the whole space |
| `revoke` | One imported source is revoked, and its claims leave retrieval with it |
| `snapshot` | A named database snapshot, taken separately from the retained restriction journal |
| `kill_at` | A real process is killed at one of the named write-protocol boundaries, then resumed |
| `restore_from` | A named snapshot is restored, and the journal replays before serving resumes |
| `ask` | A real `recall`, then the scripted assistant answering from what it delivered |
| `expect_question` | How many owner questions should be queued at that point, in total |
| `expect_no_effect_duplicate` | Replaying the last input is a duplicate, the key keeps one head, and its support does not inflate |

A `claim` on an evidence step is what the scripted extractor will propose: the
registry key, the value, and optionally the exact `quote` it rests on. Two
fields are there to write scenarios about the service refusing something:
`cite: "previous_source"` makes the extractor cite the message before this one,
which is the "attach it to a convenient nearby message" failure, and
`expect_rejected: true` says the service must refuse the proposal with a durable
reason and leave the key where it was.

Two rules make a scenario worth adding:

- **Give it at least one positive expectation.** A scenario made only of
  `absent` expectations passes with memory withheld, and the counterfactual arm
  will fail the suite for it.
- **Use a key from the registry.** The registry is in
  `packages/contracts/src/memory.ts` and grows by a reviewed commit, so a key
  outside it is rejected with a reason, which is usually not the thing you were
  trying to test.

## The families

The eight come from the memory experiment plan, and every one of them has at
least one scenario.

| Family | What its scenarios perturb |
|---|---|
| `stable-personalization` | A stated format and a stated day, reused on a recurring task |
| `corrections-and-time` | July to August, a one-trip exception, an older July email arriving late, and two owner statements that disagree |
| `continuing-work` | A process killed mid-extraction, with a new constraint arriving before the resume |
| `relationships` | Two people with the same first name, their constraints joined, and a second space kept out |
| `source-authority` | A page's address, a paraphrase of it, an owner dispute, and a citation that points at the wrong evidence |
| `forgetting-and-access` | Forget, restore from an older snapshot, and revoke a source |
| `low-value-memory` | Eight irrelevant preferences and four copies of one document |
| `procedure-transfer` | Marked `todo`: promotion of a repeated workflow is a roadmap item, and the assertion is written for the day it lands |

## Test seams

The three deliberate breaks go through
[`apps/melete/src/memory/seams.ts`](../../apps/melete/src/memory/seams.ts).
Every field there is undefined in production and the guarded branch is never
taken. Nothing in a request body, a model response, a queue payload or a
database row can set one: only a direct in-process call from a test can, and the
breaks test resets them immediately afterwards.
