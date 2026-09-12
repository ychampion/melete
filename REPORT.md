# Lane W16b: the web app, built from the design canvas

Append-only. Every line names a SHA, a command, a test, or a log excerpt.

## Assumptions
- The experience contract (`packages/contracts/src/experience.ts`, lane W16a) had not landed when this lane started (`git ls-remote --heads origin 'lane/w16a*'` returned nothing at 2026-09-12). The web app builds against `apps/web/src/experience/types.ts`, shaped as `docs/design/INTEGRATION.md` describes, behind one adapter (`apps/web/src/experience/adapter.ts`). When the contract lands, the adapter is the one file to change.
- The mock serves the designed surfaces under `/surfaces/*` from `apps/mock-api/src/surfaces.ts`. Those routes are validated with the mock's own zod schemas rather than `openapi.json`, because the contract paths do not exist yet. Conversations run through the real job state machine: a conversation is a job, and the trail, cards, permissions and receipts are derived from the job's persisted events, so the approval-card rule and the unknown-outcome rule hold in the new interface exactly as they did in the reference client.
- Surfaces the brief does not design (Inbox, Messages, Calendar page, Files) are not built and are not offered in the navigation. The mock reports them unavailable.
- Screenshots are taken with Playwright 1.63 (already installed on this machine) via `bun run --cwd apps/web screens`, rather than the gstack browse skill, so the run is a committed script anyone can repeat.

## Log
- 23dc3fb design system: tokens.css, base.css, primitives.tsx, icons.tsx (78 icons), logos.tsx (19 logos), face.tsx, mark.tsx, Sheet.tsx at #/design. `bun run --cwd apps/web typecheck` and `bunx biome check apps/web` clean.
- da1ffa1 mock: `apps/mock-api/src/surfaces.ts` serves `/experience/*`; scenario schema gained `say`, `card`, `draft`, `ask`, `browser` and `title`/`active_title`/`meta`/`sources` on `tool` (additive; the jump `label` field kept its name); runner gained `pauseJob`/`resumeJob`; five scenario files added (`dinner-with-friends`, `book-a-table`, `kyoto-in-october`, `passport-renewal`, `welcome`), the two original scenarios unchanged. `bun test apps/mock-api`: 30 pass, 0 fail.
- da1ffa1 smoke (node script against the running mock): dinner conversation reaches `block permission` with `title "Nova wants to add an event to Google Calendar"`, fields `[duration, place, title, when]`; `POST /experience/permissions/{id}` with `always` → 200, then `block_updated status allowed_always`, `block receipt "Added to your calendar"`, `trail_step done "Worked for 1s · calendar, web, Maps, Messages · 11 sources"`, rule `"Nova may add an event to Google Calendar without asking"` listed by `GET /experience/rules`; undo → 200; the follow-up "Perfect, book it and remind me at 6." reaches `block browser status working` then a `browser.reserve` permission.
- da1ffa1 smoke unknown-outcome: permission `"Melete wants to write one line to the test destination"` fields `[body, subject, to]`; allow once → `block unknown`, `turn_status waiting`; `POST /experience/unknown/{id}/resolve succeeded` → 200, then `trail_step done`, `turn_status done`. The done line is keyed on `job_state_changed → completed`, not on `attempt_ended`, so it never precedes a reconciliation.
- da1ffa1 smoke pause: `POST …/pause` → 200; event count unchanged over 3 s (7 → 7); resume → events advance (13); stop → `job_state_changed cancelled` mapped to `text_final` + `turn_status stopped`.
- dde5861 web app: `apps/web/src/{experience,shell,chat,screens}`; `bun run typecheck` (tsc -b + apps/web) clean; `bunx biome check .` "Checked 329 files … No fixes applied".
- 6144e39 receipts carry `attaches_to` (the card whose button decided the action) and draw under that card; card actions size to 44 px on phones; a missing card image falls back to a placeholder tile; `apps/web/scripts/screens.mjs` added, `bun run --cwd apps/web screens`.
- 8e7710a docs: `docs/CLIENT.md` gained "Rules the web app adds" and the mock's new scenarios and ports; `.agents/notes/0024-web-app.md`; `.agents/notes/proposed/2026-09-12-w16b-experience-shapes.md`; README rows for `apps/web`; `apps/web/.env.example` → `http://localhost:3210`.
- 8e7710a `node apps/web/scripts/screens.mjs` (mock on :3210 with `MOCK_PORT=3210 bun src/index.ts`, vite on :5180): "128 checks, 0 failed" — 22 surfaces × {1440, 1024, 390} × {light, dark} (the phone-only surfaces and the working state at fewer widths), each check = no horizontal overflow (`scrollWidth <= clientWidth + 1`) and zero console errors / page errors. Committed PNGs: 1440 light, 390 light, 1440 dark per surface, 39 files, 6.9 MB, captions in `apps/web/docs/screens/README.md`.
- 8e7710a `bun run --cwd apps/web build`: `✓ built in 483ms`, `dist/assets/index-DkPGgcS7.js 419.67 kB │ gzip: 122.83 kB`.
- W16a check: `git ls-remote --heads origin 'lane/w16a*'` returned nothing at 02:30, 03:40 and 04:20 local; no `packages/contracts/src/experience.ts` to adopt. The adapter stays on `apps/web/src/experience/types.ts`.

