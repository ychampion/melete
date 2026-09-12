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
| 1b | #16 | `fix/production-review-astra-20260912` again, head `ddf1d97` | `f91f962`, fixture fix `89bee15` | None | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 38 pass / 210 assertions / 0 fail |
| 3b | #11 | `lane/w10a-execution` again, head `8231cc7` | `b3a3ed9` | None | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 15 pass / 103 assertions / 0 fail |
| 4 | #14 | `lane/w9-product`, head `c854caf` | `9249ce9` | `0015_reactions_and_style` to 0018; `0016_watch_triggers` to 0019 | Typecheck, lint, clean regeneration; plugin 45; Compose 12; focused 326 pass / 1 skip / 1321 assertions / 0 fail |
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

Checkpoint 1 (after step 4, head `e956aa0`): full Bun suite under the shared lock, `bun test --max-concurrency=1 --timeout=20000`: 1154 passed, 1 skipped (key-gated), 14 existing todos, 0 failures across 97 files in 264.36 s. Checkpoints 2 (after step 7) and 3 (after step 12): not reached yet.

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

## Continuation (second integrator)

The worktree was found mid-merge of `origin/lane/w9-product` (head `c854caf`) with 18 unmerged paths and no record of which staged resolutions were deliberate. That merge was aborted and redone from the same head; nothing committed was discarded. Before redoing it, the branches of PR 16 and PR 11 were merged again because both had gained commits since the first trial. PR 12's head (`afc3d1e`) had not moved.

## PR 16 again: production review fixes

Source head: `ddf1d97da00f4d4f39643c5bf7dbea56e747b62e` (four commits after `9725927`). Merge commit `f91f962`. One conflict, `apps/melete/test/helpers/postgres.ts`: the lane switched the fixture to the production `migrateDatabase` loader, while landing already carried the execution lane's journal loader with an optional `migrationsFolder` override for migration-loader tests. Resolved to call `migrateDatabase(handle)` by default and the drizzle migrator only when a test supplies its own folder, so production and fixtures share one loader and the loader tests keep their alternate journal. No literal migration filenames remain.

The lane's new `apps/melete/src/broker/service.test.ts` built an `Action` without the typed repair fields that PR 12 added to the contract, so typecheck failed after the merge. Follow-up commit `89bee15` adds `repair_trace`, `repair_counters`, `repair_disposition` and `retry_after_at` to that fixture; the assertion is unchanged.

Checks: typecheck; lint 333 files; OpenAPI and client regeneration unchanged; plugin 43 passed; Compose 12 checks; focused `broker-service-contract`, `broker`, `postgres`, `service.test.ts`: 38 passed, 210 assertions, 0 failures (31.95 s).

## PR 11 again: execution settlement lock removal

Source head: `8231cc742b52a714c0365180548e20966ae2248a` (two commits after `ffc1c51`). Merge commit `b3a3ed9`. One conflict in `apps/melete/src/broker/service.ts` at `settleExecution`: both sides had already replaced `lockJob(this.sql, ...)` with a plain job read; the lane folds the missing-job case into the existing `action_not_found` guard, landing had a separate `stale_epoch` throw. Took the lane's guard (its test expects `action_not_found`) with a merged comment. No non-transactional `lockJob` calls remain.

Checks: typecheck; lint; regeneration unchanged; plugin 43; Compose 12; focused `execution-admission` and `broker-service-contract`: 15 passed, 103 assertions, 0 failures.

## PR 14: product lane

Source head: `c854cafb9e59a2dad4c266dfb5d364a27c60d56d`, confirmed with GitHub. Merge commit `9249ce9`. Removed incoming `REPORT.md`. Eighteen conflicting paths:

- `.agents/notes/README.md` and the lane's note: the lane numbered its note 0015, which landing already uses for typed repair (0016 is execution). Renamed to `0017-agentic-and-natural.md`, updated its heading, and indexed it after 0015.
- `apps/melete/drizzle/meta/_journal.json`: kept landing's 15 to 17 and appended the lane's two migrations as `0018_reactions_and_style` (when 1789161120202) and `0019_watch_triggers` (when 1789161120203). The lane shipped no snapshots; wrote `0018_snapshot.json` and `0019_snapshot.json` as copies of 0017 with the added `memory_contexts.style_violations` and `trigger.last_observation` columns and a linear id chain. Earlier SQL and snapshots are byte-identical to their parent.
- `packages/contracts/src/artifacts.ts` (add/add): the execution lane's artifact validation module is the file; the product lane's two exports (`artifactReceiptDetail`, `artifactIdForAction`) were appended under a generated-artifacts section. Both lanes' callers import from `@melete/contracts`, so nothing else changed.
- `apps/melete/test/integration/artifacts.test.ts` (add/add): two unrelated suites. Execution's validation suite keeps the name; the product lane's authenticated artifact retrieval suite now lives at `generated-artifacts.test.ts`, unchanged inside.
- `apps/melete/src/broker/service.ts`: imports from both lanes kept; dropped the lane's unused `QUEUES` import (its pushed wake was superseded by PR 16's scheduling-class wakes, which auto-merged). The tool catalog now goes through the lane's `grantedToolCatalog`, and `connectors/catalog.ts` was extended to carry the execution lane's `execution` and `record_schema` fields on every connector tool so the cell still learns which tools it runs itself.
- `apps/melete/src/broker/http.ts`: the attempt-token POST allowlist now includes `/actions`, `/reactions`, and the execution start/settle routes.
- `apps/melete/src/broker/internal-server.ts`: both `recordArtifact` (execution) and `estimateSpend` (capabilities) are passed to the service.
- `apps/melete/src/connectors/configured.ts`, `connectors/types.ts`, `src/index.ts`, `jobs/runner.ts`, `packages/contracts/src/{entities,index,openapi}.ts`: additive on both sides; kept both (generation, exec, and artifacts providers; `capability` beside `prepare`/`validateBinding`; reactions mounted beside repairs; `loadCatalog` beside `artifactRoots`).
- `packages/runtime-hermes/melete_plugin/broker.py` and `tests/test_plugin.py`: kept execution's `start_execution`/`settle_execution` and the lane's `react`, and both test groups. The lane's react test asserted a dict, but the merged plugin returns JSON text from registered handlers (pinned Hermes registry, PR 11); the test now decodes the string before the same assertion.
- `packages/contracts/openapi.json` and `packages/client/src/schema.d.ts`: regenerated from the merged sources, then regenerated again with no diff.

Other fixes the merge needed: `packages/runtime-hermes/scripts/e2e-exec.ts` (execution lane) builds an `AttemptBundle` and now supplies `since_last: EMPTY_SINCE_LAST` (the lane's delta-brief field is required); the `apps/melete/src/connectors/tts.test.ts` fixture gained the typed repair fields. `bun install` added the lane's `re2js` dependency. Public-copy scan: two hits in lane text were reworded so the scan stays empty ("a company name" became "an employer name" in a style sample; "accompanies" became "goes with" in a contract comment, since the scan pattern matches inside that word).

Checks: typecheck; lint 363 files; OpenAPI and client regenerated and stable; plugin 45 passed; Compose 12 checks; focused run of all 22 lane test files (with the renamed retrieval suite) plus `broker-service-contract`, `execution-admission`, `repair`, `attention`, `postgres`: 326 passed, 1 skipped (key-gated), 1321 assertions, 0 failures across 28 files (87.31 s).

