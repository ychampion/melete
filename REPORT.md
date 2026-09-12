# W11 learning loop

## Assumptions

- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: the DONE instruction selects `integration` as the PR base; it takes precedence over the later conflicting `main` example.
- Command `bun install`: completed with 372 packages; the existing devDependency `embedded-postgres@17.10.0-beta.17` satisfies the Postgres 17 requirement.
- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: shared `packages/contracts` remain frozen; additive learning schemas live in `apps/melete/src/learning/contracts.ts`.
- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: `procedure_candidate` is independent of W12's in-flight `repair_candidate`; their common state machines can be unified at integration.
- Command `git -C C:/Users/gamin/melete-oss-w11 status --short --branch`: clean `lane/w11-learning`, tracking `origin/integration` at launch.
- Log `2026-09-11 19:15 UTC`: campaign started; stop by `2026-09-12 00:15 UTC`.

## Slice 1 — episode capture

- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: read architecture, shared schemas, engineering notes, job/attempt lifecycle, memory restrictions, and embedded database fixtures before implementation.
- Command `bun run typecheck`: passed after the additive episode/schema integration.
- Test `learning-episodes.test.ts`, first run: 2 pass, 3 fail; `test timed out after 5000ms`, `ERR_INVALID_ARG_TYPE ... Date` in retention, and cleanup timeout. Fix cycle 1 uses ISO timestamps, the exact source-version field, the exact runtime version, and a bounded 15-second integration timeout.
- Test `learning-episodes.test.ts`, fix cycle 1: 3 pass, 1 timeout at Bun's chained rejection matcher; standalone diagnostic reached `after conflict`, `after stale`, `get queued`, `reclaimed`. Fix cycle 2 awaits rollback in an explicit try/catch, following the existing runner fixture pattern.
- Test `learning-episodes.test.ts`, fix cycle 2: 4 pass, 0 fail, 19 assertions; correction/receipt capture, completed episodes, scoped reads/deletion, and memory forget/retention passed.
- Commands `bun run typecheck`, `bun run lint`, `bun run compose:check`: passed; Compose reported 12 boundary checks.
- Command `bun run test`, first full run: 896 pass, 14 pre-existing todo, 9 fail, 772.95 seconds. Log `a beforeEach/afterEach hook timed out` at five seconds accounted for all failures in existing responsibility/runner tests; the four learning tests passed.
- Command `bun run test`, full-suite fix cycle 1: reuse the preload-owned Postgres server while preserving per-fixture databases/migrations; run every discovered test file in exactly two serial child processes with a bounded 10-second default timeout. Actual elapsed time remains a required measurement.
- Command `bun run test`, full-suite fix cycle 1 result: 906 pass, 14 pre-existing todo, 2 fail, 410.88 seconds; log `routine: unread results change visible attention without changing business state` and `a rejected persisted completion cannot starve another expired attempt during recovery` reported 10-second fixture hook timeouts.
- Command `bun run test`, final allowed fix cycle 2: raise the bounded hook allowance to 30 seconds; preserve two workers, all tests, per-fixture databases, and durable Postgres settings. The 180-second suite target remains unmet; balanced workers and measured test costs do not justify claiming otherwise.
- Log `2026-09-11 owner steering`: continue at xhigh effort, solo and sequentially; no further delegation. Command `git status --short --branch` confirmed no commits or staged changes from the interrupted command.
- Command `bun run test`, final allowed fix cycle 2 result: 907 pass, 14 pre-existing todo, 4 fail, 513.98 seconds. Three existing teardown hooks hit their explicit 15-second limits; the replies fault fixture reported `Fault child exited 143`. All four `learning episode capture` tests passed. The two-cycle stop condition ends further baseline timeout tuning; this slice is functional but not a green full-suite result.
- Test `procedureChange`: the next slice uses a finite audited grammar; draft generation tests remain outside discovery until their migration and runtime wiring are complete.

## Slice 2 — bounded candidate generation

