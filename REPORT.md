# Documentation verification

## Assumptions

- SHA `9484023cabd32b786cb4d336dec818f441cd0cc1` is the documentation baseline: `HEAD` and `origin/integration` matched before edits.
- Command `bun install` completed: 372 packages installed; the existing `embedded-postgres` dependency needs no code change.
- Command scope follows the docs-only instruction: no source, contract, dependency, deployment or historical `.agents/notes/` edits.
- Command examples that need an account, application listener or Docker are replaced by executable fixture checks; Docker probes remain explicitly "written, not run" and no application servers are launched.
- Command `gh pr create --repo ychampion/melete --base integration --head lane/w13a-docs` follows the document-specific target over the conflicting generic target.
- Path `conformance/README.md` does not exist at the baseline SHA; create it as the second conformance README beside `conformance/memory/README.md`.
- Test fixtures may start disposable database and fake HTTP listeners; the no-server instruction is interpreted as no development or deployment servers.

## Initial inspection

- SHA `9484023`: `apps/melete/src/index.ts` mounts authenticated service routes with dependencies; `bootstrap` does not inject memory or a Hermes adapter.
- SHA `9484023`: `deploy/docker-compose.yml` puts runtime and Postgres on `internal`; `deploy/scripts/compose-check.ts` checks YAML only.
- Tests `conformance/scenarios/06-no-route-out.test.ts`, `07-retraction.test.ts`, `08-model-agnostic.test.ts` contain 14 `test.todo` assertions, not executed boundary proof.
- Command vocabulary audit returned no matches before documentation edits.

## Documentation and static checks

- Command `bun run typecheck`: exit 0; TypeScript build and web no-emit check passed.
- Command `bun run lint`: exit 0; `Checked 307 files in 894ms. No fixes applied.`
- Command `bun run openapi`: exit 0; generated `packages/contracts/openapi.json`.
- Command `bun run client:generate`: exit 0; generated `packages/client/src/schema.d.ts`.
- Command `bun run compose:check`: exit 0; `compose:check passed (12 checks)`; static configuration only.
- Command `bun test --max-concurrency=2` is queued behind the shared full-suite lock; no full-suite result is claimed yet.
- SHA `9484023`: audit also found stale public claims in `SECURITY.md`, `CONTRIBUTING.md`, module READMEs and `packages/runtime-hermes/README.md`; correcting these as documentation within the all-public-documents objective.
- Test command examples requiring a running application and fabricated IDs were replaced with complete fixture commands; account/container setup remains not claimed rather than represented by incomplete commands.

## Focused verification

- Command `bun test packages/client/src`: exit 0; `30 pass`, `0 fail`, 156 assertions, 7.05 seconds.
- Command `bun test packages/runtime-hermes/src`: exit 0; `42 pass`, `0 fail`, 101 assertions, 1.16 seconds; fake HTTP surface only.
- Command `bun test apps/mock-api/src/app.test.ts`: exit 0; `30 pass`, `0 fail`, 81 assertions, 3.57 seconds.
- Command `bun test apps/melete/src/connectors`: exit 0; `36 pass`, `0 fail`, 184 assertions, 8.71 seconds; temporary files and local protocols.
- Command `bun test apps/melete/test/integration/effects.test.ts`: exit 0; `10 pass`, `0 fail`, 78 assertions, 22.20 seconds; isolated embedded Postgres.
- Command `bun test apps/melete/test/integration/attention.test.ts`: exit 0; `4 pass`, `0 fail`, 66 assertions, 32.42 seconds; isolated embedded Postgres.
- Command `git -C C:/Users/gamin/melete-oss-w13a diff --check`: exit 0.
- Command generator-diff inspection found no changes in `packages/contracts/openapi.json`, `packages/client/src/schema.d.ts` or `bun.lock`.
- Test-reference audit matched 137 distinct literal test names plus the eight referenced assertions generated from `conformance/scenarios.ts`; local link and heading-anchor audit passed across 21 documentation files.
- SHA `9484023`: source files, contracts, deployment configuration, skill prompts and `.agents/notes/` remain unchanged.

## Memory and event evidence

