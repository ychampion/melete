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

## Delivery and final stop — 2026-09-11 20:14 UTC

- SHA `65a5d8a4e8c1b658765163b93bd67fb48ea2cabf`: committed the pinned audit, two diagnostics, two frozen-contract proposals, capability matrix, README correction and report. `git -C C:/Users/gamin/melete-oss-w14 log -1 --format='%H%n%an <%ae>%n%cn <%ce>%n%s'` confirms both author and committer are `ychampion <68075205+ychampion@users.noreply.github.com>`.
- Command `git -C C:/Users/gamin/melete-oss-w14 push -u origin lane/w14-capabilities`: exit 0; the lane branch now tracks `origin/lane/w14-capabilities`. No force push or push to main occurred.
- Command `gh pr create --repo ychampion/melete --base integration --head lane/w14-capabilities --draft --title 'Audit Hermes capabilities and document the blocked proof' --body-file <temp-body>`: exit 0; created https://github.com/ychampion/melete/pull/13.
- Command `gh pr view 13 --repo ychampion/melete --json number,url,baseRefName,headRefName,headRefOid,isDraft,state`: verified `state=OPEN`, `isDraft=true`, `baseRefName=integration`, `headRefName=lane/w14-capabilities`, and audit head `65a5d8a4e8c1b658765163b93bd67fb48ea2cabf` before this append-only report commit.
- Log `final stop`: resume slices 2/3 only after the frozen-contract additions are available; integrate W10c/W11/W12 before slices 4/5; resolve the recorded fixture timeout and run the full suite plus the single real-Hermes capability-chain proof. No passing end-to-end claim or merge is made.

PROOF PENDING: waiting for W10c/W11 to merge

## Resumed authorization — 2026-09-11 20:19 UTC

- Log `orchestrator steering`: additive contract changes are now authorized, including `hook_event`, `hook_error`, principals, memberships, shared spaces and the skill-selector bundle wiring. This supersedes the earlier additive-contract stop; breaking changes still require a proposal and stop.
- Command `until mkdir C:/Users/gamin/.melete-test.lock 2>/dev/null; do sleep 15; done`: every subsequent full `bun test` run will acquire the shared directory lock and release it with `rmdir` on success or failure. Focused runs remain unlocked.
- Log `timeout qualification`: the earlier full-suite and focused teardown timings were obtained without the new full-suite lock. They are historical observations, not a reproduced serialized-suite timeout; only a timeout reproduced under the lock will be reported as a current suite failure.
- SHA `2d3ca94eb5c07d8ddb662d22ce35d203e61b4972`: resumed from the clean pushed W14 branch, solo at xhigh, with draft PR #13 already open to integration.

## Slice 2 implementation checks — 2026-09-11 20:46 UTC

- Command `bun run test:plugin`: `24 passed in 10.35s`, including registered hook ordering, erased payload values, observer exception isolation and copied thread-context isolation.
- Command `bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2`: exit 0; `47 pass`, `0 fail`, `124 expect() calls`, `[32.37s]`. The database test persists adapter observations, redelivers each event and replays from a stored cursor.
- Command `python packages/runtime-hermes/patches/observer_bridge.py .hermes-src`: applied the three hash-checked observer seams and shared capture module. The source patch adds actual committed compaction observation and per-run HTTP queue binding; it does not change tool decisions.
- Command `uv venv .hermes-venv --python 3.12`, followed by `uv pip install --python .hermes-venv/Scripts/python.exe -e ./.hermes-src` and the pin's `aiohttp==3.14.3`: prepared the local real-server environment. Provider secrets are removed from its child environment; title generation and background review are disabled.
- Test `real Hermes persists lifecycle hooks and a throwing observer without stopping the tool run`: two attempts exposed an empty test catalog. Logs showed `melete: the broker served no tools`; the fixture had requested nonexistent `test.read`. A speculative startup-preload change was removed; the final fixture uses the existing `files.read` connector and checks its catalog before launching Hermes. This is the second and final allowed fix cycle for this check.

- Command `MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`: final permitted rerun exit 1, `[61.76s]`; 16 assertions reached, including real session/turn/pre-tool/post-tool/end hooks, persisted `hook_error`, duplicate redelivery and redaction. The final action count was `0`, expected `1`.
- Log `%TEMP%/melete-e2e-home-GREKKk/logs/agent.log:89`: `Tool files.read handler returned unsupported result type: dict`; the existing forwarder returns dictionaries while the pinned registry requires its supported tool-result representation. No successful broker effect or green real-server test is claimed. Two fix cycles are exhausted; this remaining failure is recorded while W14 proceeds to slice 3.

