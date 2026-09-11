# W16a experience adapter

## Assumptions

- `git -C C:/Users/gamin/melete-oss-w16a status --short --branch`: lane/w16a-experience starts clean from origin/integration; all work stays here and runs sequentially.
- `gh pr create --base integration`: DONE explicitly names integration; use that target despite the later main instruction.
- `Get-Content docs/design/INTEGRATION.md`: design vocabulary is input only; no private design files are copied into this repository.
- `Get-Content packages/contracts/src/reactions.ts`: this file does not exist in the starting revision; existing responsibility and provenance contracts supply the relevant seams.
- `Get-Content apps/melete/test/helpers/database.ts`: Postgres 17 and pg-boss fixtures already exist; reuse them and keep the binary-download skip fallback.
- `GET /conversations`: scope comes from the authenticated session, defaulting existing sessions to the oldest personal space; no request identity or space fields are accepted.

## Initial evidence

- `bun install`: 372 packages installed in 27.24 seconds with Bun 1.3.13.
- `gh repo clone ychampion/melete-private C:/Users/gamin/melete-private-design -- -q`: completed; read INTEGRATION.md, canvas README and component definitions.
- `Get-Content docs/CLIENT.md; Get-Content docs/ARCHITECTURE.md`: reviewed durable submissions, attempts, event cursors, approval hashes and connector boundary.
- `2026-09-11 20:53:20 UTC`: campaign clock started; stop by 2026-09-12 01:53:20 UTC.
- `bun run openapi; bun run client:generate`: generated 56 additive operations and their client response/request types.
- `bun run typecheck`: passed for the contract slice.
- `bunx biome check .`: 311 files passed.
- `bun test packages/contracts/src/experience.test.ts packages/contracts/src/openapi.test.ts packages/client/src/client.test.ts --max-concurrency=2`: 19 passed, 0 failed; 49 assertions.
- `until mkdir C:/Users/gamin/.melete-test.lock`: lock held by another run; cancelled waiting before acquiring it and continued implementation. No full test run has occurred yet; push waits for that check.

## Conversations, agents and trail progress

- `8ff7b02`: committed the initial additive contract and generated client.
- `bun test apps/melete/test/integration/experience.test.ts --max-concurrency=2`: 4 passed, 0 failed against embedded Postgres, including durable turn replay, next message, stop fencing, and queued pause/resume.
- `bun run typecheck`: first conversations check found missing route-param defaults and local id prefixes; corrected them and the next run passed.
- `bun run db:generate`: generated additive agent, turn, rule, undo, draft-send, profile, task and milestone tables plus session space and job projection fields.
- `Get-Content packages/runtime-hermes/src/adapter.ts`: Hermes has stop but no checkpoint-preserving pause; running pause returns not_available unless the runtime explicitly implements pause/resume. Queued pause/resume is implemented without creating another turn.
- `bun run typecheck`: trail implementation found two local typing errors (projection turn id and group suffix); correction underway, no runtime failure claimed.
- `bunx biome check --write --unsafe`: trail text sanitation used explicit control-code escapes; replaced those with Unicode control-character classification.
- `2026-09-11 21:18:16 UTC`: campaign checkpoint; shared suite lock remains in active use by other lanes.
- `bun test ... broker.test.ts`: 22 broker tests failed because its fixture applied only migrations 0000 and 0012 and lacked experience_turn; 7 projection/conversation tests passed. Changed the fixture to use the existing shared Postgres server and full migrated disposable database, also removing redundant server startups.
- `bun test apps/melete/test/integration/broker.test.ts apps/melete/test/integration/experience.test.ts apps/melete/src/experience/projectors.test.ts --max-concurrency=2`: 29 passed, 0 failed after fixture correction, 165 assertions in 19.57 seconds.
- `bun test apps/melete/test/integration/experience.test.ts --max-concurrency=2`: 5 passed, 0 failed, 38 assertions; three real actions across two connections produce one grouped action with stable cursor replay and no internal identifiers.
- `bun run typecheck; bun run lint`: passed; 319 files checked.
- `bun run test:plugin`: 20 passed in 10.18 seconds.
- `until mkdir C:/Users/gamin/.melete-test.lock`: second wait cancelled before acquisition so implementation can continue; no foreign lock removed and no unlocked full suite run.

