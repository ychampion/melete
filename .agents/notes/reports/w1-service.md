# W1 service delivery

## Assumptions

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: frozen contracts stay unchanged; stub `{"script":[...]}` is encoded in `job.constraints.notes`, whose contract permits a string.
- Test `lease fencing`: expired attempts keep contract outcome `fenced` and loss metadata; an internal lease status may name `lost` without adding a public outcome.
- Test `SSE replay`: persisted `notice` payloads identify `gap` and `receipt`; SSE may frame the gap as `event: gap` without changing the frozen event enum.
- Command `bun test`: use throwaway Postgres 17 databases, at most two concurrent tests, W1 API port 3100 and broker port 3102 when binding ports.
- Command `bun test`: all runtime tests use scripted fake outcomes; no slice requests a real-provider smoke call.

## Initial inspection

- Command `git status --short --branch`: `lane/w1-service...origin/main`, clean before dependency installation.
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
- Command `git status --short --branch`: continuation remains on `lane/w1-service`; runner, waits, approvals and SSE edits remain uncommitted pending their ordered slice checks.

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
- Command `bun test apps/melete/test/integration/waits.test.ts`: initial `17 pass`, `2 fail` from a raw SQL timestamp string and a too-short fixture session token; one fix pass corrected both fixtures. Rerun: `19 pass`, `0 fail`, `91 expect() calls`, `30.39s`.
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

## Slice 6: conformance 1, 2 and 5

- SHA `e1ba489`: persisted SSE committed and pushed to `origin/lane/w1-service`.
- Test `conformance 1`: an actual child process exits after the transition/event writes and before enqueue; Postgres rolls back that transaction, the prior due wait survives queue deletion, recovery re-enqueues it, and duplicated timers admit one replacement attempt.
- Test `conformance 2`: A resumes while B holds the live lease; A's admission and outcome reject with `stale_epoch`; B admits normally; a duplicate late receipt records one event without changing B's running state, epoch or state version.
- Test `conformance 5`: child processes die mid-stream and after a persisted tool result; replacement attempts recover stored context, produce one fake effect, end the old attempt as lost and expose a real SSE gap marker.
- Command `bun test conformance`: initial import/type failures required declaring the existing Drizzle dependency in the conformance package and omitting an invalid null draft; one fix pass. Rerun: `12 pass`, `24 todo`, `0 fail`, `59 expect() calls`, `Ran 36 tests across 8 files. [27.55s]`.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: passed (`Checked 91 files in 164ms. No fixes applied.`).
- Command `bun test --dots`: `352 pass`, `24 todo`, `0 fail`, `1331 expect() calls`, `Ran 376 tests across 27 files. [87.44s]`.
- Command `bun run conformance`: now executes the suite after listing its assertions; conformance scenarios 3, 4, 6, 7 and 8 remain outside this lane's requested conformance scope.

## Slice 8: submission receipts

- SHA `566990d`: required conformance scenarios committed and pushed to `origin/lane/w1-service`; the final report remains deferred until the owner review slices finish.
- Command `bun run --cwd apps/melete db:generate --name=submissions`: generated `0003_submissions.sql` with the receipt and independent acceptance-journal tables.
- Test `death after durable admission but before response`: a child exits after the admission transaction commits; lookup and retry return the same receipt with one job and one receipt row.
- Test `racing repeats`: canonical JSON key order deduplicates admission; input text bytes and operation identity remain significant; a changed payload under the same key returns 409 and preserves the original receipt.
- Test `receipt_missing`, test `history_missing`, test `history_corrupt` and test `marker_only`: damaged history becomes persisted `unknown_durability`; the service never admits replacement work for that known submission ID.
- Command `bun test apps/melete/test/integration/submissions.test.ts apps/melete/test/integration/jobs.test.ts`: `25 pass`, `0 fail`, `319 expect() calls`, `57.91s` before adding the persisted-uncertainty assertions.
- Command `bun run typecheck`: three assertion typings corrected in one fix pass; final run passed (`$ tsc -b`).
- Command `bun test --dots`: first full run found the old exact-table-list assertion; one fix lets the original entity assertion accept additive tables. Final run: `363 pass`, `24 todo`, `0 fail`, `1402 expect() calls`, `Ran 387 tests across 28 files. [138.98s]`.
- Command `bun run lint`: passed (`Checked 96 files in 371ms. No fixes applied.`); command `bun run openapi`: regenerated the new receipt lookup and input paths.
- Test `global database preload`: suites clone one migrated template into separate disposable databases; tests assert `fsync=on` and `synchronous_commit=on`.