## Slice 3 authority and bundle checks — 2026-09-11 21:15 UTC

- Command `bun run db:generate`: generated `0015_petite_demogoblin.sql` and its snapshot; the reviewed migration adds principals, memberships and optional bindings, then backfills the installation owner, spaces, jobs, sessions and submission ownership. Old attempts retain null bindings so an already issued personal-space capability remains compatible.
- Log `principal authority`: authenticated request identity now scopes job lists, detail reads, event pages, reset snapshots, knowledge/skill headers, approvals and related resources. New jobs, attempts and capability tokens carry the principal and membership generation; shared admission rejects missing or mismatched bindings.
- Log `membership revocation`: the service transaction advances space policy and membership generation, invalidates memory contexts/prepared outputs, persists `context_invalidated`, fences active attempts and cancels the revoked member's queued/waiting work. Regrant advances membership generation again; old capabilities remain stale.
- Test `single-owner authentication against Postgres`: all ten existing authentication cases passed in the initial focused run, including racing setup, password verification, persistent sessions, cookie flags and origin rejection. The combined command did not finish green because the new test's asynchronous rejection matcher required diagnosis.
- Log `principal test diagnosis`: PostgreSQL reported `idle in transaction`, `ClientRead`, query `begin`, and no blocking PIDs while the asynchronous rejection matcher waited. Explicitly awaiting each operation and asserting the caught error code restored progress; the first implementation fix cycle passed the whole scenario in `2109.00ms` with `61 expect() calls`.
- Command `bun test apps/melete/test/integration/principals.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2`: exit 0; `2 pass`, `0 fail`, `73 expect() calls`, `[13.78s]`. The extended scenario checks three selected skills, private-space/API isolation, broker and gateway refusal, stale queued work, regrant, private memory-source handles and invalidated delivered context.
- Command `bun run typecheck`: exit 0 after principal/API/bundle authority wiring; subsequent memory and migration-compatibility edits will receive final checks.
- Command `bun run openapi` and command `bun run client:generate`: both exit 0; the new principal/shared-space/membership paths and optional fields are generated into the published schemas and client types.
- Log `proof boundary`: the lifecycle real-server action assertion remains unverified; the new principal scenario uses the real service, broker, gateway budget, pg-boss and PostgreSQL with the scripted adapter. It does not establish the gated MCP/learning chain.

## Final review and serialized-suite queue — 2026-09-11 21:40 UTC

