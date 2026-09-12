# Landing report

Trial integration on `landing` only. Source baseline: `9484023cabd32b786cb4d336dec818f441cd0cc1`. PR heads and branch names were verified through GitHub before merging. No PR was merged through GitHub.

## Assumptions

- The requested worktree already existed, clean on `landing` at `origin/integration`, so it was reused without modifying another checkout.
- Migrations are ordered by the production journal. Additional migrations in the current PR heads are preserved and assigned the next available index.
- This landing run uses one Bun test process at a time. After waiting for repeated independent runs to finish, focused tests use the brief's no-lock rule; other agents control their own processes. Full suites acquire the shared directory lock and remove only this run's marker and lock on exit.
- Test evidence is local and uses disposable fixtures. Optional credential-dependent or container proofs are reported separately from passing local checks.

## Merge ledger

| Order | PR | Branch | Merge commit | Migrations | Checks and result |
| --- | --- | --- | --- | --- | --- |
| 1 | #16 | `fix/production-review-astra-20260912` | `c25c265cd986217938ca99ab0ef43e114508ce49` | None | Typecheck, lint, clean regeneration; plugin 20; Compose 12; focused 35 pass, 202 assertions, 0 failures |
| 2 | #12 | `lane/w12-repair` | `f6906f8110c98b41bf5528a4903a6d287d4f5fd4` | `0015_typed_repair` unchanged | Static checks green; plugin 20; Compose 12; first focused 100 pass / 2 fail; affected rerun 37 pass / 305 assertions / 0 fail |
| 3 | #11 | `lane/w10a-execution` | `ccf1458b7ed1cde7c0a630ceee5f55a891f54c7e` | Artifact validation 0015 to 0016; content digest 0016 to 0017 | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 175 pass / 767 assertions / 0 fail |
| 4 | #14 | `lane/w9-product` | Not attempted | Pending | Not run |
| 5 | #15 | `lane/w10c-discovery` | Not attempted | Pending | Not run |
| 6 | #18 | `lane/w6-deploy` | Not attempted | None | Not run |
| 7 | #17 | `lane/w13a-docs` | Not attempted | None | Not run |
| 8 | #20 | `lane/w10b-browser` | Not attempted | Pending | Not run |
| 9 | #19 | `lane/w11-learning` | Not attempted | Pending | Not run |
| 10 | #13 | `lane/w14-capabilities` | Not attempted | Pending | Not run; real Hermes effect proof pending in draft |
| 11 | #21 | `lane/w15-wire` | Not attempted | Pending | Not run |
| 12 | #22 | `lane/w16a-experience` | Not attempted | Pending | Not run |

## PR 16: production review

Source head: `9725927e1b0d2ca26254aa3ff68be7952e3d4c8c`. No textual conflicts. Preserved the transaction-only job lock, shared event-order advisory lock, claimable scheduling-class-aware wakes, and pending approval projection.

Changed `apps/melete/test/helpers/postgres.ts` to apply `migrateDatabase` and the production journal before optional fixture migrations. The incoming fixture selected migrations by literal filenames, which violates the landing migration rule and would omit later lanes. No tests were removed. No migrations were added. No lane report was present.

Typecheck passed. Lint passed across 308 files. OpenAPI and client regeneration produced no changes. Python plugin: 20 passed. Compose: 12 checks passed. Focused database checks passed: 35 tests, 202 assertions, 0 failures across `broker-service-contract.test.ts`, `broker.test.ts`, and `postgres.test.ts` in 110.31 seconds, using `bun test --max-concurrency=1 --timeout=15000`.

## Full-suite checkpoints

After steps 4, 7, and 12: not reached.

## PR 12: typed repair

Source head: `afc3d1e06d2f1036eb26da3aceaea27ac90753bf`, re-confirmed with GitHub. Conflict: `apps/melete/test/helpers/postgres.ts` had overlapping journal-loader comments. Kept the lane's explanation and production `migrateDatabase` loader; no literal migration filenames remain in the loader. Removed incoming `REPORT.md`.