## Slice 9: reply obligations and outbox

- SHA `6636c24`: idempotent submission receipts committed and pushed to `origin/lane/w1-service`.
- Command `bun run --cwd apps/melete db:generate --name=reply_obligations`: generated `0004_reply_obligations.sql` with separate reply-obligation and notification-attempt records.
- Test `a direct request creates one obligation`: admission records an owed reply in the receipt transaction; assistant text and acceptance acknowledgement do not claim delivery.
- Test `interrupted direct admission` and test `interrupted quiet unchanged check`: actual child exits recover the direct obligation with an explicit retransmission state; the quiet check creates no obligation or notification.
- Test `delivery attempts recover separately`: retries retain their delivery key and attempt history; an exact content-hash acknowledgement, including a late acknowledgement, fulfills the recorded obligations once.
- Test `coalescing`: pending content may be replaced while every direct obligation remains owed; missing content is reconstructed only from durable response data.
- Test `spent attempt budget`: an exhausted job rejects another input without accepting an obligation it cannot run; the original deliverable-without-evidence wait remains intact.
- Command `bun test apps/melete/test/integration/replies.test.ts`: `8 pass`, `0 fail`, `48 expect() calls`, `40.03s`.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: one formatting fix, then `Checked 100 files in 361ms. No fixes applied.`.
- Command `bun test --dots`: `371 pass`, `24 todo`, `0 fail`, `1450 expect() calls`, `Ran 395 tests across 29 files. [151.74s]`.

## Slice 10: wake dispositions

- SHA `6db1928`: reply obligations and notification outbox committed and pushed to `origin/lane/w1-service`.
- Command `bun run --cwd apps/melete db:generate --name=wake_dispositions`: generated `0005_wake_dispositions.sql`; waits, attempts, delivery records and background operations carry explicit substrate dispositions.
- Test `deaths at registration, claim, rearm and settlement`: twelve actual child exits cover timer, accepted remote reference and local process records; queue deletion cannot lose the registrations, and duplicate wakes cannot settle twice.
- Test `local_process`: an expired process remains `interrupted` with `local_process_interrupted`; recovery cannot claim or rearm it. Only its live owner may explicitly schedule a continuation before lease expiry.
- Test `uncertain external work`: a remote operation without an accepted reference remains `unknown` with `external_uncertain`; no probe or dispatch occurs.
- Test `operation settlement before wait registration`: a durable result wakes the matching wait once even when settlement precedes wait registration.
- Command `bun test apps/melete/test/integration/responsibility.test.ts`: `5 pass`, `0 fail`, `38 expect() calls`, `40.97s`.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: `Checked 104 files in 169ms. No fixes applied.`.
- Command `bun test --dots`: `376 pass`, `24 todo`, `0 fail`, `1488 expect() calls`, `Ran 400 tests across 30 files. [60.89s]`.

## Assumptions

- Test `remote_task`: remote recovery inspects an already accepted reference using an injected connector probe; a fresh external dispatch is outside `OperationService`. Without a probe the record remains available through the owner operation API.
- Test `local_process`: substrate disposition names the recovery behavior, while operation state distinguishes a currently live claim from its eventual interrupted disposition; replacement runtime attempts still use a new attempt identity and epoch.

## Slice 11: event protocol