- Command `bun test apps/melete/test/integration/memory.test.ts`: exit 0; `42 pass`, `0 fail`, 525 assertions, 79.84 seconds; no database skip.
- Command `bun run conformance:memory`: exit 0; `report.json` has `ok: true`, `database: embedded`, ten successful memory scenarios, ten expected failing withheld-memory runs, and one procedure-transfer todo.
- Log excerpt from `conformance/memory/report.json`: `counterfactual.checked: 10`, `memory_not_exercised: []`; obsolete, unsupported and needless-question counts are zero in every family.
- Log excerpt from the memory runner: maximum displayed correction-to-serving delay 54 ms; largest displayed family recall p95 30.02 ms; local fixture samples only, not service-level claims.
- Test `the gap in the event stream is recorded, and history is never shown as missing` checks stored text-delta rows; corrected documentation to reflect `AttemptRunner.emit` persistence despite the contract helper's non-durable label.
- Test `exactly one attempt is admitted for the duplicated timer` kills a child inside the transition transaction and separately deletes queued wakes; corrected documentation to distinguish rollback from committed-transition loss.
- Command `bun run conformance` completed its 26 assertions with 14 todos but returned exit 1 during fixture cleanup outside the shared lock; a serialized rerun is queued before treating it as a reproducible check failure.
- Command `bun test conformance/memory/breaks.test.ts`: exit 0; `4 pass`, `0 fail`, 14 assertions, 27.55 seconds; each deliberate break failed its scenario and reset restored the normal result.

## Supporting document commits

- SHA `0da8d3c`: `CONTRIBUTING.md`; executable evidence and contribution guidance.
- SHA `5592dfe`: `SECURITY.md`; tested boundaries and deployment limits.
- SHA `bef9eb4`: `apps/melete/src/api/README.md`; implemented routes and scope limits.
- SHA `a3b9f8e`: `apps/melete/src/broker/README.md`; admission and receipt evidence.
- SHA `2554e61`: `apps/melete/src/connectors/README.md`; fixture coverage.
- SHA `7881aad`: `apps/melete/src/events/README.md`; persisted text deltas and replay.
- SHA `b58e2c3`: `apps/melete/src/gateway/README.md`; forwarding checks and provider limits.
- SHA `1fdce6c`: `apps/melete/src/jobs/README.md`; durable state and recovery evidence.
- SHA `42f2a0a`: `apps/melete/src/knowledge/README.md`; file views and legacy scope limit.
- SHA `b550e6a`: `docs/mail-calendar.md`; local protocol fixtures and live-account limits.
- SHA `7a5ac65`: `packages/runtime-hermes/README.md`; adapter fixtures and unrun plugin/container work.
- Command `git diff --check` and the vocabulary audit passed after final review; each supporting-document commit contains exactly one Markdown file with the required identity.
- Command `bun test --max-concurrency=2` remains queued at 02:51 local; the shared lock moved to another active suite at 02:46, without modifying its lock or process.

## Primary evidence document commits

- SHA `b83f010`: `docs/MEMORY.md`; authority, correction, retrieval, restrictions and startup limits.
- SHA `2a43a72`: `docs/THREAT-MODEL.md`; exercised rejection gates and unrun container probes.
- SHA `a325ee4`: `docs/CLIENT.md`; typed requests, authentication, replay and UI limits.
- SHA `92db0ee`: `docs/CONNECTORS.md`; concrete connector evidence and account limits.
- SHA `3d44e56`: `docs/ENGINEERING.md`; E1–E7 implementation and falsifiers.
- SHA `2183e44`: `conformance/memory/README.md`; ten scenarios, seven executed families and withheld recall.
- Command `Get-Date` reported 02:50 local during the latest lock check; the preceding 02:51 timestamp was a transcription error. Both required serialized commands were still queued, with another full suite active.

## Serialized full-suite observations

- Command `bun test --max-concurrency=2` acquired the shared lock at 02:57:12 local.
- Log excerpt: `(fail) conformance 1: Due work survives a kill between the transition and the enqueue > (unnamed) [5016.00ms]`; `a beforeEach/afterEach hook timed out for this test.` This reproduces the fixture timeout under the lock.
- Log excerpt: `(fail) what the mediator refuses > an absolute path [7391.00ms]`; `a beforeEach/afterEach hook timed out for this test.`
- Command retry plan, fix cycle 1: increase the documented full-suite and service-scenario timeout to 15000 ms; keep concurrency at two and acquire the same shared lock. Source and fixture code remain frozen.

