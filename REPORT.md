# W14 capability audit and proof

## Assumptions

- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: the W14 brief's DONE line selects `integration` as the PR base; its later reference to `main` is inconsistent, so this lane targets `integration` and never pushes to `main`.
- Command `git -C C:/Users/gamin/melete-oss-w14 status --short --branch`: work is confined to the existing `lane/w14-capabilities` worktree; no stash or other worktree is used.
- Command `bun install`: the existing `embedded-postgres` devDependency and fixture are retained; tests use the fake provider and at most two workers.
- Log `W14 contract freeze`: the brief requires a proposal and a stop of the affected slice when a contract change is necessary; additive changes are still contract changes and are not silently introduced elsewhere.

## Start — 2026-09-11 19:41 UTC

- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: starting integration revision, clean working tree on `lane/w14-capabilities`.
- Command `bun install`: exit 0; `372 packages installed [30.31s]`.
- Command `rg -n 'hook_event|hook_error|principal|shared|context_invalidated' packages/contracts/src`: runtime hook events and shared principal contracts are absent; `context_invalidated` already exists in the responsibility extension.
- Log `packages/contracts/src/runtime.ts:168-218`: the frozen runtime event union has six variants and no hook event or hook error.
- Log `packages/contracts/src/entities.ts:27-35`: the frozen space kinds contain only `personal` and space audiences only `owner`.
- Log `apps/melete/src/db/schema.ts:26-37`: the current owner table has `owner_singleton_idx`; creating a second authenticated principal requires the scoped contract proposal, not an unguarded second row.
- Command `git -C C:/Users/gamin/melete-oss-w14 clone --depth 1 --branch v2026.9.7 https://github.com/NousResearch/hermes-agent.git .hermes-src`: checkout in progress; reported tag commit `2237be355906fbe6065ce1815711eee52b2d646e`.

## Audit and slice boundaries — 2026-09-11 20:05 UTC

- Log `owner steering`: continue at xhigh, solo and sequentially; no subagents were spawned. `REPORT.md`, branch status and the last three commits were reread before continuing.
- Command `git -C C:/Users/gamin/melete-oss-w14 --git-dir=C:/Users/gamin/melete-oss-w14/.hermes-src/.git --work-tree=C:/Users/gamin/melete-oss-w14/.hermes-src rev-parse HEAD`: `2237be355906fbe6065ce1815711eee52b2d646e`; clone completed without changing the pin.
- Command `python packages/runtime-hermes/scripts/audit-pin.py .hermes-src`: `VALID_HOOKS: 37 (hermes_cli/plugins.py:107)`; literal dispatch sites inventoried in `.agents/notes/0021-hermes-capability-audit.md` within the 60-minute audit cap.
- Log `compaction gap`: `agent/conversation_compression.py:3091` uses `event_callback('session:compress', ...)`; `gateway/platforms/api_server.py:2134-2151` does not wire this callback. No registered plugin compaction hook exists.
- Log `skill wiring gap`: `apps/melete/src/jobs/bundle.ts:291-293` emits empty tools, skills and knowledge; selection helpers passing tests do not prove automatic selection in a running job.
- Command `bun run packages/runtime-hermes/scripts/audit-contracts.ts`: exit 0, with a valid `turn_started` control; `runtime_hook_event=false`, `runtime_hook_error=false`, `persisted_hook_event=false`, `responsibility_hook_event=false`, `shared_space_kind=false`, `space_qualified_memory_audience=false`, `skill_audience_round_trip=false`.
- Log `slice 2 STOP`: `.agents/notes/proposed/2026-09-12-w14-durable-hook-contract.md` specifies the additive event and observer bridge requirements; no frozen contract or runtime implementation was changed.
- Log `slice 3 STOP`: `.agents/notes/proposed/2026-09-12-w14-principal-membership-contract.md` specifies principal identity, compatible setup, membership, audience, generation and revocation requirements; no partial multi-principal authority was shipped.
- Command `bun run test:plugin`: exit 0, `20 passed in 10.57s`.
- Command `bun run lint`: exit 0, `Checked 307 files in 1446ms. No fixes applied.`; this preceded the final proposal/diagnostic edits and will be checked again.
- Command `bun run typecheck`: exit 0, `tsc -b && tsc -p apps/web/tsconfig.json --noEmit`; this preceded the final diagnostic control edit.
- Command `bun run compose:check`: exit 0, `compose:check passed (12 checks)`; no Docker runtime isolation claim is made.
- Command `bun test --max-concurrency=2`: baseline run exceeded the three-minute budget and did not finish; it stopped making progress after entering `apps/melete/test/integration/gateway.test.ts`. The captured log is `%TEMP%/melete-w14-baseline-tests.log`.
- Test `two writes to one space at the same time > all of them land, each in its own commit, each attributed to its own caller`: baseline timeout after 5000ms (`5422.00ms` reported), followed by cleanup-related `ENOENT` for `index.md` and `fatal: not a git repository` in its still-running work.
- Test `two writes to one space at the same time > a record carries the trailer of the write that made it, not of its neighbour`: baseline timeout after 5000ms (`5984.00ms` reported).
- Test `persisted event streams > duplicate event delivery emits one stored row and no duplicate frame`: baseline `beforeEach/afterEach hook timed out` (`5016.00ms` reported).
- Command `taskkill.exe /PID 29716 /T /F`: stopped only the W14 test process after verifying its exact command and creation timestamp `2026-09-12T01:15:21.469069+05:30`, together with its disposable Postgres descendants; other lanes' test processes were preserved. Baseline results remain partial, not green.
- Command `git -C C:/Users/gamin/melete-oss-w14 fetch origin integration`: exit 0; the refreshed integration head is still `9484023cabd32b786cb4d336dec818f441cd0cc1`.
- Command `gh pr list --repo ychampion/melete --state all --limit 60 --json number,title,headRefName,baseRefName,state,mergedAt`: W10c/W11/W12 are not integrated; the only matching execution PR shown was open W10a PR #11. Slices 4 and 5 remain gated.