- Command `bun test apps/melete/test/integration/principals.test.ts --max-concurrency=2`: migration and membership scenarios passed, `2 pass`, `0 fail`, `75 expect() calls`, `[16.00s]`; later private-timeline and receipt-history guards await the final suite.
- Command `bun run typecheck`: exit 0 after the private-timeline and receipt-history changes. Command `bun run lint`: final review exit 0, `Checked 318 files in 1324ms. No fixes applied.` Command `git -C C:/Users/gamin/melete-oss-w14 diff --check`: exit 0.
- Command `bun run compose:check`: exit 0, all 12 configuration assertions pass; this is not a Docker network test. Command `python packages/runtime-hermes/scripts/audit-pin.py .hermes-src`: exit 0, the patched source exposes 38 hook names including `on_compaction`.
- Log `full-suite queue`: the guarded `bun test --max-concurrency=2` command is still waiting for `C:/Users/gamin/.melete-test.lock`. Live process inspection shows another lane's Bun test process; W14 has neither removed its lock nor interrupted it. No serialized-suite timeout is claimed before W14 acquires the lock and runs.
- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1`: a fresh `git -C C:/Users/gamin/melete-oss-w14 fetch origin integration` leaves integration at the same base. Command `gh pr list --repo ychampion/melete --state all --limit 60 --json number,title,headRefName,baseRefName,state,mergedAt` now shows W10c PR #15 open, W12 PR #12 open, and no merged W11. Slices 4 and 5 remain dependency-gated.

## Assumptions — reviewed implementation

- Log `shared audience`: shared-space membership exposes published skills and knowledge; each job and its timeline remain private to its own principal, including within a shared space. This prevents membership from exposing an owner's private attempt context before the evaluated-sharing pipeline exists.
- Log `additive migration compatibility`: old personal-space attempts keep null principal bindings so pre-upgrade signed capabilities remain usable; new shared-space attempts require both principal and membership generation, and all newly issued attempts record their binding.

## Serialized full-suite result — 2026-09-11 22:01 UTC

- Command `bun test --max-concurrency=2` acquired `C:/Users/gamin/.melete-test.lock` at approximately 21:57 UTC and ran as W14 PID `39596`. The watchdog stopped that test tree after the 180-second budget; exit `124`. The wrapper released its own lock in `finally`.
- Log `%TEMP%/melete-w14-locked-full.stderr.log`: `376` passing test lines, `0` failing test lines and `0` error lines before the budget stop, ending during `packages/knowledge/src/retraction.test.ts`. This is a reproduced serialized-suite budget failure, not a completed green suite. The run had not yet reached the new principal integration test.
- Log `process cleanup`: the tracked Bun PID `39596`, embedded PostgreSQL parent `32876`, and transient child `6788` are absent after the watchdog. No other lane's test process or lock was interrupted.
- Command `bun test apps/melete/test/integration/principals.test.ts apps/melete/test/integration/hooks.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2`: started the final focused run after the full-suite wrapper exited. It includes private shared-job timelines and submission receipt isolation, including marker-only recovery after fixture receipt rows are removed.

## Final W14 focused proof — 2026-09-11 22:03 UTC

- Command `bun test apps/melete/test/integration/principals.test.ts apps/melete/test/integration/hooks.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2`: exit 0, `4 pass`, `0 fail`, `96 expect() calls`, `[79.59s]`. This executed the latest private shared-job timeline and marker-only submission receipt assertions as well as the migration, membership, stale capability, bundle selection, invalidation, deduplication and replay checks.
- Test `additive migration preserves the setup guard, login and an issued personal-space capability`: passed in `2344.00ms`. Test `member bundles select at most three shared skills; revocation fences work, replay, knowledge and old capabilities`: passed in `1547.00ms`. Test `adapter capture persists in order, deduplicates delivery and replays from the stored cursor`: passed in `1329.00ms`.
- Log `full-suite budget`: the serialized run had no assertion failure to repair before the budget stop. W14 is checking the affected existing API, job, event and broker suites separately; the incomplete full result remains explicitly red in `docs/CAPABILITIES.md` and the draft PR description.

## Existing-suite regression and first fix cycle — 2026-09-11 22:06 UTC

- Command `bun test` with the selected authentication, jobs, runner, events, replies, submissions, waits, attention, responsibility, broker and knowledge-route files: the knowledge, attention, authentication and broker checks pass. Event-router cases fail with `TypeError: undefined is not an object (evaluating c.get("owner").id)` because those standalone module fixtures do not mount the authentication middleware.
- Log `event identity fix cycle 1`: `apps/melete/src/api/events.ts` now captures `requestPrincipal()` from the same server-owned async context used by the service filters. The real app's authentication middleware establishes that identity; background stream delivery retains the captured principal. Direct internal module fixtures remain usable without an HTTP authentication fixture. The running command had already imported the old module; its event/reconnect failures will be rerun in a fresh process alongside the actual authenticated principal-isolation test.

## Receipt recovery binding and affected rerun — 2026-09-11 22:09 UTC

- Command `bun test` for the 11 selected existing suites completed with `153 pass`, `15 fail`, `1 error`, `1045 expect() calls`, `[254.47s]`. Thirteen failures share the event module's missing-context error; two receipt recovery cases returned `403` instead of their established `503 unknown_durability` response. Authentication, knowledge routes, attention, broker admission, job transitions, attempt execution, replies and waits passed.
- Test `receipt_missing yields unknown durability and never admits another job` and test `marker_only yields unknown durability and never admits another job`: internal `SubmissionService.get` reconstructed the receipt without a principal, then the authenticated retry was refused. First fix cycle: carry the recorded principal from the receipt, journal or admission marker into the uncertainty row. Recovery never adopts an arbitrary request's identity.
- Test `member bundles select at most three shared skills; revocation fences work, replay, knowledge and old capabilities`: the marker-only fixture now also performs internal recovery before confirming that another principal is still refused. Command `bun test apps/melete/test/integration/events.test.ts apps/melete/test/integration/submissions.test.ts apps/melete/test/integration/responsibility.test.ts apps/melete/test/integration/principals.test.ts --max-concurrency=2` is the fresh affected rerun after both first-cycle fixes.