Migration `0015_typed_repair` already followed 0014. Journal index 15 and timestamp 1789152918161 are increasing; snapshot 0015 links to snapshot 0014. No renumbering was necessary. The broker merged automatically; checked that all `lockJob` calls use transactions and that PR 16's wake and approval projection changes survived.

The initial focused run passed 100 tests and failed 2, with 532 assertions across seven files (67.78 seconds). Repair escalation stores human explanations in `question.because`, while the public question projection requires evidence handles. Closing that question threw during PR 16's verification and late-receipt wake tests. Fixed `apps/melete/src/jobs/questions.ts` at the projection boundary: preserve the explanation in displayed text, retain valid handles, and otherwise cite the persisted question record. Stored repair evidence and every test were preserved.

Final affected rerun: 37 passed, 305 assertions, zero failures across `broker-service-contract.test.ts`, `repair.test.ts`, and `attention.test.ts` (71.61 seconds). The unchanged files passed in the first run: broker repair policy, calendar, files, and conformance scenarios 3 and 4. Both runs used `bun test --max-concurrency=1 --timeout=15000`.

After the fix: typecheck passed; lint checked 314 files; OpenAPI/client regeneration unchanged; plugin 20 passed; Compose 12 checks passed; public-copy scan empty. This is before the first full-suite checkpoint.

## PR 11: execution and artifact validation

Source head: `ffc1c510c1c29a056f7d4e7db8ee1cabf8ea0030`, confirmed with GitHub. Removed incoming `REPORT.md`. Resolved these conflicts:

- `apps/melete/src/broker/service.ts`: retained the repair due-time argument and added a separate cell-claim argument. Both the retry-time check and the cell-only dispatch guard run before dispatch. Kept one authority-check implementation and moved artifact/mailbox `validateBinding` into it, so initial dispatch and repair retries both validate current bound resources. Kept the repair driver and execution settlement functions, each once.
- The incoming `settleExecution` called `lockJob(this.sql, ...)`. Replaced it with an explicitly non-locking context read; late evidence remains allowed and `recordResult` performs the transaction-locked persistence and epoch handling. No nontransactional `lockJob` calls remain.
- `apps/melete/src/connectors/files.ts`: combined artifact expectation/validation imports with typed repair faults. Retained the write readback check and artifact validation over the written content.
- `apps/melete/src/connectors/types.ts`: retained both repair context types and the query type required for preparation and binding checks.
- `apps/melete/test/helpers/postgres.ts`: kept the execution lane's shared server and journal-driven migrator, including the alternate journal folder used by migration-loader tests. Preserved the repair lane's optional additional fixture SQL after the journal.
- `apps/melete/drizzle/meta/_journal.json` and `0015_snapshot.json`: retained applied 0015 repair state and appended execution's two current migrations. `0015_artifact_validation` becomes `0016_artifact_validation` at timestamp 1789152918162; `0016_artifact_content_digest` becomes `0017_artifact_content_digest` at timestamp 1789161120201. Rebuilt both cumulative snapshots with repair state retained and a linear previous-ID chain. Previously applied SQL and snapshots are byte-identical to their landing parent. Because the live execution PR has two migrations, later numbering shifts by one from the brief.

Typecheck passed; lint checked 332 files. OpenAPI/client output was regenerated after the merge, staged, then regenerated again with no changes. Plugin: 43 passed. Compose: 12 checks passed. Focused Bun: 175 passed, 767 assertions, zero failures across 13 files in 41.97 seconds (`--max-concurrency=1 --timeout=15000`): all ten changed Bun test files plus files, repair integration, and PR 16's broker/service regressions. This includes real journal ordering, cell admission, artifact hashes, mailbox binding, and late settlement checks. No tests were removed or weakened.
