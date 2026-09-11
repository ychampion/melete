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
