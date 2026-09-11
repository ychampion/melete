# Lane W12, typed repair policy: the review findings and how each was closed

Branch `lane/w12-repair`, PR #12 against `integration`.

The independent review of `a376bba` requested changes on nine findings, five HIGH
and four MEDIUM. Every one was reproduced by a test that failed first and then
fixed. The reproductions are named so a reader can run them rather than take this
page's word for it.

## What closed each finding

| # | Finding | Commit | The test that proves it |
|---|---|---|---|
| 1 | HIGH. A bad-output revision replaced the approved payload with no invariant check; a probe changed recipient, amount and resource and the send completed | `67449d7` | `src/broker/repair.test.ts`: *a revision that changes the recipient, the amount or the resource is refused*; *an approved external send may not be revised at all*; *a revision that only fixes the content is accepted and sent once* |
| 2 | HIGH. Drift safety inferred equivalence from one missing and one surplus field, and the candidate test recomputed its expectation with the same rename; a probe accepted `to` becoming `memo` | `67449d7` | `src/broker/repair.test.ts`: *a rename that would re-aim the effect is refused however the destination asks*; *a rename the connector never declared is refused even when it looks obvious*; *the candidate's test is specified independently of the transform* |
| 3 | HIGH. Executions after the first bypassed the generation, scope, binding and origin checks, so a revocation during backoff could not fence the retry | `67449d7` | `test/integration/repair.test.ts`: *a revocation during backoff fences the retry before it is sent* |
| 4 | HIGH. Parking restored `admitted` but dispatch never read `retry_after_at`, so a repeated proposal went out early | `67449d7` | `test/integration/repair.test.ts`: *a parked action refuses to leave before the destination asked* |
| 5 | HIGH. Parking moved the job to waiting while its attempt still held an active lease with no end time | `3aa49e0` | `test/integration/repair.test.ts`: *parking releases the attempt, it does not strand it* |
| 6 | MEDIUM. Resumption overwrote `repair_trace` and `repair_counters`, erasing the rate limit that caused the wait | `67449d7` | `test/integration/repair.test.ts`: *a rate limit parks the job and releases the worker* |
| 7 | MEDIUM. The only `refreshCredential` set an in-memory flag; no credential-store path was implemented or exercised | `3aa49e0` | `test/integration/repair.test.ts`: *an expired credential is refreshed through the store, once*; *a revoked grant is never refreshed and never substituted*; *a refresh the store cannot satisfy stops instead of retrying* |
| 8 | MEDIUM. An unclassified throw rested at `unknown` with no question, so nothing was escalated | `67449d7` | `test/integration/repair.test.ts`: *a failure nobody classified still asks the owner one question*; *a second unclassified failure does not stack a second question* |
| 9 | MEDIUM. Fixtures loaded a migration by literal filename, letting a test hold a schema no install has ever had | `67449d7` | every Postgres fixture applies the committed journal; exercised by `test/integration/postgres.test.ts`, `budget.test.ts`, `test-destination.test.ts` and the rest of the integration suite |

Two commits rather than nine. The findings share `repair.ts`, `service.ts` and one
test file, and splitting them afterwards would have meant rewriting a branch the
review already holds SHAs for. Each finding still has its own failing
reproduction, named above.

## What changed

A revision fixes an output and never re-aims an effect. For `write_external` and
`spend` the person approved exact bytes and the action keeps that hash, so no
revision of one is accepted at all; elsewhere a revision may correct content but
never a recipient, a destination, an amount, a resource, or the set of fields the
person saw. It is measured against the approved payload rather than the last one
sent, so two individually harmless steps cannot add up to a different effect.

A drift mapping needs the connector to vouch for the rename in
`describe().equivalent_fields`, a field that decides where the effect lands keeps
its name whatever the destination now calls it, and the candidate's test states
the operation and the values that must survive and then checks those, rather than
recomputing the expected payload with the rename under test.

`checkAuthority` is one method. The dispatch asks it before marking the action
dispatched, and the policy asks it again before every further execution, so a
grant revoked during a backoff fences the retry instead of being out-run by it.

The due time of a parked action is enforced under the dispatch row lock, and the
recovery scan passes the instant it selected with, so two clocks cannot disagree
about whether an action is ready. Parking also ends the attempt, with
`parkAttempt` as the seam for the jobs module to own that release.

Repair history is appended across wakes. An uncertain outcome asks one
deduplicated question while still resting at `unknown`. Every fixture applies the
committed migration journal.

## Verification

Run under the shared test lock on 2026-09-12, from `3aa49e0`.

| Check | Result |
|---|---|
| `bun run typecheck` | pass |
| `bun run lint` | pass |
| `bun run openapi` then `bun run client:generate` | pass, working tree clean afterwards |
| `bun run compose:check` | pass, 12 checks |
| `bun test --max-concurrency=2` | 966 pass, 14 todo, 0 fail, 980 tests across 75 files, 605 s |

The full suite is green with nothing skipped for load. Earlier runs of this
branch showed timeouts in the knowledge and memory suites; they do not recur when
full runs are serialized.