## Receipts, draft sending and bounded permissions

- `214c623`: committed durable conversations, agent identity, grouped trail projection and runtime narration.
- `bun run db:generate`: generated 0018_same_stingray.sql for private owner-command identities linked to conversations.
- `bun test apps/melete/test/integration/experience-effects.test.ts apps/melete/src/connectors/calendar.test.ts --max-concurrency=2`: 12 passed, 0 failed, 68 assertions in 23.06 seconds.
- `bun run typecheck`: found an inferred recursive undo return type, then a newly added fixture result type; explicit return types fixed both. The next check passed.
- `bun test apps/melete/test/integration/experience-effects.test.ts apps/melete/test/integration/experience.test.ts apps/melete/test/integration/broker.test.ts apps/melete/src/connectors/calendar.test.ts --max-concurrency=2`: 41 passed, 0 failed, 230 assertions in 27.40 seconds.
- `calendar connector > delete respects the observed version and keeps a changed event`: stale ETag rejected; matching ETag removes exactly the selected event.
- `always is bounded, exact-recipient only, and untrusted destinations cannot create a rule`: trusted recipient isolation and untrusted rule refusal passed.
- `revoking an admitted standing permission prevents dispatch`: revocation refused the queued effect without invoking the connector.
- `a rule cannot exceed its count cap or survive expiry and re-consent`: all three bounds passed.
- `POST /receipts/{id}/undo`: calendar create reverses through a distinct brokered delete; sends and file writes with no stored reversal return not_available.
- `POST /permissions/{id}`: the reviewed action uses allow-once; the new rule count applies to subsequent actions. An admitted use consumes the cap conservatively, even when later execution is refused.

## Quick answers and saved details

- `0913711`: committed reviewed sending, conditional calendar undo, and bounded standing rules.
- `until mkdir C:/Users/gamin/.melete-test.lock`: third wait cancelled before acquiring the shared lock; no full run or push has occurred yet.
- `bun run openapi; bun run client:generate`: regenerated the optional quick-answer choices in runtime and owner-question contracts.
- `bun run typecheck`: passed for quick answers and plain-language memory projection.
- `bun test apps/melete/test/integration/experience.test.ts --max-concurrency=2`: 7 passed, 0 failed, 59 assertions in 28.60 seconds; offered choices, duplicate answers, real correction revisions, dependency explanations and the existing forget journal path passed.

## Home, plans, routines, and sign-in in progress

- `9b399d0`: committed quick answers and saved details; the fourth full-suite lock wait was cancelled before acquisition after more than fifteen minutes. No foreign lock was removed.
- `bun run db:generate`: generated `0019_organic_maria_hill.sql` for plan category and single-use magic-link digests.
- `bun run typecheck`: caught the new schedule class `scheduled`; replaced it with the existing `background` class. The affected check is running again.
- `bun test apps/melete/test/integration/experience.test.ts apps/melete/src/experience/home.test.ts --max-concurrency=2`: running the new home, task search, linked plan, and two-occurrence routine checks.
- `POST /signin/magic-link`: uses the configured owner mailbox and `MELETE_PUBLIC_URL`; tokens are digested, expire after ten minutes, and are bound to the active connection generation.
- `bun test apps/melete/test/integration/experience.test.ts apps/melete/src/experience/home.test.ts --max-concurrency=2`: 11 passed, 0 failed, 87 assertions in 38.09 seconds.
- `bun test apps/melete/test/integration/experience-signin.test.ts --max-concurrency=2`: first run caught Date serialization during session creation; after ISO serialization, 1 passed, 0 failed, 19 assertions in 32.56 seconds.
- `bun run typecheck`: passed; `bun run lint`: passed, 331 files.
- `home calendar reads use a scoped private command and reject writes`: passed, including repeated-read deduplication, foreign space refusal, and write refusal.
- `experience-effects.test.ts`: all seven assertions groups passed; a five-second fixture close timed out. Cleanup now has a thirty-second bound; focused rerun is pending completion.

## Review and scenario parity