- SHA `bb7d48b`: wake dispositions committed and pushed to `origin/lane/w1-service`.
- Command `bun run --cwd apps/melete db:generate --name=event_protocol`: generated `0006_event_protocol.sql` with event epochs and a durable stream-retention watermark; pre-protocol epochs remain null.
- Test `retention reconnect`: an expired cursor receives a retention gap and reset snapshot at a real committed head; subsequent events carry matching `cursor` and `seq` plus the current job epoch.
- Test `epoch changes and explicit resync`: reconnection with an earlier epoch, `resync=true`, an ahead-of-head cursor or an unknown historical epoch returns current truth without inventing event history.
- Test `retention reconnect`: stream replay retention leaves the canonical event ledger and independent acceptance journal available for recovery; receipt lookup remains identical after retention advances.
- Test `conformance 5`: a client that already knows the replacement epoch still replays the original persisted runtime-gap event with its actual sequence ID.
- Command `bun test apps/melete/test/integration/responsibility.test.ts apps/melete/test/integration/events.test.ts conformance/scenarios/05-runtime-death.test.ts`: an initial shutdown race caused a fixture deadlock; one fix drains pending stream SQL before shutdown. Final run: `22 pass`, `0 fail`, `173 expect() calls`, `24.49s`.
- Command `bun run typecheck`: one assertion typing fix, then passed (`$ tsc -b`); command `bun run lint`: `Checked 105 files in 99ms. No fixes applied.`.
- Command `bun test --dots`: `378 pass`, `24 todo`, `0 fail`, `1513 expect() calls`, `Ran 402 tests across 30 files. [55.51s]`.

## Slice 12: account and policy generations

- SHA `677ccfb`: event protocol committed and pushed to `origin/lane/w1-service`.
- Command `bun run --cwd apps/melete db:generate --name=context_generations`: generated `0007_context_generations.sql`; spaces, connections, attempts and background-operation provenance persist their generations.
- Test `revocation during inference`: the lifecycle transaction fences the old attempt, invalidates context snapshot references, fails undispatched actions, marks dispatched actions unknown and emits a persisted `context_invalidated` control before a fresh attempt runs.
- Test `credential switches`: context assembly and connector admission reject stale generation snapshots; fresh bundles include the new generation and exclude revoked account content and credential bytes.
- Test `revocation during inference`: completed tool identities survive context redaction so revocation cannot make an already completed effect replayable.
- Test `delayed invalidation signal`: runtime controllers are tracked by attempt identity; signalling the old inference after its replacement starts aborts only the old inference.
- Command `bun test apps/melete/test/integration/responsibility.test.ts -t 'revocation during|credential switches'`: initial fixture content was moved from owner constraints to the fake connector result; an assertion-path stall was isolated with `bun run .omx/inspect-generation.ts`, which rejected both gates immediately, then fixed by awaiting and inspecting rejections explicitly. Final run: `2 pass`, `0 fail`, `30 expect() calls`, `8.33s`.
- Command `bun test apps/melete/test/integration/responsibility.test.ts -t 'delayed invalidation'`: `1 pass`, `0 fail`, `3 expect() calls`, `7.46s`.
- Command `bun run typecheck`: passed (`$ tsc -b`); command `bun run lint`: one formatting fix, then `Checked 108 files in 91ms. No fixes applied.`.
- Command `bun test --dots`: `381 pass`, `24 todo`, `0 fail`, `1546 expect() calls`, `Ran 405 tests across 30 files. [52.67s]`.

## Slice 13: scheduling classes and attention (2026-09-11)

