# W15 assistant wiring

## Assumptions

- SHA `9484023`: the DONE requirement selects PR base `integration`; it takes precedence over the generic instruction naming `main`.
- Command `git -C C:/Users/gamin/melete-oss-w15 diff origin/integration...origin/lane/w14-capabilities -- apps/melete/src/jobs/bundle.ts`: no bundle changes on W14 at startup; W15 owns additive wiring and the integrator should check later overlap.
- SHA `9484023`: no principal membership column or W9 `since_last` implementation exists; selection uses the job's space and the delta reads durable rows.
- Command `bun install`: succeeded, 372 packages installed; embedded-postgres 17.10.0-beta.17 is already a service devDependency.
- Command `Get-Item .hermes-src, .hermes-venv`: neither local engine directory exists in this worktree; provision a fresh pinned local engine here without touching other worktrees.
- Log `2026-09-11 20:38:42 UTC`: campaign started; the five-hour deadline is 2026-09-12 01:38:42 UTC.

## Initial inspection

- SHA `9484023`: read architecture, runtime and memory contracts, decision notes, service entry point, bundle/runner, memory wrapper and Hermes e2e launcher; broker catalog and context recording require a committed attempt identity.

## Slice 1 progress

- Command `git -C C:/Users/gamin/melete-oss-w15 clone --depth 1 --branch v2026.9.7 https://github.com/NousResearch/hermes-agent.git .hermes-src`: resolved `2237be355906fbe6065ce1815711eee52b2d646e`, matching the pinned engine.
- Command `uv venv .hermes-venv --python 3.12` and `uv pip install --python .hermes-venv/Scripts/python.exe -e ./.hermes-src`: succeeded locally; 67 packages installed.
- Command `bun run typecheck`: first run rejected ES2023 `findLast` under this repo's target; fix cycle 1 uses reversed-array `find`.
- Test `context assembly > every knowledge excerpt carries where it came from`: first run caught a formatting regression for legacy excerpts without handles; fix cycle 1 preserves their existing rendering and prefixes handles only when present.

- Test `bundle assembly > three selected skills, two handled claims and durable briefs stay in their space`: passes 14 assertions after correcting two fixture assumptions: recall matches claim/source terms (`travel`), and the test connector exposes `test.send`, not `test.read`.
- Log `a beforeEach/afterEach hook timed out`: the new test's unnamed cleanup exceeded Bun's default five seconds outside the lock; cleanup now has a bounded 30-second hook, awaiting the locked full-suite result before classifying a timeout.
- Command `bun run typecheck`: passed after fix cycle 1; commands `bun run lint`, `bun run openapi`, `bun run client:generate`, and `bun run compose:check`: passed (309 linted files, 12 Compose checks; generated schemas unchanged for the new runtime-only optional field).
- Command `until mkdir C:/Users/gamin/.melete-test.lock ...`: queued the full suite with an EXIT trap; the lock was held by another active test process. Unreferenced launcher/startup modules are being prepared while the slice-1 test inputs remain stable.

## Launcher preflight

- Command `bun run .agents/probe/w15-launch.ts`: first startup found `API Server: aiohttp not installed`; command `uv pip install --python .hermes-venv/Scripts/python.exe aiohttp==3.14.3` follows the pinned engine's HTTP dependency.
- Command `bun run .agents/probe/w15-launch.ts`: startup passed on retry with log `Pinned Hermes startup: 16391 ms`; log `Owned process tree stopped` confirms launcher cleanup. No model call was made.

## Entry point progress

- Command `bun test apps/melete/src/index.test.ts apps/melete/test/integration/runner.test.ts apps/melete/test/integration/bundle-assembly.test.ts --max-concurrency=2`: 35 pass, 0 fail, 222 assertions in 38.03 seconds, including `bootstrap starts migrated durable dependencies and the configured stub worker`.
- Commands `bun run typecheck`, `bun run openapi` and `bun run client:generate`: passed with the optional context diagnostics and health adapter fields; migration `0015_famous_nova.sql` records the empty default diagnostics array.
- Log `2026-09-11 21:20:56 UTC`: the full-suite process still waits for the shared lock; preparing the launcher while queued. The first locked run will cover both bundle assembly and entry-point wiring.