## Focused verification — 2026-09-11 20:11 UTC

- Command `bun test packages/knowledge/src/space.test.ts --test-name-pattern 'two writes to one space' --max-concurrency=2`: exit 0; `3 pass`, `0 fail`, `22 expect() calls`, `[10.49s]`; the two baseline space-write timeouts did not recur in isolation. No implementation fix was made.
- Command `bun test apps/melete/test/integration/events.test.ts --test-name-pattern 'duplicate event delivery emits one stored row and no duplicate frame' --max-concurrency=2`: exit 1; the named test assertion passed in `1235.00ms`, but teardown reported `(fail) persisted event streams > (unnamed) [5015.00ms]` and `a beforeEach/afterEach hook timed out for this test`; final `1 pass`, `1 fail`, `[28.41s]`. This existing fixture failure remains unresolved; it is not a green deduplication suite.
- Command `bun test packages/runtime-hermes/src packages/skills/src --max-concurrency=2`: exit 0; `67 pass`, `0 fail`, `165 expect() calls`, `[4.10s]`. This is the executed evidence for the narrower adapter and selector rows, not the requested real-Hermes capability proof.
- Command `python packages/runtime-hermes/scripts/audit-pin.py .hermes-src`: standalone rerun exit 0; all 37 registered names have literal dispatch references; final log `Literal dispatch sites do not establish HTTP reachability or durable delivery.`
- Log `docs/CAPABILITIES.md`: all nine requested capabilities are marked `missing` with concrete wiring/contract/dependency reasons; existing narrower behaviors carry exact executed test names and their limits.

## Final checks and stop decision — 2026-09-11 20:14 UTC

- Command `bun run lint`: final exit 0; `Checked 308 files in 955ms. No fixes applied.`
- Command `bun run typecheck`: final exit 0 for `tsc -b && tsc -p apps/web/tsconfig.json --noEmit`.
- Command `bun run packages/runtime-hermes/scripts/audit-contracts.ts`: final exit 0; all seven missing-contract probes remain false after the valid control parses. These results establish the contract stop, not implemented capabilities.
- Command `git -C C:/Users/gamin/melete-oss-w14 diff --check`: exit 0, no whitespace errors.
- Command `git -C C:/Users/gamin/melete-oss-w14 diff --name-only -- packages/contracts`: empty output; frozen contracts are untouched.
- Command `git -C C:/Users/gamin/melete-oss-w14 --git-dir=C:/Users/gamin/melete-oss-w14/.hermes-src/.git --work-tree=C:/Users/gamin/melete-oss-w14/.hermes-src status --short`: empty output; the audited upstream checkout is unmodified.
- Command `git -C C:/Users/gamin/melete-oss-w14 fetch origin integration`: final exit 0; `git -C C:/Users/gamin/melete-oss-w14 log -5 --format='%H %s' origin/integration` still begins at `9484023cabd32b786cb4d336dec818f441cd0cc1`.
- Command `gh pr list --repo ychampion/melete --state all --limit 60 --json number,title,headRefName,baseRefName,state,mergedAt`: the final dependency check still shows only open W10a PR #11 among W9/W10/W11/W12 matches; W10c/W11/W12 are unavailable on integration.
- Log `slice 1`: pinned audit, reproducible source/contract diagnostics and the capability matrix are complete. `README.md` accurately calls shared-space/revocation primitives unimplemented and the invitation UI outside v0.1.
- Log `slices 2 and 3`: stopped at the explicit frozen-contract rule with the two proposals under `.agents/notes/proposed/`; no runtime, database, service, fixture or contract implementation was changed.
- Log `slices 4 and 5`: stopped at the dependency gate; the single real-local-Hermes capability-chain test does not exist or pass in this lane. The W3 real-server script was not run and no provider credentials were used.
- Log `DONE not met`: the full suite is not green and the requested capability proof remains missing. The authorized stop outcome is a draft PR to `integration`, with this report and the final matrix; no merge is requested or performed.