## Verification steps, exactly

1. `cd apps/mock-api && MOCK_PORT=3210 bun src/index.ts` (prints the seven scenario ids).
2. `bun run --cwd apps/web dev` (vite on :5180; `VITE_MELETE_API` defaults to :3210).
3. `bun run --cwd apps/web screens` → prints one `ok`/`FAIL` line per surface × viewport × theme and writes `apps/web/docs/screens/`.
4. In the browser: `#/`, type "Find a lovely spot for dinner with Alex and Priya tonight at 7:30." → Nova's trail runs (say, action with sources and logos), the composer shows Pause (rim travelling); after the text streams, the Luna Trattoria card appears with "Add to calendar" (= allow once; More ▾ → Always allow / Don't add it), the draft with "Send via Messages"; press Add to calendar → receipt "Added to your calendar · Tonight 7:30 PM · 1.5 hours · Google Calendar" with Undo; trail collapses to "Worked for Ns · calendar, web, Maps, Messages · 11 sources". Type "Perfect, book it and remind me at 6." → browser card + docked panel (Take control / Stop the task); Settings › Rules shows a rule after an Always.
5. Type "Write one line to the flaky test destination" → permission card built from the canonical payload (body, subject, to) with Allow once / Always allow / Deny; after allow → the unknown-outcome card ("I sent this once and never heard back…") with It arrived / It did not / I can't tell yet.
6. `#/design` for every primitive in every state. `MOCK_BROWSER=off` on the mock: the browser card, the panel and the tour's browser stage are absent. `MOCK_FRESH=1`: sign-in, then the five-step setup, ending in the welcome conversation that references an onboarding answer.

## Not done, and why