- Command `bun test --max-concurrency=2`: exit 1 under the shared lock; `900 pass`, `14 todo`, `2 fail`, `1 error`, 3762 assertions, 916 tests across 73 files, 628.07 seconds. No database skips were reported.
- Log excerpt from the interrupted mediation fixture: `GitError: git commit --quiet -m Create the personal space`; `failed (143): fatal: not a git repository (or any of the parent directories): .git`. The hook timed out and its dangling process was killed; this was not Windows exit `0xC0000142`.
- Command duration `628.07s` exceeds the requested three-minute full-suite target; this docs-only change does not repair baseline fixture performance.
- Command `kill -TERM 1369` stopped only this session's superseded, sleeping conformance waiter before it acquired the lock; the active suite and shared lock were left intact.
- Commands `bun test --max-concurrency=2 --timeout=15000` and `bun test --max-concurrency=2 --timeout=15000 conformance/scenarios` are queued as one serialized retry batch; README, architecture and service-conformance examples use these exact commands.

## Successful full-suite retry

- Command `bun test --max-concurrency=2 --timeout=15000`: exit 0 under the lock acquired at 03:13:01 local; `901 pass`, `14 todo`, `0 fail`, 3764 assertions, 915 tests across 73 files, 454.72 seconds. No skips or unhandled errors were reported.
- Test `what the mediator refuses > an absolute path` passed, and conformance 1 completed without the earlier fixture-hook timeout; the first timeout adjustment resolved both observed failures.
- Command duration `454.72s` still exceeds three minutes; passing assertions do not establish the requested full-suite runtime target.
- Command extraction from the nine primary documents found 16 distinct shell commands; the separate service-scenario command is the last one still running, and all other documented commands have successful results above.

## Completed documentation verification

- Command `bun test --max-concurrency=2 --timeout=15000 conformance/scenarios`: exit 0 in the same locked batch; `26 pass`, `14 todo`, `0 fail`, 168 assertions, 40 tests across eight files, 67.54 seconds. The batch released its lock on exit.
- Command extraction found 16 distinct commands in the nine primary guides; every one was executed as written and has an exit-0 result. The extra Hermes adapter command also passed.
- SHA `a6faec5`: `README.md`; six honest release gates, baseline status and executed commands.
- SHA `180303f`: `docs/ARCHITECTURE.md`; implemented boundaries and fixture evidence.
- SHA `e4da828`: `conformance/README.md`; executable scenarios 1–5 and explicit todos 6–8.
- Command `git -C C:/Users/gamin/melete-oss-w13a diff --check 9484023 HEAD`: exit 0; the final change list contains exactly 20 public Markdown documents before this report.
- Command vocabulary audit returned zero matches after all public-document commits.
- SHA `9484023` source, contracts, generated artifacts, deployment files, skill prompts and historical `.agents/notes/` remain unchanged; no application server or Docker container was launched for this lane.

## Publication

- Command `git -C C:/Users/gamin/melete-oss-w13a push -u origin lane/w13a-docs`: exit 0; published the 20 document commits through SHA `e4da828`.
- Command `gh pr create --repo ychampion/melete --base integration --head lane/w13a-docs`: exit 0; opened [PR #17](https://github.com/ychampion/melete/pull/17) against `integration`.

## Final

- SHA `e4da828` completes the 20 public-document commits; this `REPORT.md` is the separate final documentation record. Every document commit uses the required identity and a plain-prose message.
- Commands in the nine primary guides: all 16 distinct commands executed as written and passed; named-test references, local links, heading anchors, whitespace and vocabulary checks passed.
- Command `bun test --max-concurrency=2 --timeout=15000`: 901 pass, 14 todo, zero failures or skips; command `bun test --max-concurrency=2 --timeout=15000 conformance/scenarios`: 26 pass, 14 todo, zero failures.
- Command `bun run conformance:memory`: ten scenarios passed, ten withheld-memory runs failed as expected, one procedure-transfer todo; the four falsifier tests passed.
- Tests in service scenarios 6–8, the procedure-transfer scenario, Python plugin tests and container execution remain **written, not run** for this verification; real-provider compatibility and complete installed-assistant behavior remain **not claimed**.
- Command duration 454.72 seconds leaves the three-minute full-suite target unmet. Fix cycle 1 addressed the reproduced hook timeouts through documented command flags; no source or fixture changes were made.
- Command `gh pr create` opened the requested PR to `integration`; merging is outside this completed documentation change.
