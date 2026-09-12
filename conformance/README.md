# Service conformance

The runner lists eight scenarios, then executes the tests in
`conformance/scenarios`. Scenarios 1–5 run anywhere with disposable Postgres;
6–8 run against the Compose stack when `MELETE_CONFORMANCE_COMPOSE=1` is set
and are reported as deferred otherwise. This page describes the tree at the
head of `integration`.

## Run

From the repository root:

```bash
bun run conformance
```

Install dependencies with the command in [README](../README.md) first. The
runner prints the catalog, then runs `bun test --max-concurrency=1
conformance/scenarios` with the repository's thirty-second per-test timeout.
The fixtures create isolated databases and use scripted/stub runtimes and test
effects. Without `DATABASE_URL`, they start disposable embedded Postgres 17.
With a URL, they create disposable databases on that server; the supplied user
needs database-creation permission. pg-boss uses those fixture databases.
Unavailable embedded binaries cause explicit skips, not proof of a pass.

Without the opt-in the command does not start a Compose stack, and no scenario
calls a real model. The scenario catalog states intended assertions; the
executable test bodies and reported pass/skip results determine evidence.

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

## Deployment scenarios (Compose opt-in)

These run against a disposable Compose installation on a Linux Docker host, as
the README describes, and restart shared services, so run them sequentially.
On 2026-09-12 the whole suite passed 44 tests and skipped one.

| Scenario | What runs | Named assertions |
| --- | --- | --- |
| 6: [no route out](scenarios/06-no-route-out.test.ts) | Python standard-library probes from a real claimed Hermes cell and the warm cell; ten tests | `Postgres is unreachable by DNS and its actual container IP`; `another job is absent from the mounted filesystem`; `only the broker/gateway peer is attached and both routes answer`; `non-root, read-only, no capabilities, no privilege escalation or Docker socket`; `the warm cell cannot reach owner setup, login or health`; `a claimed attempt cannot reach the owner control plane and retains its job boundary` |
| 7: [retraction](scenarios/07-retraction.test.ts) | Retract a knowledge record while a job is running, then restart the whole stack; four tests | `the record is absent from the FTS index, not merely filtered out of results`; `after a restart, retrieval still does not return it`; `the retraction and its reason remain readable in git` |
| 8: [model agnosticism](scenarios/08-model-agnostic.test.ts) | One scripted job through the stack with the fake provider; the same job against a real provider only when a key is present (skipped otherwise) | `the fake provider reaches approval and one receipt through the Compose stack`; `fake-provider approval binds the canonical payload hash`; `enforcement never depends on the model agreeing to be enforced` (a cell capability reads the catalog but cannot approve) |

The second-provider comparison in scenario 8 is the one skip: it has not run
without a configured credential, so policy equivalence across two real
providers is **not claimed**.

## Static configuration checks

```bash
bun run compose:check
```

This reads YAML and checks nineteen declarations. Its test `passes every boundary
check` and mutation tests exercise the checker, not a kernel/network boundary.
The label printed as “no route out” means the internal-network flag was found;
scenario 6 is what establishes live enforcement, on the host where it ran.

The [memory runner](memory/README.md) is a separate suite with a withheld-memory
arm.
