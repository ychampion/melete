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