## HTTP proof progress

- Test `skills, handled recall, delta and correction repair reach the model from bootstrap`: first run reached Hermes and the gateway but returned `HTTP 429: token_cap_exceeded`. The existing gateway reserves input bytes plus requested output against `max_output_tokens`; the default 8,000 cannot admit the engine prompt. Fix cycle 1 gives this fake-provider fixture an explicit 200,000 token reservation, initializes its space repository, and reads context handles from the existing `items` column.
- Command `bun run typecheck`: passed after connecting the supervisor and the HTTP proof. Docker execution remains unverified on this host.
- Test `skills, handled recall, delta and correction repair reach the model from bootstrap`: fix cycle 2 initializes the disposable space with `git -C <fixture> init --quiet`; the legacy `initSpace` helper accepts lowercase names, while durable space IDs contain uppercase ULIDs. This keeps the production ID contract intact.
- Command `bun test apps/melete/src/runtime/supervisor.test.ts --max-concurrency=2`: 7 pass, 0 fail, 22 assertions in 3.50 seconds, including rejection of external Docker networks, wrong engine pins, path traversal and linked workspaces, plus actual parent-and-child process termination on Windows.
- Test `skills, handled recall, delta and correction repair reach the model from bootstrap`: the third focused run failed during cleanup with `EBUSY ... rm ... melete-runtime-pbIUhl` after 93.985 seconds. The proof has consumed its two fixture-fix cycles; no further focused proof retries. Continue documentation and launcher teardown review, then use the required locked suite to determine the final proof result. This unlocked run is not reported as a reproduced timeout.
- Command `bun run compose:check`: 16 checks passed; command `bun test deploy/scripts/compose-check.test.ts --max-concurrency=2`: 13 pass, 0 fail, including rejection of static attempt tokens and default stub selection.

## Runtime review and documentation

- Log `melete-runtime-pbIUhl/logs/agent.log`: the fake model completed two calls, but the pinned registry rejected the plugin's bare dictionary (`tool_result_contract`), and an auxiliary title request lacked the capability header. The plugin registration now serializes broker results as text, and the thin config disables title generation and background review using the pinned engine's supported settings.
- Command `python -m pytest packages/runtime-hermes/tests/test_plugin.py -q`: 21 passed in 10.83 seconds, including the new registered-handler text-contract check. The Hermes venv omits pytest; the existing system test environment supplies it.
- Log `EBUSY ... rm`: runtime teardown now defers a busy temporary-home deletion after the owned process tree stops, preserving the engine outcome; service close retries deferred cleanup and reports any retained path. No unrelated processes or directories were changed.
- Command `Get-CimInstance Win32_Process -Filter Name=bun.exe`: another full suite held the shared lock at 2026-09-11 21:39 UTC; W15 remains queued. README, architecture section 6, memory startup guidance and note `0022-wired-assistant.md` now describe the connected path and verification limits.
- Test `a parked tool leaves the lease live until the runner records its outcome`: reproduced the broker moving `running` to `waiting_for_approval` before runner finalization. The production boundary now defers that transition to the runner; the standalone broker default is preserved.
- Command `bun test apps/melete/test/integration/runtime-handoff.test.ts --max-concurrency=2`: passes 10 assertions after the handoff fix, including a corrected revision receiving a fresh approval and the obsolete unadmitted action being refused with `job_revision_changed`.
- Command `bun test apps/melete/src/index.test.ts apps/melete/test/integration/runner.test.ts apps/melete/src/runtime/supervisor.test.ts packages/runtime-hermes/src/client.test.ts --max-concurrency=2`: 66 pass, 0 fail, 279 assertions in 55.54 seconds. Command `bun run typecheck`: passed after correcting an optional test assertion.
- SHA `02d7f6a`: committed bundle assembly and additive delta contract. Push awaits the required full-suite run; the shared lock is still occupied.
- Command `bun test apps/melete/test/integration/broker.test.ts apps/melete/test/integration/effects.test.ts --max-concurrency=2`: 32 pass, 0 fail, 194 assertions in 41.46 seconds after the approval handoff and revision-binding changes.
- Commands `bun run lint`, `bun run openapi`, `bun run client:generate` and `bun run test:plugin`: passed; lint checked 315 files and the pinned plugin command passed 21 tests in 11.23 seconds.
- Command `bun install`: regenerated the lockfile for the service's explicit production `yaml` dependency; Docker's service manifest layer now includes every workspace manifest before its frozen production install.