- SHA `4b24d48`: episode capture committed separately with the full-suite failures retained above.
- Command `bun run db:generate`: generated `0016_outgoing_redwing.sql` for the one-call learning ledger and proposal reservation timestamp; no shared contract changes.
- Test `learning-proposals.test.ts`, first run: failed before reservation because the gateway requires a surrogate header; cleanup also reported `ERR_SERVER_NOT_RUNNING` after redundant connection cleanup. Fix cycle 1 supplies the existing surrogate protocol, sends only finite step identifiers within the gateway byte-based token reservation, and uses the gateway's existing close method.
- Command `bun test --max-concurrency=1 --timeout=30000 apps/melete/src/learning/procedure.test.ts apps/melete/test/integration/learning-proposals.test.ts packages/runtime-hermes/src/client.test.ts`: 31 pass, 0 fail, 94 assertions, 19.40 seconds after fix cycle 1.
- Test `one corrected episode produces one scoped candidate with no private prose`: verified one persisted gateway call, actual token/model settlement, idempotent replay, exact scope/model compatibility, and absence of planted secrets from both the request and candidate body.
- Test `Hermes skill creation refers only this current job owner intervention`: the existing current-attempt authorizer rejects a fenced attempt; another job cannot refer the intervention; arbitrary paths and skill bodies fail the request schema.
- Command `bun run test:plugin`: 21 pass in 11.20 seconds, including a real loopback HTTP handoff to `/tools/learning/propose` with unchanged live-skill fixture files.
- Test `skill_creation_goes_to_learning_without_writing_live_skills`: configuration keeps only the Melete toolset; the narrowly added plugin forwarder refers owner evidence and never publishes a skill. No Hermes source patch is required.
- Command `bun run typecheck`, first wiring run: one `Promise<boolean | void>` error from a logging callback; fix cycle 1 uses a void callback and the subsequent typecheck passed.
- Commands `bun run typecheck`, `bun run lint`, and `bun run compose:check`: passed after final candidate wiring; Compose reported 12 checks. The earlier full-suite timing/fixture failures remain open and are not represented as green.

## Updated assumptions from orchestration

- Log `2026-09-11 full-suite lock steering`: seven lanes share this laptop; every future full suite acquires `C:/Users/gamin/.melete-test.lock` atomically, waits in 15-second increments, and releases its own lock on success or failure. Focused checks require no lock.
- Command `bun run test`: the earlier unlocked timeout entries are contention observations, not confirmed failures; report a timeout as a failure only if it reproduces under the shared lock. The next full run will verify the completed changes under that lock.
- Log `2026-09-11 additive-contract steering`: new contract files, optional fields, and OpenAPI paths are permitted with regenerated OpenAPI/client types and a proposed-note record; only breaking changes require stopping. This supersedes the initial frozen-contract assumption above.
- SHA `9cfc5f4`: candidate generation committed and `git -C C:/Users/gamin/melete-oss-w11 push -u origin lane/w11-learning` published both completed slices; no merge or force push.

## Slice 3 implementation and defensive checks

- Command `bun run openapi` and `bun run client:generate`: regenerated additive learning schemas, optional atomic job learning scope, and the twelve episode/procedure API paths under the updated contract authorization.
- Test `held-out procedure gate`: validation precedes sealed final selection, family gains cannot compensate for template regression, and critical-family, scope, time, template, and space violations reject promotion.
- Test `the candidate and gate schemas refuse all six forbidden targets`: strict data-only input refuses authorizer, credential, space boundary, operation identity, grader, and sealed-task edit targets.
- Command `bun test --max-concurrency=1 --timeout=30000 apps/melete/src/learning/gate.test.ts apps/melete/test/integration/learning-evaluation.test.ts`, first run: 6 pass and 3 fail in 33.42 seconds; repeated Bun bundling failed after the first successful gate process and one test expected the wrong error code. Fix cycle 1 caches the immutable trusted bundle and corrects that expectation; rerun is in progress.
- Test `the same process boundary denies opening every forbidden target for writing`: the rerun uses verified existing source paths and append-only open probes; all six return `ERR_ACCESS_DENIED` with `FileSystemWrite` under the same Node permission flags as the promoter.
- Command `bun run typecheck`, first slice-3 run: four unknown-JSON typing errors; fix cycle 1 parses usage and constraints through their existing contract schemas before use. Rerun is in progress.
- Command `bun test --max-concurrency=1 --timeout=30000 apps/melete/src/learning/gate.test.ts apps/melete/test/integration/learning-evaluation.test.ts`, fix cycle 2: 9 pass, 0 fail, 65 assertions in 53.42 seconds. Cycle 1 had only a history-prefix assertion mismatch; the gate had correctly rejected the harmful template.
- Test `validation selects before final; one-space canary and one-call rollback fence delivery`: actual scripted jobs pass both held-out phases; mutation after selection is denied; another space receives no skill; one-call rollback removes subsequent delivery.
- Test `text sorting improves two templates but harms numeric ordering and is kept as rejected history`: validation rejects despite a positive family average, keeps the failed evaluation and transition history, and never opens the sealed final phase.
- Commands `bun run typecheck`, `bun run lint`, and `bun run compose:check`: passed for slice 3; lint checked 339 files and Compose checked 12 isolation properties. A full run under the shared lock follows before pushing this slice.

