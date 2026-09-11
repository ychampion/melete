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
