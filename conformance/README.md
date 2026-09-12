# Service conformance

The runner lists eight scenarios, then executes the tests in
`conformance/scenarios`. At code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1`, scenarios 1–5 have executable
assertions; 6–8 are **written, not run** (`test.todo`).

## Run

From the repository root:

```bash
bun test --max-concurrency=2 --timeout=15000 conformance/scenarios
```

Install dependencies with the command in [README](../README.md) first.
The direct test command gives each test/fixture hook fifteen seconds. The catalog
script uses the shorter default timeout; fixture setup/cleanup can exceed it.
See the documentation lane's pull request (#17) for observed failures and retry results.
The fixtures create isolated databases and use scripted/stub runtimes and test
effects. Without `DATABASE_URL`, they start disposable embedded Postgres 17.
With a URL, they create disposable databases on that server; the supplied user
needs database-creation permission. pg-boss uses those fixture databases.
Unavailable embedded binaries cause explicit skips, not proof of a pass.

The command does not start a Compose stack or call a real model. The scenario
catalog includes intended assertions and some historical descriptions; the
executable test bodies and reported pass/skip/todo results determine evidence.

## Executable scenarios

| Scenario and file | What the tests exercise | Named assertion |
| --- | --- | --- |
| 1: [durable wakes](scenarios/01-durable-wakes.test.ts) | Rollback after a child-process transition fault, deliberately deleted wake, recovery scan and duplicate timers | `exactly one attempt is admitted for the duplicated timer` |
| 2: [lease fencing](scenarios/02-lease-fencing.test.ts) | Stalled stub, expired lease, replacement attempt and late receipt | `A cannot admit an action: the broker refuses it with stale_epoch` |
| 3: [unknown outcomes](scenarios/03-unknown-outcomes.test.ts) | Durable destination acceptance followed by lost acknowledgement, broker reconstruction and verification | `the action is never dispatched a second time, including after broker restart` |
| 4: [approval binding](scenarios/04-approval-binding.test.ts) | Changed payload/revision and cancellation while dispatch is in flight | `admission is rejected when the payload hash no longer matches the approval` |
| 5: [runtime death](scenarios/05-runtime-death.test.ts) | Child-process faults during streaming and after a completed tool result | `no action is duplicated: the completed tool call is not run twice` |

The fixture tests also check recorded receipts, recovery events and uncertainty
messages. An assertion mentioning UI text checks the returned message, not a
rendered browser. Host reboot, container recovery and live-provider equivalence
are **not claimed**.

Scenario 1 kills the child inside the transition transaction before enqueue;
the transaction rolls back. It separately deletes queued wakes to exercise
recovery. Its catalog narrative must not be read as proof that a transition
commits independently of enqueue. Scenario 5 also checks the stored text-delta
rows: the current runner persists them even though the contract helper labels
text deltas non-durable.

## Written, not run

| Scenario | Status and limit |
| --- | --- |
| 6: [no route out](scenarios/06-no-route-out.test.ts) | **Written, not run**: six empty todo bodies name internet, Postgres, metadata, sibling, broker and filesystem/UID probes. No inside-container probe has passed here. |
| 7: [retraction](scenarios/07-retraction.test.ts) | **Written, not run**: four todo assertions for retraction during a job and whole-stack restart. Separate memory and file-index tests do not turn this scenario green. |
| 8: [model agnosticism](scenarios/08-model-agnostic.test.ts) | **Written, not run**: four todo assertions comparing policy outcomes across two providers. Fake-provider tests do not prove this comparison. |

The runtime and Postgres share `internal` in the current Compose declaration.
Scenario 6's expectation that Postgres DNS fails is therefore inconsistent with
that topology. Exclusive broker reachability is **not claimed**.

## Static configuration checks

```bash
bun run compose:check
```

This reads YAML and checks twelve declarations. Its test `passes every boundary
check` and mutation tests exercise the checker, not a kernel/network boundary.
The label printed as “no route out” means the internal-network flag was found.
Live enforcement remains **written, not run**.

The [memory runner](memory/README.md) is a separate suite with a withheld-memory
arm. The documentation lane's pull request (#17) records command results and limitations.
