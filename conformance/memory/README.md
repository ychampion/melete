# Memory conformance

This runner calls real memory functions against isolated Postgres, with
scripted extraction and scripted answers over local HTTP. It runs the memory
service directly rather than the normal service entry point or a Compose stack.
Ten executable scenarios cover seven families; procedure promotion is covered by
the [learning](../../docs/LEARNING.md) tests instead of by this harness.

See [MEMORY](../../docs/MEMORY.md) for authority and integration scope and
[ENGINEERING](../../docs/ENGINEERING.md#e6-memory-scenarios-with-a-withheld-memory-arm)
for the evidence scope.

## Run

From the repository root:

```bash
bun install
bun run conformance:memory
bun test conformance/memory/breaks.test.ts
```

Without `DATABASE_URL`, the runner starts disposable Postgres 17 on port 3126
and a scripted HTTP provider on 3124, then closes both. The breaks test uses
3128 and 3129. With a URL, the fixture creates a separate database on that
server; the user needs database-creation permission. It leaves the database
named by the supplied URL alone. pg-boss connects to the disposable database.

Provider calls use the scripted fixture. Initial dependency and binary downloads
can require network access, and a configured remote database uses the network.

## Scenarios

Each row links to the scenario whose exact checks the harness executes.

| Family | Executable scenario IDs |
| --- | --- |
| Stable personalization | [recurring-plan-format](scenarios/stable-personalization/recurring-plan-format.json) |
| Corrections and time | [trip-july-to-august](scenarios/corrections-and-time/trip-july-to-august.json), [disputed-key-asks-once](scenarios/corrections-and-time/disputed-key-asks-once.json) |
| Continuing work | [interrupted-work-resumes](scenarios/continuing-work/interrupted-work-resumes.json) |
| Relationships | [two-anas-and-two-spaces](scenarios/relationships/two-anas-and-two-spaces.json) |
| Source authority | [document-paraphrase-dispute](scenarios/source-authority/document-paraphrase-dispute.json), [no-nearby-message-citation](scenarios/source-authority/no-nearby-message-citation.json) |
| Forgetting and access | [forget-survives-restore](scenarios/forgetting-and-access/forget-survives-restore.json), [revoked-source-leaves-retrieval](scenarios/forgetting-and-access/revoked-source-leaves-retrieval.json) |
| Low-value memory | [noise-does-not-crowd-out](scenarios/low-value-memory/noise-does-not-crowd-out.json) |
| Procedure transfer | [repeatable-workflow-promotion](scenarios/procedure-transfer/repeatable-workflow-promotion.json): a recorded todo; this harness leaves promotion to the learning tests |

These are small scripted fixtures, and they measure the service's memory
behaviour rather than a model's reasoning.

## What the harness does

[`harness.ts`](harness.ts) implements the steps defined in
[`schema.ts`](schema.ts):

| Step | Implemented operation |
| --- | --- |
| `say`, `import` | Call ingest and scripted extraction with source identity/time |
| `observe` | Ingest a structured observation and run Tier 0 |
| `correct` | Call the protected correction function and measure serving delay |
| `forget`, `revoke` | Call memory restriction functions directly |
| `snapshot`, `restore_from` | Capture/restore fixture memory tables and replay the independently retained restriction journal |
| `kill_at` | Kill a child process at a named write-protocol fault boundary |
| `ask` | Call recall and ask the scripted reader to answer from delivered items |
| `expect_question` | Count pending memory questions |
| `expect_no_effect_duplicate` | Check input replay, keyed heads and support counts |

A `claim` in a scenario supplies what the fake extractor proposes; it measures
the memory protocol, not extraction quality. Exact source-span rejection is
challenged by `no-nearby-message-citation`.

## Metrics and counterfactual

The runner writes `conformance/memory/report.json` and prints per-family rows.
The columns count passed/executed scenarios, todo cases, obsolete answers,
unsupported answers, needless questions, maximum correction-to-serving delay
and recall p50/p95. The latencies are these local fixtures' latencies.

Every non-todo scenario declaring `memory_required` runs again with recall
replaced by a complete result containing no items. If it still passes, the
runner reports `memory not exercised` and fails. An expected failure in that
withheld arm is evidence that the scenario needed memory, not an ordinary
test-suite failure.

Four tests in [breaks.test.ts](breaks.test.ts) check that the suite catches a
broken rule:

- `a late import that wins turns the corrections family red`.
- `accepting a nearby-message citation turns the source-authority family red`.
- `skipping the restriction replay turns the forgetting family red`.
- `every rule is back on`.

They inject one broken rule, check the scenario fails, reset it and check the
normal path again. These seams are in-process test hooks, not request options.

## Add a scenario

Add a JSON file under the appropriate family, using `schema.ts` and an existing
scenario as the complete example. Include at least one positive answer that
actually needs recall; absence-only checks may pass with memory withheld.
Use a supported registry key and exact source spans. Scenario loading validates
the schema, duplicate IDs and presence of every family.
