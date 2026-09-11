# W1 service delivery

## Assumptions

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: frozen contracts stay unchanged; stub `{"script":[...]}` is encoded in `job.constraints.notes`, whose contract permits a string.
- Test `lease fencing`: expired attempts keep contract outcome `fenced` and loss metadata; an internal lease status may name `lost` without adding a public outcome.
- Test `SSE replay`: persisted `notice` payloads identify `gap` and `receipt`; SSE may frame the gap as `event: gap` without changing the frozen event enum.
- Command `bun test`: use throwaway Postgres 17 databases, at most two concurrent tests, W1 API port 3100 and broker port 3102 when binding ports.
- Command `bun test`: all runtime tests use scripted fake outcomes; no slice requests a real-provider smoke call.

## Initial inspection

- Command `git -C C:/Users/gamin/melete-oss-w1 status --short --branch`: `lane/w1-service...origin/main`, clean before dependency installation.
- Command `bun install`: `126 packages installed [4.67s]`.
- Command `bun add --dev embedded-postgres@17`: no stable version matched; command `bun add --dev --exact embedded-postgres@17.10.0-beta.17` succeeded (`6 packages installed [9.13s]`).
- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: read `docs/ARCHITECTURE.md`, frozen contracts, `.agents/notes/`, service skeleton and conformance assertions 1, 2, 5.

## Slice 1: auth and spaces

- Test `single-owner authentication against Postgres`: setup uses an atomic singleton index, Argon2id password hashes, hashed persistent sessions, and one personal space; setup signs in, minimum password length 8, session expiry 30 days.
- Test `browser mutation gates`: rejects mismatched Origin and cross-site browser requests; script clients may omit Origin.
- Command `bun test apps/melete/test/integration/auth.test.ts`: `9 pass`, `0 fail`, `49 expect() calls`, `11.12s` before adding the migrated-database ping assertion.
- Command `bun run typecheck`: passed (`$ tsc -b`).
- Command `bun run lint`: passed (`Checked 78 files in 124ms. No fixes applied.`); `.omx` runtime state is excluded from source lint and Git.
- Command `bun test --dots`: `283 pass`, `36 todo`, `0 fail`, `908 expect() calls`, `Ran 319 tests across 24 files. [24.38s]`; this working-tree run also exercised the prepared job and runtime unit slices, whose commits follow separately.
- Test `illegal inputs from queued`: initial rejection-matcher loop timed out at 5 seconds; first fix split state cases, second fix used native await/catch after Postgres showed `ClientRead` with no blockers. Final focused run: `14 pass`, `0 fail`, `252 expect() calls`, `12.99s`.

## Slice 2: jobs and state transitions

- SHA `88b6dd4`: auth/space slice committed and pushed to `origin/lane/w1-service`.
- Test `every legal edge`: persisted transitions, domain events, and next wakes use `contracts.transition` with `pg-boss.fromDrizzle(tx, sql)` on the same client.
- Test `fault between transition and enqueue`: rollback preserves the original state, event count, and queue count; every illegal source/input pair rejects without mutation.
- Test `authenticated HTTP`: create/list/read/input/cancel responses use frozen Zod schemas; `/input` aliases the frozen `/messages` path; objective/constraint revisions invalidate approval bindings.
- Command `bun test --dots`: `304 pass`, `36 todo`, `0 fail`, `1052 expect() calls`, `Ran 340 tests across 25 files. [40.77s]`, including the prepared runner tests.
- Command `bun run typecheck`: one concurrent runner-test draft had an unused import; command `bunx biome check --write apps/melete/test/integration/runner.test.ts` removed it before final verification.

## Slice 3: attempt runner verification in progress

- SHA `5b03238`: jobs/state-machine slice committed and pushed to `origin/lane/w1-service`.
- Command `bun run typecheck`: passed after runner, capability, bundle, trigger, approval and SSE modules were present; command `bun run lint` passed with one optional-chain warning, subsequently corrected.
- Test `cancelling a live stub`: cancellation finalizes durable attempt state before signalling the runtime; recovery interrupts only the exact attempt it fenced, and a rejected persisted outcome does not starve other candidates.
- Command `bun test apps/melete/test/integration/runner.test.ts`: initial new regression run returned `25 pass`, `1 fail` (`ERR_INVALID_ARG_TYPE` for a raw SQL Date parameter); one fix uses its ISO string.
- Command `bun test apps/melete/test/integration/runner.test.ts`: `26 pass`, `0 fail`, `186 expect() calls`, `Ran 26 tests across 1 file. [36.76s]`.
- Test `scripted stub runtime` and test `attempt capabilities`: prepared unit modules passed 40 tests; test `bundle assembly and completion evidence` passed 28 tests in their focused runs.
- Command `git -C C:/Users/gamin/melete-oss-w1 status --short --branch`: continuation remains on `lane/w1-service`; runner, waits, approvals and SSE edits remain uncommitted pending their ordered slice checks.