- `50eea82`: committed plans, routines, home, and email sign-in; focused experience-effects rerun passed 7 tests and 41 assertions in 48.57 seconds.
- `bun run test:plugin`: 20 passed in 10.04 seconds.
- `until mkdir C:/Users/gamin/.melete-test.lock`: the current full-suite request has waited more than twenty minutes; the shared lock has changed owners during that wait. No foreign lock was removed and the full suite has not started.
- `projectPermission`: review found shortened bodies and omitted Cc/Bcc; a staged additive full-draft field and server refusal for unreviewable sends address the gap.
- `BrokerService.classify`: review found the stored asks-before-acting preference was not enforced for reversible changes; the staged gate and refusal tests cover that preference and missing agents.
- `bun test apps/mock-api/src/experience.test.ts apps/melete/src/experience/projectors.test.ts apps/melete/test/integration/experience-effects.test.ts apps/melete/test/integration/experience.test.ts --max-concurrency=2`: 25 passed; one new fixture tried to create a missing agent id and the foreign-key constraint refused it. The test now uses an existing agent from a foreign space.
- `bun test apps/melete/test/integration/experience-effects.test.ts apps/mock-api/src/experience.test.ts --max-concurrency=2`: 12 passed, 0 failed, 82 assertions in 16.08 seconds after that fixture correction.
- `bun run typecheck`: caught unparsed mock response values in the new test; explicit contract parsing fixed them and the rerun passed.
- `bun run openapi` and `bun run client:generate`: regenerated complete send-review fields and the additive turn identity input.
- `bun run lint`: passed, 332 files. `bun run compose:check`: passed all 12 checks.
- `until mkdir C:/Users/gamin/.melete-test.lock`: the previous wait was cancelled before acquisition to apply the completed mock and review fixes; the next full-suite request uses the stable tested source.

## Final focused verification

- `be4fd3c`: committed scenario parity, complete send previews, agent review enforcement, and per-turn intent identities.
- `unknown-outcome.json`: review found the fixture uses test.write rather than email.send; the mock now presents its message as a draft and preserves the fixture's unconfirmed outcome after approval.
- `bun test apps/mock-api/src/experience.test.ts apps/melete/test/integration/experience-signin.test.ts --max-concurrency=2`: 4 passed, 0 failed, 49 assertions in 10.90 seconds, including no second send or event after an uncertain result.
- `ExperienceSignIn.request`: availability is checked independently of the submitted address; accepted requests do not disclose whether that address matches the owner.
- `2240b24`: committed the uncertain-send scenario and uniform sign-in responses.
- `ExperiencePlanning.automation`: run history now checks persisted completion confirmation; an unknown effect is shown as needs_you instead of done. Milestones requiring reconciliation use the same readable attention state.
- `bun test apps/melete/test/integration/experience.test.ts --max-concurrency=2`: 12 passed, 0 failed, 103 assertions in 13.07 seconds; includes all five card sources from real rows, foreign artifact exclusion, credential-address refusal, and an unconfirmed third routine occurrence.
- `a27dc60`: committed all five real-row card projections and confirmed routine history; subsequent type checking and lint passed.
- `git -C C:/Users/gamin/melete-oss-w16a show origin/integration:packages/contracts/openapi.json` plus a resolved-reference schema comparison: 68 existing operations, zero removed or changed existing fields; new optional fields remain additive.
- `gh api repos/ychampion/melete/branches/integration --jq .commit.sha`: 9484023cabd32b786cb4d336dec818f441cd0cc1, matching the local starting base.

## Full-suite evidence

- `a27dc60`: full suite acquired the shared lock at 2026-09-11 23:17:44 UTC.
- `bun test --max-concurrency=2`: 936 passed, 0 failed, 14 existing todos, 4060 assertions across 80 files in 264.02 seconds. The lock was released by the exit trap.
- `/tmp/w16a-full-tests.log`: captured the complete run; the three-minute duration target was not met despite all executed tests passing.
- `python` duration summary of the full-suite log: recorded test bodies used about 164 seconds; setup and cleanup account for much of the remaining time. Checking the separate memory fixture's repeated embedded-server startup before changing it.
