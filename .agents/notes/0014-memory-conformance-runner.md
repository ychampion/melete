# 0014. Memory quality is a suite with a counterfactual arm, not a prose plan

Status: accepted
Date: 2026-09-12

## Problem

The memory experiment plan is eight families of behaviour written in prose, and
the only thing executing any of it was one integrated trip test. That test is
good and it is not a measurement: it proves a particular July-to-August sequence
works, and it says nothing about the other seven families. Memory quality is
exactly the kind of thing that degrades silently. Somebody tunes an extraction
prompt, a rule loosens, and nothing goes red because nothing was watching.

There is a second problem underneath, and it is the one that makes most memory
benchmarks worthless. A scenario can pass because memory served the right thing,
or it can pass because the question was answerable without memory at all. From
the outside those two look identical. A green suite that never needed memory is
worse than no suite, because it is evidence-shaped.

## Decision

`conformance/memory/` holds scenarios as JSON and a runner that executes them
against the real service.

**Scenarios are data.** `schema.ts` is a Zod DSL: `say`, `import`, `observe`,
`correct`, `forget`, `revoke`, `snapshot`, `kill_at`, `restore_from`, `ask`,
`expect_question`, `expect_no_effect_duplicate`. One JSON file per scenario
under `scenarios/<family>/`, at least one per family, each declaring
`memory_required`. Adding a case is writing a file. The runner refuses a file
that does not match the schema, naming the field.

**The service is real.** Evidence goes through `ingest`, extraction through
`runExtractionWork` with a gateway over real HTTP, corrections through
`correctClaim`, removals through `forgetMemory` and the retained restriction
journal, kills through W7's existing `killAt` at its named write-protocol
boundaries, and every question through a real `recall` on embedded Postgres. Two
things are scripted: the Tier-1 extractor, which builds its proposal from the
source id, version and segment bounds the service actually sent it, and the
assistant answering the question, which may use only the items recall delivered.

**The counterfactual arm decides whether the table means anything.** Every
`memory_required` scenario runs a second time with recall replaced by an
injected function returning `complete` with zero items. A scenario that still
passes is reported as `memory not exercised` and fails the suite. All ten of the
current ones fail without memory, which is the property we wanted and could not
otherwise have claimed.

**The metrics are the four E6 names plus latency.** Obsolete fact used,
unsupported claim, needless question, correction-to-serving latency, recall p50
and p95, printed per family and written to `report.json`. Obsolete fact used
counts an answer that matches a superseded revision and contradicts either the
head or the owner's latest correction; the second half of that disjunction is
what catches a service that has wrongly made the old value the head again.

**Three deliberate breaks prove the suite can go red.** `memory/seams.ts` holds
three test-only hooks, undefined in production and settable only by an
in-process call from a test: rewrite the precedence table's verdict, accept a
span that does not belong to the evidence, and skip the restriction replay on
restore. `breaks.test.ts` turns each on, asserts the scenarios resting on it
fail, and turns it back off.

## Alternatives

**Assert inside `bun test` instead of a JSON DSL.** Rejected: the point is that a
self-hoster can add a scenario for their own memory without writing TypeScript,
and that the eight families are legible as a list rather than buried in test
bodies.

**Score answers with a model judge.** Rejected for v0.1: it would make the suite
cost money, make it non-deterministic, and move the thing being measured from
"what did memory serve" to "what did two models agree about". The scripted
assistant is deliberately the most charitable reader possible, so every recorded
failure is a failure of what memory served.

**Skip the counterfactual arm and trust the scenarios.** Rejected: it is the
single cheapest check that separates a memory suite from a suite that happens to
mention memory, and it found nothing only because the scenarios were written
with it in mind.

**Reuse `runDerivedWork` for index catch-up.** Rejected after measuring: it
iterates every space with pending outbox work, and spaces accumulate across a
run, so the suite became quadratic. The runner calls `cleanupMemory` and
`runViewWork` for the space under test instead, which is the same code the
derived worker runs.

## Evidence

`bun run conformance:memory`, embedded Postgres 17 on port 3126, scripted model
on port 3124, bun 1.3.13, Windows:

```
family                  passed  todo  obsolete  unsupported  question  correction ms  recall p50  recall p95
----------------------  ------  ----  --------  -----------  --------  -------------  ----------  ----------
stable-personalization  1/1     -     0         0            0         -              2.41        2.63
corrections-and-time    2/2     -     0         0            0         25             2.96        3.65
continuing-work         1/1     -     0         0            0         -              4.71        15.19
relationships           1/1     -     0         0            0         -              3.03        4.32
source-authority        2/2     -     0         0            0         -              2.3         2.76
forgetting-and-access   2/2     -     0         0            0         -              4.12        9.67
low-value-memory        1/1     -     0         0            0         -              4.07        4.07
procedure-transfer      0/0     1     0         0            0         -              0           0

every family passed, and every one of them needed memory to.
```

Ten scenarios executed, one listed as todo, ten counterfactual runs, and all ten
of those failed: the first thing each one loses is the answer it was supposed to
give, for example `4. ask answers bulleted list: answered (no answer)`. Scenario
execution is roughly two seconds in total; the wall time is dominated by
starting the disposable cluster.

`bun test conformance/memory/breaks.test.ts`: 4 pass, 0 fail, 13.3 s. Each break
turns the scenario that rests on it red and the same scenario green again after
the rule is restored. The late-import break also drives `obsolete_fact_used`
above zero, which is what makes that column a measurement rather than a
decoration.

## Limits

The suite measures what memory served and what an honest reader could do with
it. It does not measure model reasoning quality, does not call a real provider,
and does not establish anything about scale: the largest scenario holds thirteen
claims. `procedure-transfer` is listed with its assertion and marked `todo`,
because candidate-procedure promotion is not enabled in v0.1 and
`docs/MEMORY.md` records why. Recall percentiles here are milliseconds against a
local cluster with a handful of rows, and are a regression signal rather than a
service level.