- **Save to plan** in the action bar shows a toast saying it is not available on this instance: the mock has no endpoint for it and the contract has none; inventing one would have been a lie about what the backend does.
- **Voice** and **Apple sign-in** are reported unavailable by the mock and therefore not drawn, which is the designed behaviour; both are one capability flag away.
- **Attachment upload progress** is simulated in the composer (no upload endpoint exists yet); the tile, the bar and the mid-upload cancel are real, the bytes go nowhere.
- **Inbox, Messages, a Calendar page, Files** are not built and not in the navigation (not in the brief's surface list).
- **The "Ask Melete about this plan" chat** plays the Kyoto scenario for any plan, because the mock picks scenarios by text; the plan's title is in the message, the answer is not plan-specific.
- The gstack browse skill was not used; Playwright 1.63 was already installed and a committed script is repeatable by anyone.

## Assumptions, continued
- The full-suite `bun test` run (under the lock, started at ~04:25) was killed by the machine for low memory before it produced a result; the orchestrator then directed: never run the full suite on this box, only `apps/web` checks and `bun run --cwd apps/web build`. No full-suite result is claimed. `bun test apps/mock-api` (33 pass, 0 fail) is the only test evidence beyond the screen walk.
- The experience contract landed as `origin/lane/w16a-experience` (PR #22) after the web app was built. It is merged into this branch (e639b22) so the contract, its OpenAPI paths, its mock module and its tests are here. The web app still talks to this lane's `/surfaces/*` routes: retargeting every surface to the contract's shapes is a separate slice, and the field-by-field mapping is recorded in `.agents/notes/proposed/2026-09-12-w16b-experience-shapes.md`. The two mock modules coexist on one Hono app; this lane's prefix moved from `/experience` to `/surfaces` (49146ad) because the contract owns `/experience/connections`.

## Log, continued
- 2790744 REPORT.md: verification steps and the not-done list.
- 49146ad `apps/mock-api/src/experience.ts` → `surfaces.ts`, mounted at `/surfaces`; adapter, screens script, docs updated. `bun run typecheck` clean.
- e639b22 merge of `origin/lane/w16a-experience` (723c748). Conflicts resolved: `docs/CLIENT.md` (theirs, plus this lane's mock paragraph and "Rules the web app adds"), `REPORT.md` (both reports, this lane first), `apps/mock-api/src/index.ts` (both wirings). After the merge: `bun install` "no changes", `bun run typecheck` clean, `bunx biome check .` "Checked 354 files … No fixes applied" after one `role="img"` fix, `bun test apps/mock-api` 33 pass / 0 fail, `bun run --cwd apps/web build` "✓ built in 518ms". Both lanes' routes answer on one mock: `GET /surfaces/capabilities` and `GET /experience/connections`.
- after e639b22: `node apps/web/scripts/screens.mjs` on the merged tree → "128 checks, 0 failed"; `apps/web/docs/screens/` regenerated.

## Final
Branch `lane/w16b-web`. `bun run typecheck` clean, `bunx biome check .` clean, `bun run --cwd apps/web build` green, `bun test apps/mock-api` 33/33, the screen walk 128/128 at 1440, 1024 and 390 in light and dark with no horizontal overflow and no console errors. The full repo suite was not run (killed for memory, then forbidden by the orchestrator). The web app runs against this lane's `/surfaces/*` mock routes; the landed experience contract is merged and mapped, not yet wired. PR opened to `integration`.

## Retarget to the experience contract

- cca7bb0 The web app reads `packages/contracts/src/experience.ts` through the generated client and nothing else. `apps/web/src/experience/types.ts` is derived from the OpenAPI `paths`; `adapter.ts` maps each call to data, error, or the contract's `not_available` reason; `reduce.ts` folds the contract's events (`say`, `action`, `note`, `done`, `text_delta`, `card`, `receipt`, `permission`, `question`, `status`) into turns. Every screen, the shell, the palette, sign-in and setup use contract routes: conversations, messages with `Idempotency-Key`, pause/resume/stop, SSE events with `Last-Event-ID`, permissions with `version` and `bounds`, receipts with undo handles, drafts with explicit send, quick answers, agents and templates, memory with `why`, plans and milestones, tasks, home, automations, connections, rules, search, magic-link and profile.
- cca7bb0 `apps/mock-api/src/surfaces.ts` deleted and unwired; `MOCK_SEED=off` starts the contract mock empty (the tests' default), otherwise it is seeded with the designed data plus one standing rule. The mock's generic opener is skipped when a scenario speaks first.
- cca7bb0 A permission or question decided elsewhere is closed ("Decided", options disabled) once the turn's `status` leaves `needs_you`; the contract has no decision event, so the option is not guessed. Proposed as additive items in the mapping note.
- cca7bb0 Hidden, not faked, because the contract has no shape: the browser task card and panel, reactions, chat rename/pin/delete/share, save to plan, attachments and voice, add milestone / complete plan / plan templates, connect/disconnect, automation toggle/retry/edit, agent delete and face import, the "get to know you" setup step, unknown-outcome resolve, the "Example" badge, sign-out. Each is a row in `.agents/notes/proposed/2026-09-12-w16b-experience-shapes.md` with the proposed addition.
- cca7bb0 `bun run --cwd apps/web typecheck` clean; `bunx biome check apps/web apps/mock-api` "Checked 53 files … No fixes applied"; `bunx tsc -b` clean; `bun run --cwd apps/web build` "✓ built in 352ms", `dist/assets/index-DuhkaHFh.js 409.92 kB │ gzip: 122.60 kB`; `bun test apps/mock-api` 33 pass / 0 fail; `node apps/web/scripts/screens.mjs` against the seeded contract mock on :3210 and vite on :5180: "118 checks, 0 failed" — 23 surfaces × {1440, 1024, 390} × {light, dark} (chat-working, chat-sent and the phone surfaces at fewer widths), no horizontal overflow, no console or page errors. Screenshots refreshed in `apps/web/docs/screens/` (the browser and know-you captures removed, chat-sent added). The full repo suite was not run, per the orchestrator's instruction for this box.

## Verification steps, exactly (on the contract)

1. `MOCK_PORT=3210 bun run dev:mock` (seeded; `MOCK_SEED=off` for an empty instance) and `bun run --cwd apps/web dev` on :5180.
2. `bun run --cwd apps/web screens` → one `ok`/`FAIL` line per surface × viewport × theme; writes `apps/web/docs/screens/`.
3. `#/`, type "Find a lovely spot for dinner with Alex and Priya tonight at 7:30." → say and action steps with app-named sources, Stop in the composer; the Luna Trattoria card, the draft to Alex with "Send via Messages", then the permission card with the card as its preview: Allow once / Always allow (asks for the count cap, expiry and re-consent days) / Deny → the receipt "Added to your calendar" with Undo; Undo → "Removed again" receipt, the first marked reversed. Send the draft → the sent receipt.
4. "Kyoto in October" → a question answered with the 1–4 keys or a typed answer; "Passport renewal" → a plain answer with its source.
5. Settings › Rules shows the seeded rule with its limit, expiry and re-consent, and Revoke removes it; Memory edits carry the item's version and "why" comes from its own call.
6. `#/welcome` probes the sign-in routes: the Google and Apple buttons appear only when the mock answers them, the magic link always. `#/setup` walks the four steps and ends by saving the profile, creating the agent and the morning brief.

## Final, after the retarget
Branch `lane/w16b-web` at cca7bb0. The web app runs unchanged against `apps/mock-api` serving the W16a shapes and will run against the real service on the same routes. What the contract lacks is hidden and listed as proposed additive changes. Checks: typecheck clean, biome clean, build green, `bun test apps/mock-api` 33/33, screen walk 118/118. PR #23 to `integration` carries the change.

---

# Lane W16a report, merged into this branch

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

## Suite duration follow-up

- `bun run .w16a-db-bench.ts`: a standalone fixture started in 8965 ms and closed in 615 ms; a repeated shared-server fixture started in 967 ms and closed in 95 ms. The temporary benchmark file was removed after use.
- `bun run .w16a-db-bench.ts`: five cascading truncates took 304–458 ms each; row deletion took 2–28 ms. Ordinary deletes initially left detached records that cascading truncation had cleared.
- `bun test` on the affected fixture suites: 126 passed and 40 failed after the initial row reset; failures exposed detached reply/outbox and global-event records. The reset now derives the same dependent table set from foreign keys, clears children first under the original exclusive-lock boundary, and refuses non-disposable databases.
- `bun test` on attention, events, replies, waits, responsibility, submissions, and runner integration suites: 96 passed, 0 failed, 684 assertions in 48.81 seconds after the reset correction.
- `bun run typecheck` and `bun run lint`: passed after the fixture changes; the full duration check is next under the shared lock.

## Final

- `31da644`: final source revision verified by the full suite; fixture changes retain separate disposable databases, foreign-key enforcement, and durable Postgres settings.
- `bun test --max-concurrency=2`: acquired the shared lock at 2026-09-11 23:33:10 UTC; 936 passed, 0 failed, 14 existing todos, 4060 assertions across 80 files in 177.18 seconds. The exit trap released the lock. This meets the three-minute target.
- `/tmp/w16a-fixture-full-tests.log`: complete final full-suite output; runtime improved from 264.02 seconds to 177.18 seconds.
- `bun run typecheck`: passed. `bun run lint`: passed, 332 files. `bun run test:plugin`: 20 passed. `bun run compose:check`: all 12 checks passed.
- `packages/contracts/src/experience.ts`: all 56 experience operations have additive schemas, OpenAPI paths, regenerated client types, real implementations or explicit typed unavailable responses, and matching scenario responses.
- `docs/CLIENT.md` and `.agents/notes/0023-experience-adapter.md`: document the experience contract, private implementation boundary, supported controls, and unavailable capabilities.
- `POST /conversations/{id}/pause`: running pause remains unavailable without runtime checkpoint support; queued pause/resume and immediate stop are verified.
- `POST /receipts/{id}/undo`: conditional calendar reversal is verified; irreversible sending and unsupported draft/file reversals remain unavailable.
- `POST /signin/magic-link`: requires the configured personal mailbox and public address. Google/Apple sign-in, plan sharing, browser controls, music, and live data remain typed unavailable capabilities.
- `bun test`: 14 pre-existing conformance todos remain unchanged; container-network execution needs the separate Linux environment. All tests in this lane used scripted providers; no external-provider smoke was specified.
- `git -C C:/Users/gamin/melete-oss-w16a push -u origin lane/w16a-experience`: pushed the verified source branch.
- `gh pr create --repo ychampion/melete --base integration --head lane/w16a-experience`: opened https://github.com/ychampion/melete/pull/22; no merge was performed.
- `2026-09-11 23:36:48 UTC`: implementation, full verification, and PR creation completed within the five-hour campaign cap.