- SHA `47cf37d`: account and policy generations committed and pushed to `origin/lane/w1-service`; slice 13 was left uncommitted on disk when the previous run ended and was reviewed, verified and finished here rather than reverted.
- Command `bun run --cwd apps/melete db:generate --name=scheduling_attention`: generated `0008_scheduling_attention.sql`; the job row carries its scheduling class, importance, unread count and threshold, cadence multiplier, attention status, the unmultiplied base wake time, the remaining scheduled occurrences to skip, and the last result hash.
- pg-boss now has one attempt queue per class (`job.wake.interactive`, `job.wake.background`, `job.wake.quiet`) in `apps/melete/src/jobs/queue.ts`; `job.wake` is still worked so hints queued before the upgrade drain instead of stranding. `enqueueWake` routes by the class persisted on the job, so a recovered wake lands on the same queue as the original.
- `apps/melete/src/jobs/fair-scheduler.ts` bounds execution to two concurrent attempts across all three classes and hands the next free slot to each nonempty class in turn, so continuous interactive load cannot take every turn from accepted background work.
- Test `a continuously busy interactive class cannot take the next turns from waiting classes`: twelve interactive submissions with two background and two quiet submissions start in the order `i0 i1 b0 q0 i2 b1 q1 i3`, and concurrency never exceeds two.
- Test `failures release capacity and stopping drains owned work without admitting pending work`: a thrown attempt frees its slot for the next class, and stopping settles work already started while refusing work still queued.
- Test `real pg-boss class queues serve accepted background and quiet work during interactive load`: with twelve stalled interactive attempts saturating the runner, a background and a quiet responsibility accepted afterwards both start as soon as slots free, through the real queues rather than the in-process scheduler alone.
- `apps/melete/src/jobs/attention.ts` counts a result only when its text differs from the last recorded result hash, so an unchanged quiet check stays quiet; delivery is not reading, and only `POST /jobs/:id/read` clears the count.
- Test `routine: unread results change visible attention and preserve future work`: after four unread results the routine responsibility reports `frequency_reduced`, multiplies its timer by four, and keeps its next wake more than 230 seconds out; the work stays `waiting_for_event_or_time` and is never cancelled or abandoned.
- Test `important: unread results change visible attention and preserve future work`: the same four unread results report `needs_attention` and leave the cadence at its original multiplier, so an explicitly important responsibility keeps checking at full frequency.
- Test `routine: ...` and test `important: ...`: deleting every queued hint and running `runner.recover()` re-enqueues exactly one hint on `job.wake.background`, proving the class and the reduced cadence live on the job row and not in the queue.
- Test `unchanged quiet checks preserve their baseline across restart without unread results or notifications`: four attempts across four separate runner lifetimes record one baseline hash, leave `unread_results` at zero and `attention_status` at `normal`, and write no notification rows.
- Test `cron cadence reduction persists skipped occurrences and important schedules continue every occurrence`: a routine schedule defers three occurrences with a `routine_check_deferred` notice and runs the fourth; the important schedule runs on its first occurrence.
- Test `responsibility HTTP admission preserves scheduling preferences and old-class hints cannot start work`: `POST /responsibilities` returns an accepted receipt with the requested class, importance and threshold; `POST /jobs/:id/scheduling` moves the responsibility to another class, leaves exactly one hint on the new queue, and makes the pre-change hint unable to claim; `POST /jobs/:id/read` requires a session and then returns 200.
- Contracts stayed additive and confined to `packages/contracts/src/responsibility.ts` plus new paths in `packages/contracts/src/openapi.ts`. A dereferenced comparison of `packages/contracts/openapi.json` against `47cf37d` removes no path and no schema; it adds `POST /responsibilities`, `GET /jobs/{id}/responsibility`, `POST /jobs/{id}/scheduling` and `POST /jobs/{id}/read`, and adds optional-with-default request fields and new response fields. The only pre-existing paths whose schemas changed are `/snapshot` and `/jobs/{id}/snapshot`, which gained the new responsibility fields and lost none.
- Command `bun run typecheck`: passed (`$ tsc -b`), no fix passes needed.
- Command `bun run lint`: passed (`Checked 112 files in 94ms. No fixes applied.`).
- Command `bun test --max-concurrency=2`: `389 pass`, `24 todo`, `0 fail`, `1592 expect() calls`, `Ran 413 tests across 31 files. [67.49s]`.
- Command `bun test apps/melete/test/integration/responsibility.test.ts`: `16 pass`, `0 fail`, `137 expect() calls`, `Ran 16 tests across 1 file. [20.80s]` against embedded Postgres.
- Command `bun run openapi`: regenerated `packages/contracts/openapi.json`; a second run produced identical bytes, and test `the committed openapi.json is in sync with the schemas` passes.
- Command `bun run compose:check`: `compose:check passed (11 checks)`.
- Command `bun run conformance`: `8 scenarios, 36 assertions`, then `12 pass`, `24 todo`, `0 fail`, `Ran 36 tests across 8 files. [14.33s]`. Scenarios 1, 2 and 5 remain the implemented set for this lane; 3, 4, 6, 7 and 8 stay outside its scope.