## First full run under the shared lock

- SHA `2a56dc5`: held-out evaluation and promotion committed; full-suite source stayed unchanged while its locked snapshot ran.
- Command `until mkdir C:/Users/gamin/.melete-test.lock 2>/dev/null; do sleep 15; done`: acquired the lock at approximately 20:55:56 UTC; the EXIT trap released it after the run. A later lock has another lane's creation time and is not ours to remove.
- Command `bun run test`, first locked run: 920 pass, 14 existing todo, 1 fail, 3907 assertions, 315.81 seconds across 78 files and two workers. No fixture timeout reproduced under the lock.
- Test `service startup binds the W2 internal port and runs pg-boss against the fixture`: expected HTTP 200 from the standalone broker catalog but received 500 because that fixture intentionally has no learning tables. Locked fix cycle 1 detects the additive schema before attaching the learning handoff; the existing broker path remains available without learning.
- Command `bun run test`: the locked duration of 315.81 seconds exceeds the requested 180-second target. This timing requirement remains open; no test was removed, skipped, or weakened to disguise it.

## Slice 4 — three acts and final compatibility checks

- Test `completed job, owner correction, then a different job succeeds with fewer interventions and no private details`: the original job completes, the owner correction creates one idempotently linked corrective job, that job completes correctly, the durable drain generates a scoped candidate, held-out validation/final pass, and a later table succeeds with one intervention reduced to zero.
- Test `completed job, owner correction, then a different job succeeds with fewer interventions and no private details`: the original terminal state remains intact, the corrective job retains the original completion requirements with `max_actions: 0`, and the later bundle and proposer request omit `PLANTED-PRIVATE-THREE-ACT-482`.
- Command `bun run db:generate`: generated `0018_calm_forgotten_one.sql` for the additive corrective-job link; the shared episode response already permits this optional field.
- Command `bun test --max-concurrency=1 --timeout=30000` on gateway, learning episodes, proposals, and three-act tests, initial run: 11 pass and 2 fail. The failures exposed array serialization in catalog-version capture and an unnecessarily strengthened follow-up completion requirement.
- Test `completed job, owner correction`, fix cycle 1: passed in the focused diagnostic after retaining the original completion requirements. Test `Hermes skill creation` exposed `ERR_INVALID_ARG_TYPE ... Received an instance of Array`; fix cycle 2 serializes the captured version list explicitly before the JSONB update.
- Command `bun test --max-concurrency=1 --timeout=30000` on the four affected integration files, fix cycle 2: 13 pass, 0 fail, 119 assertions in 75.60 seconds. The standalone broker, exact-one episode capture, model privacy boundary, actual HTTP catalog versions, complete three-act scenario, activation, and rollback all pass.
- Command `bun run typecheck`: first slice-4 run found a test lookup using `bundle.job.id`; fix cycle 1 uses the existing `bundle.attempt.job_id` contract, and the full typecheck passed.
- Commands `bun run lint`, `bun run compose:check`, and `git -C C:/Users/gamin/melete-oss-w11 diff --check`: passed; lint checked 340 files and Compose checked 12 properties.
- Command `discoverTests/partitionTests` verification: 79 files assigned exactly once to two workers; all four learning integration files share one serial worker to avoid racing the fixed conformance ports. Scheduling weights now include the measured evaluation cost.

## Final audit while the full suite waits