## Slice 3: runner committed verification

- Test `message-sent completion`: send evidence requires a supported send action, the expected connection, and its matching persisted receipt; reads cannot satisfy a send deliverable.
- Test `bootstrap starts migrated durable dependencies and the configured stub worker`: startup, authenticated routing and actual pg-boss execution pass against embedded Postgres; failed startup and shutdown close acquired resources.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: passed (`Checked 86 files in 163ms. No fixes applied.`).
- Command `bun test --dots`: `310 pass`, `36 todo`, `0 fail`, `1101 expect() calls`, `Ran 346 tests across 25 files. [83.84s]`.
- Test `attempt runner against Postgres and pg-boss`: lease expiry, stale epochs, capability signatures, runtime deduplication, bounded transcripts, durable outcomes, cancellation, recovery and budget limits are covered with the scripted stub.

## Slice 4: waits, triggers and approvals

- SHA `caaf04c`: bounded attempt runner committed and pushed to `origin/lane/w1-service`.
- Test `durable waits, triggers and approval inputs`: event registration checks buffered events in the transition transaction, consumes a persisted cursor once, and rejects missing, foreign or disabled predicates.
- Test `cron registrations are restored from durable trigger rows and disabled schedules disappear`: pg-boss schedules are restored on recovery; the real schedule worker persists one occurrence before waking a wait.
- Test `approval gate`: request hash, stored canonical payload, job revision, expiry and cancellation reject stale approval decisions; early decisions, duplicate decisions, multiple approvals and denials resume correctly.
- Command `bun test apps/melete/test/integration/waits.test.ts`: initial `17 pass`, `2 fail` from a raw SQL timestamp string and a too-short fixture session token; one fix cycle corrected both fixtures. Rerun: `19 pass`, `0 fail`, `91 expect() calls`, `30.39s`.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: one formatting fix, then `Checked 87 files in 155ms. No fixes applied.`.
- Command `bun test --dots`: `329 pass`, `36 todo`, `0 fail`, `1192 expect() calls`, `Ran 365 tests across 26 files. [112.01s]`.

## Owner review additions

- Test `submission admission`, test `reply obligations`, test `wake dispositions`, test `event resync`, test `generation fences` and test `scheduling fairness`: owner steering adds slices 8 through 13 before the final report; the original conformance 1, 2 and 5 work remains required.
- Command `bun run typecheck`: new public types may be added only in `packages/contracts/src/responsibility.ts` and exported from the index; OpenAPI changes add new paths; other frozen contract files remain unchanged.
- Command `bun run db:generate`: each new durable schema addition will have a new Drizzle migration.

## Slice 5: persisted SSE

- SHA `3f9db9a`: waits, triggers and approvals committed and pushed to `origin/lane/w1-service`.
- Test `persisted event streams`: authenticated routes replay Postgres rows by cursor, honor Last-Event-ID, fan out committed notifications through one LISTEN connection, retain one page per slow reader, and release cancelled readers.
- Test `a gap marker names its persisted notice and rollback holes never invent gaps`: interrupted streams identify a stored gap; sequence holes from rollback or other jobs do not fabricate history.
- Command `bun test apps/melete/test/integration/events.test.ts`: `11 pass`, `0 fail`, `78 expect() calls`, `Ran 11 tests across 1 file. [23.18s]`.
- Test `global database preload`: one disposable Postgres server serves isolated per-suite databases; shutdown runs after the whole suite; WAL and fsync keep Postgres defaults.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: passed (`Checked 88 files in 146ms. No fixes applied.`).
- Command `bun test --dots`: `340 pass`, `36 todo`, `0 fail`, `1272 expect() calls`, `Ran 376 tests across 27 files. [75.93s]`.
