# Learning from corrections

Melete keeps procedure knowledge separate from personal facts and permissions. A useful correction can produce a proposed way of working. That proposal is delivered to later jobs only after separate validation and final evaluations pass and the owner enables it in the original space.

The current implementation is deliberately narrow: it proposes a short skill for ordering typed table records while preserving their shape. The trusted evaluator supports task family `organize-records`, app `table-editor`, version `1.0`, role `owner`, and audience `private`. Other families remain captured evidence or unevaluated candidates. Browser recipes, connector repairs, and tool wrappers are future targets; their names do not grant an executable path today.

## Capture and privacy

An episode records the job segment, task family and template, input handles, an owner correction/demonstration/takeover, artifact references, action receipts, outcome judgement, and failure class. Input handles include declared inputs and the exact claim/source versions recorded by delivered memory contexts. It records the requested model, actual model when reported, runtime version, and hashes of delivered tool and skill versions. An unreported actual model stays null. It never retains model deliberation.

Register scope through the optional `learning` field when creating a job. Registration and the first queued wake commit together. `PUT /jobs/{id}/learning-scope` is also available before the first attempt; scope is immutable afterward.

```json
{
  "learning": {
    "scope": {
      "task_family": "organize-records",
      "app": "table-editor",
      "app_version": "1.0",
      "role": "owner",
      "audience": "private"
    },
    "template_id": "monthly-records",
    "input_refs": []
  }
}
```

Submit an intervention to `POST /jobs/{id}/interventions` with `kind`, `text`, and a stable `idempotency_key`. Repeating the same request returns the same episode; reusing the key for different content is rejected. An optional `signal` can be `typed_ordering`, `text_ordering`, or `preserve_structure`. Without one, a small deterministic classifier identifies an ordering correction when possible. A running attempt is fenced before corrected input is queued, so its older response cannot commit.

For a completed, failed, or cancelled job, the episode's `correctiveJobId` identifies a linked corrective job in the same space. The original terminal state stays intact. The follow-up retains the objective, scope, input handles, and completion requirements, with zero external actions available. Its completion updates the intervention episode with both attempts' evidence. A deliverable that requires another external effect cannot be silently satisfied by this corrective job.

Only the finite signal and an audited vocabulary reach the proposal model. The gateway receives no private intervention text, task content, input handles, receipts, artifact paths, or sealed tasks. Model output must choose allowed steps in a strict schema. Melete compiles those steps into fixed skill text, checks the 400-token estimate limit, and binds the body, scope, compatible models, change, and tests with one definition hash. Arbitrary prose, code, and paths fail admission.

The candidate keeps its source episode reference inside the origin space. Later jobs receive only the general skill body and procedure identifier. Exact space, family, app/version, owner/private audience, requested model, and runtime compatibility are checked again at every delivery. Public compartments, other spaces, and incompatible jobs receive no procedure. At most one matching procedure is delivered in this implementation.

`GET /episodes?space_id=...` lists accessible, unexpired evidence. `DELETE /episodes/{id}?space_id=...` erases its private fields and dependent candidates, evaluations, and transitions. Episodes expire after 30 days; a startup and minute-by-minute sweep applies retention. Existing memory removal/revocation and retained-journal replay also restrict matching episodes through their input handles, including whole-space removal. Restriction prevents future generation and delivery.

A late completion cannot recreate learning evidence from removed inputs or a job that predates a whole-space clear. Removal also catches an episode whose completion transaction was still in progress when the person requested forgetting. Newly created jobs after the clear can record fresh evidence.

If an opaque source version cannot be represented by the memory handle format, the operational job can still complete, but no learning episode is created from that evidence.

## Generation and Hermes

The durable proposal worker processes corrected, classified episodes. It reserves one gateway call per episode, with a 2,048-token request reservation and a maximum 512 output tokens. Failed or abandoned calls remain recorded and are not silently retried. `POST /episodes/{id}/propose` with `space_id` exposes the same idempotent operation.

Hermes is configured with only the Melete toolset in API-server mode. Its built-in skill creator and shell tools are therefore unavailable. The Melete plugin adds the narrow `learning.propose` handoff to the authenticated broker catalog only when this job has an owner intervention. The handoff accepts no body or path; it refers existing episode evidence to the worker. This is a configuration and plugin change, with no upstream Hermes patch and no direct live-skill directory write.

## Evaluation and promotion

Use `POST /procedures/{id}/evaluate` with `space_id`. The trusted evaluator runs actual jobs in fresh evaluation spaces with a baseline arm and a candidate arm. Validation uses different task templates, spaces, and later timestamps from the source episode. Selection is committed before the final fixture module is loaded. The final templates and spaces are separate again, and final execution must follow selection. Each definition receives one validation and, if selected, one final evaluation; failures remain qualified history.