- Command `bun run test`, second locked invocation at 21:30 UTC: still waiting for atomic ownership of `C:/Users/gamin/.melete-test.lock`; no test timeout is inferred from time spent in that queue. The source snapshot remains unchanged.
- Test `a cleared job cannot recreate evidence on a later completion or correction`: prepared after review found that completion capture does not recheck removed input evidence. It will be run after the queued source snapshot finishes.
- Test `forgetting waits for a completing job and erases the episode committed during that wait`: prepared to verify the ordering between job completion and the existing memory removal transaction; no pass is claimed before execution.
- Command `Test-Path .agents/w11-locked-suite2.log`: confirmed the full suite had not started both before and after applying the prepared deletion fix at 21:40 UTC. The queued invocation will cover this final source instead of requiring another full queue afterward.
- Test `a cleared job cannot recreate evidence on a later completion or correction`: completion now rechecks live references and whole-space clear/revoke state; an old job can finish operationally without recreating learning evidence. A new job created after a clear remains eligible.
- Test `forgetting waits for a completing job and erases the episode committed during that wait`: memory removal now collects episodes after job invalidation has waited for active job transactions, and whole-space removal uses the original job time. This avoids adding an inverted space/job lock order.
- Commands `bun run lint`, `bun run compose:check`, and `git -C C:/Users/gamin/melete-oss-w11 diff --check`: passed after the deletion changes; lint checked 340 files and Compose checked 12 properties. The new regressions are pending the queued full suite.
- Test `a partially forgotten source handle cannot become fresh learning evidence`: source-handle admission now checks suppression records as well as source state, because a source with a removed fragment can still be active. The queued suite includes a replayed partial restriction followed by denied admission and a late completion.
- Command `bun run typecheck`: passed after the late-completion and transaction-race changes; the subsequent partial-source extension also passed lint and is being typechecked before the queued run begins.
- Command `bun run typecheck`: the partial-source extension exited 0 before the full run; its lint and whitespace checks also passed.
- Command `bun run test`, second locked run: acquired the shared slot at 21:51:44 UTC and started all 79 files in two serial processes. The source was frozen when the log was created.
- Tests `a cleared job cannot recreate evidence`, `forgetting waits for a completing job`, and `a partially forgotten source handle`: passed in 375 ms, 328 ms, and 218 ms respectively during the locked run. The final suite result is still pending.
- Tests `validation selects before final`, `text sorting improves two templates but harms numeric ordering`, and `completed job, owner correction, then a different job succeeds`: passed during the locked run in 13.375 s, 3.984 s, and 11.266 s respectively.
- Test `delivered memory handles are captured and forgetting their claim removes the episode`: prepared after review found declared handles were captured but delivered memory context derivations were not. Its patch was deferred because the full suite had already started; no running source was changed.

## Second locked full-suite result

- Command `bun run test`: 925 pass, 14 existing todo, 0 fail across all 79 files and exactly two workers; total duration 320.73 seconds. The broker compatibility fix, complete learning loop, and three deletion regressions passed together.
- Command `bun run test`: the 180-second duration requirement remains unmet under the shared lock. Both earlier scheduling/fixture tuning cycles and the measured locked rerun are recorded; no further test weakening or unrelated baseline tuning is attempted.
- Command `until mkdir C:/Users/gamin/.melete-test.lock 2>/dev/null; do sleep 15; done`: the successful run released its own lock through its EXIT trap before the focused delivered-context regression began.

## Delivered memory evidence follow-up

- Command `bun test --max-concurrency=1 --timeout=30000 apps/melete/test/integration/learning-episodes.test.ts`: the added regression reproduced the missing dependency with 7 pass, 1 fail, 32 assertions, 45.52 seconds; log `Expected to contain: k_...@1; Received: []` at the episode input-handle assertion.
- Test `delivered memory handles are captured and forgetting their claim removes the episode`, fix cycle 1: capture now unions declared handles with exact claim/source versions from delivered context derivations, including the linked correction's evidence. Live-reference checks use that same union; no private context text is copied.
- Commands `bun run lint` and `git -C C:/Users/gamin/melete-oss-w11 diff --check`: passed after the delivered-context change; the four learning integration files and typecheck are running before the final full-suite invocation.
- Command `bun test --max-concurrency=1 --timeout=30000` on the four learning integration files, delivered-context fix cycle 1: 16 pass, 0 fail, 126 assertions in 86.81 seconds. This includes exact delivered memory handles, claim forgetting, all earlier deletion guards, held-out promotion, negative transfer, the three-act scenario, activation, and rollback.
- Command `bun run typecheck`: passed after the delivered-context fix. The final full-suite invocation will acquire the shared lock and verify this exact functional source before publication.

## Final verification queue

- Command `bun run test`, final invocation at 2026-09-11 22:25:03 UTC: still awaiting the shared lock. The final source remains unchanged since the 16-test learning run, typecheck, lint, and whitespace checks passed; the queue wait is excluded from suite-duration claims.
- Command `git -C C:/Users/gamin/melete-oss-w11 diff 9484023cabd32b786cb4d336dec818f441cd0cc1 --unified=0` plus the two documentation drafts: new public text passed the brief's vocabulary check before publication.
- Test `an opaque source version can complete its job without creating unrepresentable learning evidence`: added while the final suite was still queued. The frozen memory ledger accepts opaque versions that its handle grammar cannot represent; learning now returns `evidence_unavailable` for that evidence, which completion capture handles without aborting the operational job.
- Command `Test-Path .agents/w11-locked-suite3.log`: confirmed the final suite had not started before and after the opaque-version compatibility change. Its new regression is included in that queued run; lint and whitespace checks passed afterward.
- Command `bun run typecheck`: passed after the opaque-version guard.
- Command `Get-CimInstance Win32_Process`: confirmed an active test process still held the shared slot. Only W11's verified waiting Bash process was stopped for the targeted compatibility check; the shared lock and other processes were left intact.
- Command `bun test --max-concurrency=1 --timeout=30000 -t 'an opaque source version' apps/melete/test/integration/learning-episodes.test.ts`: 1 pass, 8 filtered out, 0 fail, 3 assertions in 11.65 seconds. This was a focused check, not a full-suite result; W11 then rejoined the shared queue for final source verification.