## Final review

- Test `a parked tool leaves the lease live until the runner records its outcome`: review found that a failed effect could be rebound after a correction. Rebinding now applies only to proposed, approval-waiting, approved or denied actions; a failed dispatch retains its action ID. The added regression assertion passed (13 assertions, 55.08 seconds for the focused command including database setup and cleanup).
- Command `bun run typecheck`: passed after the failed-effect identity guard. Commands `git -C C:/Users/gamin/melete-oss-w15 diff --check` and `git -C C:/Users/gamin/melete-oss-w15 diff --cached --check`: passed.
- Log `2026-09-11 22:11:27 UTC`: W15 remains queued for the shared full-suite lock. The full-suite log has not been created; no full-suite result or timing is claimed yet.
- Log `2026-09-11 22:30:31 UTC`: the shared lock has changed hands repeatedly, most recently at 22:29:42 UTC, while W15's original `until mkdir ... sleep 15` command remains queued. No other lane's lock or process was changed; the full-suite log is still absent.
- Log `2026-09-11 22:59:57 UTC`: the full-suite log remains absent. Command `Get-CimInstance Win32_Process -Filter Name=bun.exe` confirmed another test process remained active; W15 continues waiting without modifying its lock or process. Implementation and staged entry-point files are unchanged.
- Test `a restrictive service umask cannot remove runtime-group workspace access`: review found that `mkdir(0770)` alone loses group write under a restrictive service umask. New job directories now receive explicit group permissions after path verification. Command `bun test apps/melete/src/runtime/supervisor.test.ts --max-concurrency=2`: 7 pass, 1 POSIX-only skip, 0 fail, 22 assertions in 1.49 seconds; actual POSIX mode behavior and Docker execution remain unverified on Windows.
- Log `2026-09-11 23:10:07 UTC`: W15 acquired the shared lock and started `bun test --max-concurrency=2`, covering the final working tree. The preceding wait began at 20:48:39 UTC and is excluded from test execution time.

## Locked full-suite result

- Command `bun test --max-concurrency=2` under the shared lock: **915 pass, 1 skip, 14 todo, 0 fail**, 3,871 assertions across 77 files, reported duration **257.20 seconds**. The EXIT trap released W15's lock after completion. The skip is the POSIX permission assertion on Windows; the 14 conformance todos already existed at SHA `9484023`.
- Test `skills, handled recall, delta and correction repair reach the model from bootstrap`: **passed** in 37.032 seconds using the real pinned Hermes server and only a scripted model provider. HTTP authentication, job creation, three selected skills, two handled claims, durable delta, correction repair, new attempt tokens and context `style_violations` were verified.
- Log `wired Hermes att_01M29BZ9JV3H75BVZ7JD0074ES: cold=10067ms wall=19980ms`; log `wired Hermes att_01M29BZXN21CCWWPQVEE466XBX: cold=8426ms wall=14951ms`.
- Command `bun test --max-concurrency=2`: the requested 180-second duration target remains **unmet** on this host. Time outside the 37.032-second HTTP proof was approximately 220.17 seconds. This is a timing limitation; the locked run had no failed tests.
- Command `bun run typecheck`: passed after the workspace permission fix; the supervisor's focused checks passed with the explicit Windows skip described above. Docker build, socket access, volume-subpath behavior and actual network isolation remain **unverified** because Docker is unavailable here.

## Slice publication