The grader compares complete output structure and independently specified row order. Candidate output cannot declare its own success. Each phase has six job runs, a 49,152-token output reservation, two turns and zero external actions per job, and recorded usage, duration, requested models, runtime evidence, and output hashes. A failed phase retains its reservation. The evaluator also runs the unchanged memory conformance harness against source-authority and forgetting/access scenarios in a disposable database, with the existing withheld-memory falsifier where required. Those are regression guards for memory boundaries, not evidence that the procedure improves memory.

Promotion requires better results and fewer required corrections on the target family, no regression on any tested template, full passes in critical families, and zero scope violations. A better family average cannot hide negative transfer on one template. Validation success alone cannot enable a procedure: the test `selected validation cannot enable canary without passing final evidence bound to and after selection` in [learning-evaluation.test.ts](../apps/melete/test/integration/learning-evaluation.test.ts) rejects missing or failed final evidence, a different selection binding, and a final row older than selection. Changing any bound part of a selected definition invalidates its evidence.

The promoter runs trusted, bundled decision code in a separate Node process using `--permission`, read access only to that bundle, and no filesystem write or child-process grant. It receives bounded JSON and returns only a decision tied to the definition hash. It receives no database connection or credential environment. Strict schemas reject edits to the authorizer, credential service, space boundary, operation identity rules, grader, and sealed tasks. The permission test attempts write-capable opens on all six existing targets and requires `ERR_ACCESS_DENIED` / `FileSystemWrite`.

This process boundary confines trusted gate code; it does not execute arbitrary candidate JavaScript. The service alone performs the fixed database transition after checking evidence. Self-hosting requires Node 24.14 or another version with the tested permission interface, alongside Bun. The service image includes the pinned Node binary. Production `POST /procedures/{id}/evaluate` creates and drops disposable databases on the Postgres server configured by `DATABASE_URL`; that database role needs `CREATEDB` permission and ownership of the databases it creates. With no configured server, the embedded database is used when available. Existing databases are never used as conformance fixtures.

Each process permits one evaluation at a time. Across replicas sharing the same application database, a Postgres advisory transaction lock excludes simultaneous evaluations in the same space and returns `evaluation_busy` to the other caller. The lock spans validation, selection, final evaluation, and cleanup; commit or rollback releases it on success or failure. It holds one pool connection, so the pool needs at least one additional connection for evaluation work. The test `independent evaluators exclude the same space and release its lock after failure` uses separate connection pools to verify exclusion and release. Conformance HTTP listeners use ephemeral ports; the in-process flag alone is not the replica boundary.

## Inspect, reject, enable, and roll back

All endpoints use the existing owner authentication. Read a space's procedures with `GET /procedures?space_id=...` and inspect one with `GET /procedures/{id}?space_id=...`. Inspection includes transition actors/reasons and evaluation results and costs; raw final tasks and answers are not returned.

The lifecycle is `candidate → evaluated → enabled_canary → active → superseded | reverted`. Rejection is a recorded reason and transition in candidate/evaluated history, not another executable state.

1. To reject an unevaluated or evaluated candidate, call `POST /procedures/{id}/reject` with `space_id` and `reason`.
2. After both evaluation phases pass, call `POST /procedures/{id}/canary` with `space_id`. Delivery is limited to the origin space.
3. After a canary job completes without an intervention, call `POST /procedures/{id}/activate` with `space_id`. Activation stays in that space and supersedes older compatible procedures for the same scope.
4. To stop future delivery, call `POST /procedures/{id}/rollback` once with `space_id` and `reason`. It records `reverted`; repeating rollback is idempotent. Rollback does not restore the predecessor that activation marked `superseded`; that predecessor remains disabled. Returning to earlier behavior requires a new candidate to pass evaluation and canary. A running attempt already holding the general skill is not interrupted by rollback, but subsequent attempt claims cannot receive it.

Nothing in a procedure grants permissions, changes operation identity, unlocks credentials, or changes which sources a job may access. Facts and access rules continue through memory and the broker.

## Verify locally

Use scripted providers for the integration tests:

```sh
bun test --max-concurrency=1 --timeout=30000 apps/melete/src/learning/gate.test.ts apps/melete/test/integration/learning-evaluation.test.ts apps/melete/test/integration/learning-three-act.test.ts
bun run typecheck
bun run lint
bun run test:plugin
bun run compose:check
```

The three-act test completes a baseline job, accepts an owner correction through its linked follow-up, generates and evaluates a procedure, and completes a later table with a different template, column, row count, and values. Owner interventions fall from one to zero, while the planted private detail is absent from the later job context. The other tests verify negative transfer despite a higher family average, exact-definition binding, scope exclusion, rollback, and the promoter's write boundary. No real model improvement is claimed from scripted-provider results. Compose checks inspect configuration; running the containers requires a machine with Docker.