## Final locked source verification

- Command `bun run test`: acquired the shared lock at 2026-09-11 23:08:03 UTC and passed the final unchanged source with 927 pass, 14 pre-existing todo, 0 fail, and 3,958 assertions across all 79 files in exactly two serial workers. The measured full-suite duration was 119.85 seconds, meeting the 180-second target; queue time is excluded.
- Log `Test process 1 exited with 0`: 513 pass, 10 todo, 0 fail across 51 files in 119.73 seconds. Log `Test process 2 exited with 0`: 414 pass, 4 todo, 0 fail across 28 files in 112.28 seconds.
- Test `completed job, owner correction, then a different job succeeds with fewer interventions and no private details`: passed in 5.968 seconds in the final full run. Test `text sorting improves two templates but harms numeric ordering and is kept as rejected history`: passed in 2.140 seconds; the negative-transfer candidate never reached the sealed final phase or delivery.
- Test `validation selects before final; one-space canary and one-call rollback fence delivery`: passed in 8.047 seconds. All nine episode tests passed, including delayed completion after forgetting, concurrent removal, partial source suppression, delivered-context references, and opaque source-version compatibility.
- Commands `bun run typecheck`, `bun run lint`, `bun run compose:check`, and `git -C C:/Users/gamin/melete-oss-w11 diff --cached --check`: passed for the final source; lint checked 340 files and Compose checked 12 properties. Command `bun run test:plugin` passed all 21 tests; its source has not changed since that run.
- Command `bun run test`: the successful EXIT trap released W11's shared lock; a subsequently created lock belongs to another lane. Earlier duration and unlocked contention observations remain above as history; the final measured run is green and under three minutes.

## Final result

- SHA `b9523fc`: the final functional commit contains the completed-job correction flow, three-act transfer scenario, broker compatibility fix, and learning deletion guards; command `git -C C:/Users/gamin/melete-oss-w11 push -u origin lane/w11-learning` published it successfully.
- Command `bun run test`: final acceptance evidence is 927 pass, 14 pre-existing todo, 0 fail, 3,958 assertions, and 119.85 seconds under the shared lock. The scripted three-act and negative-transfer integration tests pass; typecheck, lint, plugin tests, generated-contract checks, and static Compose checks also pass as recorded above.
- Test `learning-three-act.test.ts`: the implemented reusable procedure target is the audited short skill for `organize-records/table-editor/1.0/owner/private`. Other task families, browser recipes, connector repairs, and tool wrappers need independently reviewed evaluator support before they can be enabled.
- Command `bun run compose:check`: static configuration checks pass; container execution was unavailable because this Windows environment has no Docker. Command `bun run test:plugin` verifies the local plugin with a fake HTTP broker; all model calls in lane tests use scripted providers, and no real-provider smoke step was specified.
- Log `docs/LEARNING.md` and `.agents/notes/0019-learning-loop.md`: document captured evidence, bounded generation, trusted evaluation, rejection history, one-space canary, activation, rollback, retention, and the separation from memory and authority. Log `proposed/2026-09-12-w11-contract-additions.md` records the authorized additive API changes; W12's separate candidate table can be unified at integration.
- Command `gh pr create --repo ychampion/melete --base integration --head lane/w11-learning --body-file`: final publication targets the DONE branch `integration` with this append-only report. No merge or force push is part of the lane.

## Review results — 2026-09-12

- Finding 1; command `bun test --max-concurrency=1 --timeout=30000 -t 'selected validation cannot enable' apps/melete/test/integration/learning-evaluation.test.ts`: reviewer mutation exit 1, 0 pass / 1 fail / 3 filtered, 44.13 s; all four corrupted final cases improperly enabled. Restored guard exit 0, 1 pass / 0 fail / 3 filtered, 51.43 s; missing, failed, differently bound, and older final evidence each return `promotion_denied`; valid restored evidence enables canary. `docs/LEARNING.md` cites the falsifier.