- SHA `02d7f6a`: bundle assembly pushed to `origin/lane/w15-wire` after the locked full suite passed.
- SHA `731bdbe`: entry point, memory startup, context diagnostics and generated contracts committed and pushed. Its intermediate adapter uses the existing static endpoint; the following launcher slice replaces that endpoint with supervised instances. The focused entry-point tests and final-working-tree locked suite passed.
- SHA `76dccfe`: process and Docker supervisors, default Compose wiring, per-attempt credentials, process-tree teardown, broker handoff and retry identity guards committed and pushed. The locked suite, Python plugin checks and static Compose checks passed; Docker execution remains unverified.
- SHA `18c6724`: the passing HTTP-to-Hermes integration proof committed and pushed. Commands and measured cold-start and attempt times are recorded in the locked-suite section above.
- SHA `46175f2`: architecture section 6, README startup guidance, memory entry-point documentation, runtime continuity guidance and note `0022-wired-assistant.md` committed and pushed.

## Final state

- Command `gh pr create --repo ychampion/melete --base integration --head lane/w15-wire`: opened [PR 21](https://github.com/ychampion/melete/pull/21). Command `gh pr view 21` verified `OPEN`, base `integration`, head `lane/w15-wire`, and no reported automated status checks.
- SHA `46175f2`: all five requested slices are published in order. The functional HTTP-to-Hermes path is verified by the locked suite: 915 passing tests, 0 failures, one explicit Windows skip and 14 existing todos.
- Command `bun test --max-concurrency=2`: the suite's 257.20-second duration exceeds the 180-second target. That timing requirement remains unmet; Docker execution remains unverified on this Windows host as expected by the brief.
- Test `skills, handled recall, delta and correction repair reach the model from bootstrap`: uses the scripted provider and an explicit 200,000-token reservation. The gateway's current 8,000 default can reject the Hermes prompt. Context `style_violations` is recorded as an empty array; no prose style checker is configured.
- Commands `bun run typecheck`, `bun run lint`, `bun run openapi`, `bun run client:generate`, `bun run compose:check`, `bun run test:plugin` and the locked full test command passed their functional checks. The later changes are documentation and this report only; no additional full-suite run was required.
- Log `2026-09-11 23:21:04 UTC`: final publication verification occurred within the five-hour campaign cap. No other worktree, shared lock owner or unrelated process was modified; no force push or merge was performed.

## Review fixes — 2026-09-12

### 1. Separate context and output allowances

- `bun test apps/melete/src/gateway/index.test.ts --test-name-pattern 'default output ceiling' --max-concurrency=1`: exit 1, expected regression reproduced (0 pass, 1 fail, 15 filtered); a default output ceiling rejected valid input with HTTP 429.
- Input admission now uses the optional `max_input_tokens`, defaulting to the pinned model context window minus output capacity. The gateway stores estimated input and its allowance in the request event; the output ledger reserves requested output and settles actual output. Unknown output usage retains its reservation. Input context is a per-request bound, not a cumulative output charge.
- The supervised adapter returns `budget_exhausted` with the named `input_context_exceeded` summary before engine launch when the assembled prompt plus conservative engine framing cannot fit. The gateway rechecks the final encoded request before provider admission and returns the same named error (HTTP 413).
- `bun test apps/melete/src/gateway/index.test.ts apps/melete/test/integration/budget.test.ts apps/melete/src/runtime/hermes.test.ts packages/contracts/src/model-budget.test.ts --max-concurrency=1`: exit 0, 24 pass, 0 fail, 106 assertions (11.95s). The first combined run had one outdated output-accounting expectation (21 pass, 1 fail); it was corrected from total-token to output-token usage.
- The HTTP proof now posts a job without a budget and asserts output 8,000 and resolved input 120,000.
- `bun run typecheck`: exit 0 after correcting the new admission test's `EventSink` fixture.
- `bun run openapi && bun run client:generate`: exit 0; additive input fields generated.
- `bun test apps/melete/test/integration/wired-assistant.test.ts --max-concurrency=1`: exit 0, 1 pass, 0 fail, 52 assertions (184.15s overall; test 143.031s). Both real Hermes attempts reached the expected approval outcome with the default budget.

### 2. Assert the actual container launch boundary

- `bun test apps/melete/src/runtime/supervisor.test.ts --max-concurrency=1`: exit 0, 7 pass, 1 Windows skip, 0 fail, 32 assertions (2.62s).
- The real `dockerRunArguments` test requires non-root `10001:10001`, read-only, `cap-drop ALL`, `no-new-privileges:true`, PID limit 256 and memory 2g. Removing any flag or changing its required value fails this test.
