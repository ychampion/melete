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
