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
