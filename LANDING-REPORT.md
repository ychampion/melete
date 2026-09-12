# Landing report

Trial integration on `landing` only. Source baseline: `9484023cabd32b786cb4d336dec818f441cd0cc1`. PR heads and branch names were verified through GitHub before merging. No PR was merged through GitHub.

## Assumptions

- The requested worktree already existed, clean on `landing` at `origin/integration`, so it was reused without modifying another checkout.
- Migrations are ordered by the production journal. Additional migrations in the current PR heads are preserved and assigned the next available index.
- This landing run uses one Bun test process at a time. After waiting for repeated independent runs to finish, focused tests use the brief's no-lock rule; other agents control their own processes. Full suites acquire the shared directory lock and remove only this run's marker and lock on exit.
- Test evidence is local and uses disposable fixtures. Optional credential-dependent or container proofs are reported separately from passing local checks.

## Merge ledger

| Order | PR | Branch | Merge commit | Migrations | Checks and result |
| --- | --- | --- | --- | --- | --- |
| 1 | #16 | `fix/production-review-astra-20260912` | `c25c265cd986217938ca99ab0ef43e114508ce49` | None | Typecheck, lint, clean regeneration; plugin 20; Compose 12; focused 35 pass, 202 assertions, 0 failures |
| 2 | #12 | `lane/w12-repair` | `f6906f8110c98b41bf5528a4903a6d287d4f5fd4` | `0015_typed_repair` unchanged | Static checks green; plugin 20; Compose 12; first focused 100 pass / 2 fail; affected rerun 37 pass / 305 assertions / 0 fail |
| 3 | #11 | `lane/w10a-execution` | `ccf1458b7ed1cde7c0a630ceee5f55a891f54c7e` | Artifact validation 0015 to 0016; content digest 0016 to 0017 | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 175 pass / 767 assertions / 0 fail |
| 1b | #16 | `fix/production-review-astra-20260912` again, head `ddf1d97` | `f91f962`, fixture fix `89bee15` | None | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 38 pass / 210 assertions / 0 fail |
| 3b | #11 | `lane/w10a-execution` again, head `8231cc7` | `b3a3ed9` | None | Typecheck, lint, clean regeneration; plugin 43; Compose 12; focused 15 pass / 103 assertions / 0 fail |
| 4 | #14 | `lane/w9-product`, head `c854caf` | `9249ce9` | `0015_reactions_and_style` to 0018; `0016_watch_triggers` to 0019 | Typecheck, lint, clean regeneration; plugin 45; Compose 12; focused 326 pass / 1 skip / 1321 assertions / 0 fail |
| 4b | integration | `origin/integration` moved to `062d7f7` (four commits) | `d1d2d1a` | None | Typecheck, lint, clean regeneration; plugin 45; Compose 12; focused 254 pass / 0 fail |
| 5 | #15 | `lane/w10c-discovery`, head `17d65c8` | `5a89677` | `0018_tool_catalog` to 0020 | Typecheck, lint, clean regeneration; plugin 50; Compose 12; focused 356 pass / 0 fail after two test fixes |
| 6 | #18 | `lane/w6-deploy`, head `007aee9` | `0f000c6` | None | Typecheck, lint, clean regeneration; plugin 53; Compose 17; focused: 9 of 10 lane files pass (77 tests), `runtime/context.test.ts` last case hangs on this Windows box at the lane's own head too (see section) |
| 7 | #17 | `lane/w13a-docs`, head `7cfd41e` | `c6bbac8` | None | Typecheck, lint, clean regeneration; plugin 53; Compose 17; docs only, 40 sentences corrected (listed below) |
| 8 | #20 | `lane/w10b-browser` | Not attempted | Pending | Not run |
| 9 | #19 | `lane/w11-learning` | Not attempted | Pending | Not run |
| 10 | #13 | `lane/w14-capabilities` | Not attempted | Pending | Not run; real Hermes effect proof pending in draft |
| 11 | #21 | `lane/w15-wire` | Not attempted | Pending | Not run |
| 12 | #22 | `lane/w16a-experience` | Not attempted | Pending | Not run |

## PR 16: production review

Source head: `9725927e1b0d2ca26254aa3ff68be7952e3d4c8c`. No textual conflicts. Preserved the transaction-only job lock, shared event-order advisory lock, claimable scheduling-class-aware wakes, and pending approval projection.

Changed `apps/melete/test/helpers/postgres.ts` to apply `migrateDatabase` and the production journal before optional fixture migrations. The incoming fixture selected migrations by literal filenames, which violates the landing migration rule and would omit later lanes. No tests were removed. No migrations were added. No lane report was present.

Typecheck passed. Lint passed across 308 files. OpenAPI and client regeneration produced no changes. Python plugin: 20 passed. Compose: 12 checks passed. Focused database checks passed: 35 tests, 202 assertions, 0 failures across `broker-service-contract.test.ts`, `broker.test.ts`, and `postgres.test.ts` in 110.31 seconds, using `bun test --max-concurrency=1 --timeout=15000`.

## Full-suite checkpoints

Checkpoint 1 (after step 4, head `e956aa0`): full Bun suite under the shared lock, `bun test --max-concurrency=1 --timeout=20000`: 1154 passed, 1 skipped (key-gated), 14 existing todos, 0 failures across 97 files in 264.36 s. Checkpoints 2 (after step 7) and 3 (after step 12): not reached yet.

## PR 12: typed repair

Source head: `afc3d1e06d2f1036eb26da3aceaea27ac90753bf`, re-confirmed with GitHub. Conflict: `apps/melete/test/helpers/postgres.ts` had overlapping journal-loader comments. Kept the lane's explanation and production `migrateDatabase` loader; no literal migration filenames remain in the loader. Removed incoming `REPORT.md`.

Migration `0015_typed_repair` already followed 0014. Journal index 15 and timestamp 1789152918161 are increasing; snapshot 0015 links to snapshot 0014. No renumbering was necessary. The broker merged automatically; checked that all `lockJob` calls use transactions and that PR 16's wake and approval projection changes survived.

The initial focused run passed 100 tests and failed 2, with 532 assertions across seven files (67.78 seconds). Repair escalation stores human explanations in `question.because`, while the public question projection requires evidence handles. Closing that question threw during PR 16's verification and late-receipt wake tests. Fixed `apps/melete/src/jobs/questions.ts` at the projection boundary: preserve the explanation in displayed text, retain valid handles, and otherwise cite the persisted question record. Stored repair evidence and every test were preserved.

Final affected rerun: 37 passed, 305 assertions, zero failures across `broker-service-contract.test.ts`, `repair.test.ts`, and `attention.test.ts` (71.61 seconds). The unchanged files passed in the first run: broker repair policy, calendar, files, and conformance scenarios 3 and 4. Both runs used `bun test --max-concurrency=1 --timeout=15000`.

After the fix: typecheck passed; lint checked 314 files; OpenAPI/client regeneration unchanged; plugin 20 passed; Compose 12 checks passed; public-copy scan empty. This is before the first full-suite checkpoint.

## PR 11: execution and artifact validation

Source head: `ffc1c510c1c29a056f7d4e7db8ee1cabf8ea0030`, confirmed with GitHub. Removed incoming `REPORT.md`. Resolved these conflicts:

- `apps/melete/src/broker/service.ts`: retained the repair due-time argument and added a separate cell-claim argument. Both the retry-time check and the cell-only dispatch guard run before dispatch. Kept one authority-check implementation and moved artifact/mailbox `validateBinding` into it, so initial dispatch and repair retries both validate current bound resources. Kept the repair driver and execution settlement functions, each once.
- The incoming `settleExecution` called `lockJob(this.sql, ...)`. Replaced it with an explicitly non-locking context read; late evidence remains allowed and `recordResult` performs the transaction-locked persistence and epoch handling. No nontransactional `lockJob` calls remain.
- `apps/melete/src/connectors/files.ts`: combined artifact expectation/validation imports with typed repair faults. Retained the write readback check and artifact validation over the written content.
- `apps/melete/src/connectors/types.ts`: retained both repair context types and the query type required for preparation and binding checks.
- `apps/melete/test/helpers/postgres.ts`: kept the execution lane's shared server and journal-driven migrator, including the alternate journal folder used by migration-loader tests. Preserved the repair lane's optional additional fixture SQL after the journal.
- `apps/melete/drizzle/meta/_journal.json` and `0015_snapshot.json`: retained applied 0015 repair state and appended execution's two current migrations. `0015_artifact_validation` becomes `0016_artifact_validation` at timestamp 1789152918162; `0016_artifact_content_digest` becomes `0017_artifact_content_digest` at timestamp 1789161120201. Rebuilt both cumulative snapshots with repair state retained and a linear previous-ID chain. Previously applied SQL and snapshots are byte-identical to their landing parent. Because the live execution PR has two migrations, later numbering shifts by one from the brief.

Typecheck passed; lint checked 332 files. OpenAPI/client output was regenerated after the merge, staged, then regenerated again with no changes. Plugin: 43 passed. Compose: 12 checks passed. Focused Bun: 175 passed, 767 assertions, zero failures across 13 files in 41.97 seconds (`--max-concurrency=1 --timeout=15000`): all ten changed Bun test files plus files, repair integration, and PR 16's broker/service regressions. This includes real journal ordering, cell admission, artifact hashes, mailbox binding, and late settlement checks. No tests were removed or weakened.

## Continuation (second integrator)

The worktree was found mid-merge of `origin/lane/w9-product` (head `c854caf`) with 18 unmerged paths and no record of which staged resolutions were deliberate. That merge was aborted and redone from the same head; nothing committed was discarded. Before redoing it, the branches of PR 16 and PR 11 were merged again because both had gained commits since the first trial. PR 12's head (`afc3d1e`) had not moved.

## PR 16 again: production review fixes

Source head: `ddf1d97da00f4d4f39643c5bf7dbea56e747b62e` (four commits after `9725927`). Merge commit `f91f962`. One conflict, `apps/melete/test/helpers/postgres.ts`: the lane switched the fixture to the production `migrateDatabase` loader, while landing already carried the execution lane's journal loader with an optional `migrationsFolder` override for migration-loader tests. Resolved to call `migrateDatabase(handle)` by default and the drizzle migrator only when a test supplies its own folder, so production and fixtures share one loader and the loader tests keep their alternate journal. No literal migration filenames remain.

The lane's new `apps/melete/src/broker/service.test.ts` built an `Action` without the typed repair fields that PR 12 added to the contract, so typecheck failed after the merge. Follow-up commit `89bee15` adds `repair_trace`, `repair_counters`, `repair_disposition` and `retry_after_at` to that fixture; the assertion is unchanged.

Checks: typecheck; lint 333 files; OpenAPI and client regeneration unchanged; plugin 43 passed; Compose 12 checks; focused `broker-service-contract`, `broker`, `postgres`, `service.test.ts`: 38 passed, 210 assertions, 0 failures (31.95 s).

## PR 11 again: execution settlement lock removal

Source head: `8231cc742b52a714c0365180548e20966ae2248a` (two commits after `ffc1c51`). Merge commit `b3a3ed9`. One conflict in `apps/melete/src/broker/service.ts` at `settleExecution`: both sides had already replaced `lockJob(this.sql, ...)` with a plain job read; the lane folds the missing-job case into the existing `action_not_found` guard, landing had a separate `stale_epoch` throw. Took the lane's guard (its test expects `action_not_found`) with a merged comment. No non-transactional `lockJob` calls remain.

Checks: typecheck; lint; regeneration unchanged; plugin 43; Compose 12; focused `execution-admission` and `broker-service-contract`: 15 passed, 103 assertions, 0 failures.

## PR 14: product lane

Source head: `c854cafb9e59a2dad4c266dfb5d364a27c60d56d`, confirmed with GitHub. Merge commit `9249ce9`. Removed incoming `REPORT.md`. Eighteen conflicting paths:

- `.agents/notes/README.md` and the lane's note: the lane numbered its note 0015, which landing already uses for typed repair (0016 is execution). Renamed to `0017-agentic-and-natural.md`, updated its heading, and indexed it after 0015.
- `apps/melete/drizzle/meta/_journal.json`: kept landing's 15 to 17 and appended the lane's two migrations as `0018_reactions_and_style` (when 1789161120202) and `0019_watch_triggers` (when 1789161120203). The lane shipped no snapshots; wrote `0018_snapshot.json` and `0019_snapshot.json` as copies of 0017 with the added `memory_contexts.style_violations` and `trigger.last_observation` columns and a linear id chain. Earlier SQL and snapshots are byte-identical to their parent.
- `packages/contracts/src/artifacts.ts` (add/add): the execution lane's artifact validation module is the file; the product lane's two exports (`artifactReceiptDetail`, `artifactIdForAction`) were appended under a generated-artifacts section. Both lanes' callers import from `@melete/contracts`, so nothing else changed.
- `apps/melete/test/integration/artifacts.test.ts` (add/add): two unrelated suites. Execution's validation suite keeps the name; the product lane's authenticated artifact retrieval suite now lives at `generated-artifacts.test.ts`, unchanged inside.
- `apps/melete/src/broker/service.ts`: imports from both lanes kept; dropped the lane's unused `QUEUES` import (its pushed wake was superseded by PR 16's scheduling-class wakes, which auto-merged). The tool catalog now goes through the lane's `grantedToolCatalog`, and `connectors/catalog.ts` was extended to carry the execution lane's `execution` and `record_schema` fields on every connector tool so the cell still learns which tools it runs itself.
- `apps/melete/src/broker/http.ts`: the attempt-token POST allowlist now includes `/actions`, `/reactions`, and the execution start/settle routes.
- `apps/melete/src/broker/internal-server.ts`: both `recordArtifact` (execution) and `estimateSpend` (capabilities) are passed to the service.
- `apps/melete/src/connectors/configured.ts`, `connectors/types.ts`, `src/index.ts`, `jobs/runner.ts`, `packages/contracts/src/{entities,index,openapi}.ts`: additive on both sides; kept both (generation, exec, and artifacts providers; `capability` beside `prepare`/`validateBinding`; reactions mounted beside repairs; `loadCatalog` beside `artifactRoots`).
- `packages/runtime-hermes/melete_plugin/broker.py` and `tests/test_plugin.py`: kept execution's `start_execution`/`settle_execution` and the lane's `react`, and both test groups. The lane's react test asserted a dict, but the merged plugin returns JSON text from registered handlers (pinned Hermes registry, PR 11); the test now decodes the string before the same assertion.
- `packages/contracts/openapi.json` and `packages/client/src/schema.d.ts`: regenerated from the merged sources, then regenerated again with no diff.

Other fixes the merge needed: `packages/runtime-hermes/scripts/e2e-exec.ts` (execution lane) builds an `AttemptBundle` and now supplies `since_last: EMPTY_SINCE_LAST` (the lane's delta-brief field is required); the `apps/melete/src/connectors/tts.test.ts` fixture gained the typed repair fields. `bun install` added the lane's `re2js` dependency. Public-copy scan: two hits in lane text were reworded so the scan stays empty (one style sample now says "an employer name"; one contract comment now says "goes with", since the scan pattern matched inside the previous word).

Checks: typecheck; lint 363 files; OpenAPI and client regenerated and stable; plugin 45 passed; Compose 12 checks; focused run of all 22 lane test files (with the renamed retrieval suite) plus `broker-service-contract`, `execution-admission`, `repair`, `attention`, `postgres`: 326 passed, 1 skipped (key-gated), 1321 assertions, 0 failures across 28 files (87.31 s).

## Integration moved: contract component names, question fix, database timeouts

`origin/integration` advanced from `9484023` to `062d7f7` (four commits: bound disputed-key lookup, journal-named fixture migrations and database suite room, contract freeze lifted with `.meta({ id })` component names, and the test timeout moved into the `test` script). Merged into `landing` as `d1d2d1a` before continuing. Conflicts:

- `packages/contracts/src/entities.ts`: the `action` schema gained `.meta({ id: 'Action' })` upstream while landing carries the typed repair fields; kept every field and wrapped it with the component id. Event kinds keep both the product lane's `reaction` and upstream's `gap`.
- `apps/melete/test/helpers/postgres.ts`: upstream added a journal-name lookup (`migrationNamed`) for the initial and effect-identity migrations. Landing already applies the whole journal through the production migrator, so the selectors had nothing left to select; dropped them and the `readFileSync` import. No literal migration filenames anywhere in the helper.
- `packages/contracts/openapi.json` and `packages/client/src/schema.d.ts`: regenerated from the merged sources and stable on a second run. Upstream's `bunfig.toml` note and `--timeout=30000` in the `test` script were taken as is.

Checks: typecheck; lint; regeneration unchanged; plugin 45; Compose 12; focused `postgres`, `broker-service-contract`, contracts and jobs unit files: 254 passed, 0 failures.

## PR 15: discovery lane

Source head: `17d65c8016112eb6638f55e7bf37515b7961172f`, confirmed with GitHub. Merge commit `5a89677`. Removed incoming `REPORT.md`. Twenty conflicting paths; the substantive ones:

- Migrations: the lane's `0018_tool_catalog` (pre-numbered against an older base) becomes `0020_tool_catalog`; its timestamp 1789232400000 already follows 0019 and was kept. Journal appended in order. The lane shipped no snapshot and the table is raw SQL outside `schema.ts`, so `0020_snapshot.json` is 0019 with a new id chained to it. Earlier SQL and snapshots are byte-identical to their parent.
- `apps/melete/src/broker/service.ts` (seven hunks). The catalog now goes through the lane's `ToolCatalog` (`this.discovery.catalog`). To keep the product lane's contract that `react` is always available, `react` is passed to the catalog as a broker-owned native tool (`REACT_TOOL`, exported from `connectors/catalog.ts` and shared with the API-side `grantedToolCatalog`); native tools rank as core, so `search_tools`, `load_tool`, `react` lead every core. `broker/catalog.ts` was extended to skip a capability whose provider is unavailable (product lane) and to carry the execution lane's `execution` and `record_schema` on each connector tool. `validatePayload` keeps the execution lane's in-cell intent and record-schema branches and validates each through the lane's compiled-schema path (draft 2020-12 selection, `schema_invalid` for a schema that will not compile or is async) via a small `compiled()` helper, so both lanes' behaviour holds without two validators. `propose` keeps the execution lane's `connector.prepare` flow and adds the lane's read-only composition gate and alias-to-verb rewrite before canonicalising the payload. `dispatch` keeps landing's single `checkAuthority` (from the execution merge) rather than re-inlining the lane's copy; the lane's three additions were ported into it: the connection query joins the space for its audience, `connectorAllowsAudience` and `tool.effect_class !== action.effect_class` refuse with `scope_denied`, and a tool that now requires approval without an authorization throws `approval_required`. `tool()` auto-merged with both the capability-availability check and the lane's audience and alias resolution. The lane's `QUEUES` import stays out (superseded by scheduling-class wakes).
- `apps/melete/src/broker/start.ts`: took the lane's try/finally structure (registry closed on failure and on close, queue tracked) with landing's `connectorsFromEnv`, `artifactRoots`, and the parked-action resume in the recovery interval, plus the lane's `composeExecutor` and skills-backed `catalog` options.
- `apps/melete/src/broker/internal-server.ts`: kept landing's `fake`, `artifactCritic` and `artifactRoots` options and added the lane's `catalog` and `composeExecutor`; the lane's duplicate `gatewayFake` option was folded into `fake` (its one caller, `scripts/discovery-e2e.ts`, updated).
- `apps/melete/src/broker/http.ts`: attempt-token POST allowlist is the union: `/actions`, `/reactions`, `/tools/search`, `/tools/load`, `/tools/call`, and execution start/settle.
- `apps/melete/src/connectors/configured.ts`: landing's loop (generation, files, exec, artifacts, web, test, imap with mailers, caldav) plus the lane's `mcp` branch, inside the lane's try that closes the registry if an open fails. `connectors/types.ts`: both interfaces merged (`prepare`, `validateBinding`, `capability`, repair hooks, plus `catalog`, `close`, and `connectorAllowsAudience`). `packages/contracts/src/entities.ts`: providers keep exec, artifacts, generation and add `mcp`.
- Test helpers: `database.ts` keeps both `sharedTestServerUrl` and the lane's refcounted `acquireTestServer`; `postgres.ts` is the lane's simplified fixture (shared server, production migrator) with the execution lane's `migrationsFolder` override retained for migration-loader tests. `bunfig.toml` keeps integration's note (bun ignores a `timeout` key there); the lane's `timeout = 15000` was dropped.
- `packages/runtime-hermes/melete_plugin/__init__.py`: one handler wrapper. Kept the execution lane's in-cell constants and flow, the product lane's `react` branch (now refusing through the lane's `refuse`, which pins `schema_invalid`), and the lane's `search_tools`/`load_tool`/native routing with `register_loaded`; `register` uses the lane's `register_one`/`wire_handler` and the execution lane's equivalent `_runtime_handler` wrapper was removed. `tests/test_plugin.py`: all three lanes' tests kept.
- `docs/CONNECTORS.md`: kept the product lane's watch section and the lane's discovery, MCP and compose sections. One fact corrected: the lane wrote that product-lane producers were absent from its base; the merged text says capability producers such as speech use the catalog seam and an unavailable capability is left out.
- Generated `openapi.json` and `schema.d.ts`: regenerated, stable on a second run.

Fixes the merge needed beyond conflicts: the lane's `compose.test.ts` action fixture gained the typed repair fields; `scripts/discovery-e2e.ts` and `src/discovery.test.ts` bundles gained `since_last: EMPTY_SINCE_LAST`. Two lane tests encoded the pre-merge catalog: `catalog.test.ts` expected the initial core to equal the two meta tools (now meta tools plus `react`), and `execution-admission.test.ts` handed the plugin `catalog[0]` (now `search_tools`); it now selects `exec.python` by name. No test was removed or weakened.

Note for the orchestrator: two catalog builders now coexist by design of the two lanes. The broker's attempt-scoped `ToolCatalog` (discovery, `/tools`) and the API-side `grantedToolCatalog` (`knowledge/catalog.ts`, used for space capability listings and the runner's bundle) both derive from the same connector manifests and grants; they were not unified in this merge.

Checks: typecheck; lint 379 files; OpenAPI and client regenerated and stable; plugin 50 passed; Compose 12 checks; public-copy scan empty; focused run of the lane's 17 test files plus `broker-service-contract`, `execution-admission`, `artifacts`, `generated-artifacts`, `reactions`, `capability-catalog`, `repair`, `attention`, `service.test.ts`: 353 passed and 3 failed before the two test fixes (78.91 s); `catalog` and `execution-admission` rerun after the fixes: 23 passed, 0 failures.

## PR 18: deploy lane

Source head: `007aee9c5fc75ed873a1b4422b7edb150b055be4` (the head GitHub reported at merge time; the brief noted the lane was still receiving a control-plane reachability fix, so a later re-merge may be needed). Merge commit `0f000c6`. Removed incoming `REPORT.md`. Five conflicting paths:

- `.agents/notes/README.md`: kept landing's 0015 and 0017 rows and added the lane's 0020 row; no note numbers collide (0018 is the discovery lane's note).
- `apps/melete/src/index.ts` (four hunks, all additive): the product lane's `RuntimeCatalog` import and `catalog` state sit beside the lane's `startDeploymentMemory`, `supervisedRuntime`, `deploymentMemory` and `effectBoundary`; the runner receives both `loadCatalog` (product) and `scopes` (deploy); `createApp` gets both the product lane's `knowledge` deps and the lane's `memory` routes.
- `apps/melete/src/knowledge/spaces.ts`: took the lane's confined `databaseSpaces` (owner-audience rows only, catalog path must be the space's own id directory, symlink and dangling-link refusal, lazy `initSpace`, `byName` resolving ids only). The product lane's earlier version resolved display names through `or(id, name)`; the lane's own `spaces.test.ts` requires a display name to resolve to nothing, and no merged caller resolves by display name.
- `packages/runtime-hermes/melete_plugin/__init__.py`: the lane's rule that only the positional argument dict is model input (engine context keywords never join the payload) replaces the merge of `extra` into `arguments`; the product lane's `react` branch and the discovery lane's native routing follow it unchanged.

Plugin content pin: the lane pins the plugin directory's SHA-256 in `packages/runtime-hermes/Dockerfile` (`MELETE_PLUGIN_SHA`, checked by `build-metadata.py` at image build). Recomputed with the same algorithm (sorted relative paths, NUL-separated name and bytes, `__pycache__` excluded) over the merged plugin: `282c8ca215260897aeb07a6170378e8e14325ab90966bba6069d3847493e751f` replaces `742ebece…f7c9`. The lane's note 0020 still cites the old value as the hash it measured; that is a historical record and was left alone.

Other fixes the merge needed: the lane's `runtime/context.test.ts` and `runtime/docker.test.ts` bundles gained `since_last: EMPTY_SINCE_LAST`; `bun install` picked up the lane's conformance dependencies.

Checks: typecheck; lint 395 files; OpenAPI and client regenerated and stable; plugin 53 passed; Compose 17 checks; public-copy scan empty. Focused run, one file at a time with a 180 s wall clock each: `api/listener` 4, `api/login-throttle` 3, `knowledge/spaces` 5, `memory/bootstrap` 5, `runtime/docker` 10, `integration/auth` 12, `deploy/scripts/compose-check` 16, `deploy/scripts/serve-static` 23, all passing; plus the earlier regressions (`knowledge/routes`, `capability-catalog`, `since-last`, `reactions`, `gateway`, `broker`, `catalog`, `execution-admission`, `broker-service-contract`, `generated-artifacts`) which passed in the first combined run before it was stopped.

**Open item, not a merge defect:** `apps/melete/src/runtime/context.test.ts`, case "context is byte-bounded and stale caller epochs cannot launch or create a selection audit", never completes on this box. Its first three cases pass. Traced with temporary logging: the first attempt completes in about 130 ms with a complete recall; the immediately following stale attempt enters `assembleAttemptKnowledge` and its `recall` transaction stops after `BEGIN` (Postgres shows the session idle in transaction with no further statement; no locks waited on, no other active sessions), so the returned promise never settles and the leaked pg-boss connection keeps the process alive after the per-test timeout. It is timing dependent: the same sequence passes when any query runs between the two starts. Bypassing the product lane's style check, and swapping in the lane's own `memory/` and `runtime/context.ts` sources, made no difference. The same file was then run at the lane's own head `007aee9` in a throwaway worktree on this box: the same case timed out the same way. The lane recorded that Windows execution was not performed. Left for the lane owner; nothing in this merge was changed for it. Checkpoints 2 and 3 run this file separately under a wall clock so the rest of the suite still reports.

## PR 17: docs lane

Source head: `7cfd41e01c0c1d93a2e9ab759899e0a175890c80`, confirmed with GitHub. Merge commit `c6bbac8`. Removed incoming `REPORT.md`. Documentation only. Nine files conflicted (twelve hunks): `README.md`, `apps/melete/src/{broker,connectors,knowledge}/README.md`, `docs/{ARCHITECTURE,CLIENT,CONNECTORS,THREAT-MODEL}.md`, `packages/runtime-hermes/README.md`; eleven more lane files merged automatically.

Method, as the brief prescribes: the lane's version of every sentence and its structure were taken, and only sentences whose stated fact a code lane above changed were corrected in place. The lane wrote against baseline `9484023`, so its "written, not run" and "not claimed" statements about deployment (PR 18 ran the Linux stack, scenarios 6 to 8, the restore proof and the control-plane guard), automatic runtime supervision (PR 18), the plugin test suite (run here, 53 passing), the tool catalog (PR 15's token-budgeted core and discovery), the runtime's `work/<job>` subpath mount (PR 18) and provider OAuth exposure (PR 18) were corrected. Sections that document features the lane's baseline did not have were appended under the lane's structure rather than dropped: typed faults and the repair policy and the execution routes (`broker/README.md`), typed faults (`connectors/README.md`), the typed-repair paragraph (`ARCHITECTURE.md`, kept beside the lane's renamed heading), the reaction rule and the safe-stop rule (`CLIENT.md`), watch predicates, discovery, operator-installed MCP servers and composition (`CONNECTORS.md`), the runtime-runs-code section, the Linux deployment verification table and the MCP attacker (`THREAT-MODEL.md`), and the scaffolding measurement, in-cell execution and discovery continuations (`runtime-hermes/README.md`). The Linux install procedure from the deploy lane was reinstated in `README.md` because the lane's "installation not claimed" no longer holds. The lane's links to the unshipped lane `REPORT.md` (thirteen, across the lane's and the deploy lane's docs) were repointed: deployment evidence to note 0020, documentation-verification results to the lane's pull request.

Corrected sentences (before and after, whitespace collapsed):

- `README.md`
  - was: bun test --max-concurrency=2 --timeout=15000 bun run openapi bun run client:generate bun run compose:check bun test --max-concurrency=2 --timeout=15000 conformance/scenarios bun run conformance:memory ```
  - now: bun run test bun run openapi bun run client:generate bun run compose:check bun run conformance bun run conformance:memory bun run test:plugin ```
- `README.md`
  - was: The generators update the OpenAPI document and client declarations; generated differences must be inspected. The Compose command checks YAML, not live networking. The service-scenario command runs scenarios 1–5 and reports 6–8 as todo. The full suite took 454.72 seconds, about seven and a half minutes, on the measured host with the documented `--timeout=15000` override. `bunfig.toml` sets concurrency to two; the command gives each test/fixture hook fifteen seconds, not the whole suite. Several minutes of test output can therefore be normal progress. The shorter default produced fixture-hook timeouts in a run that took 628.07 seconds; see the recorded results when assessing a nonzero exit. The memory runner executes ten scenarios across seven families plus ten withheld-memory runs; procedure transfer is **written, not run**. Results and command failures are recorded in [REPORT.md](REPORT.md).
  - now: The generators update the OpenAPI document and client declarations; generated differences must be inspected. The Compose command checks YAML, not live networking. `bun run conformance` runs scenarios 1–5 and reports 6–8 as todo unless the Compose opt-in above is set, in which case all eight run against the stack. `bun run test:plugin` runs the Python plugin suite. The full suite took 454.72 seconds, about seven and a half minutes, on the measured host; the `test` script passes `--max-concurrency=2 --timeout=30000`, which gives each test and fixture hook thirty seconds, not the whole suite. Several minutes of test output can therefore be normal progress. The shorter default produced fixture-hook timeouts in a run that took 628.07 seconds. The memory runner executes ten scenarios across seven families plus ten withheld-memory runs; procedure transfer is **written, not run**.
- `README.md`
  - was: | `packages/runtime-hermes` | Pinned engine configuration and HTTP adapter |
  - now: | `packages/runtime-hermes` | Pinned engine configuration, the Melete plugin and HTTP adapter, and the runtime image |
- `README.md`
  - was: | `deploy` | Deployment configuration; live deployment is **not claimed** |
  - now: | `deploy` | `docker-compose.yml`, `.env.example`, the configuration generator, and the check that the sandbox is really a sandbox; verified on a Linux Docker host |
- `README.md`
  - was: | `conformance` | Executable scenarios and explicit todos |
  - now: | `conformance` | Eight scenarios (6–8 need the Compose opt-in) and [eight memory scenario families](conformance/memory/README.md) |
- `README.md`
  - was: **Status: pre-release. Durable service components work in scripted tests; a complete installed assistant is not claimed.** Evidence below applies to code baseline `9484023cabd32b786cb4d336dec818f441cd0cc1`.
  - now: **Status: pre-release. Durable service components work in scripted tests, and the Linux Compose stack builds from source and runs the scripted provider; a complete assistant with a real model is not claimed.** The test-mapped evidence below was recorded at code baseline `9484023cabd32b786cb4d336dec818f441cd0cc1`; the deployment evidence was recorded on a Linux Docker host on 2026-09-11 and 2026-09-12 (see [the threat model](docs/THREAT-MODEL.md)).
- `README.md`
  - was: waits, approvals and action receipts. The five executable [conformance scenarios](conformance/README.md) test recovery, fencing, unknown outcomes, approval binding and runtime death with isolated Postgres and scripted runtimes. They do not run a Compose deployment or a real model.
  - now: waits, approvals and action receipts. The first five [conformance scenarios](conformance/README.md) test recovery, fencing, unknown outcomes, approval binding and runtime death with isolated Postgres and scripted runtimes. Scenarios 6 to 8 run against the Compose stack when the opt-in below is set. None of them runs a real model.
- `README.md`
  - was: Container egress probes are **written, not run**; installation, upgrades and whole-system backup/restore are **not claimed**. |
  - now: Container egress probes ran from a claimed cell and the warm cell on a Linux Docker host (scenario 6, 2026-09-12); a clean-host install was measured at 64.93 seconds; the Postgres restore proof passed with one destination effect. Upgrades are **not claimed**. |
- `README.md`
  - was: - The service has authenticated job, approval, scheduling, attention and event APIs. Startup requires a supplied runtime or the explicit scripted stub when Postgres is configured; automatic Hermes startup is **not claimed**. See [architecture](docs/ARCHITECTURE.md) for the wiring and named tests.
  - now: - The service has authenticated job, approval, scheduling, attention, event and reaction APIs. With `MELETE_RUNTIME_ADAPTER=docker` the service supervises one Hermes container per attempt itself; otherwise startup requires a supplied runtime or the explicit scripted stub when Postgres is configured. See [architecture](docs/ARCHITECTURE.md) for the wiring and named tests.
- `README.md`
  - was: edits, and owner edits become protected revisions`). Memory startup/router integration is optional and is not wired by default; see [memory](docs/MEMORY.md).
  - now: edits, and owner edits become protected revisions`). Memory startup and its routes are wired when the Docker runtime is selected and stay optional otherwise; see [memory](docs/MEMORY.md).
- `README.md`
  - was: - The broker catalog is filtered by scopes; a universal 15-tool limit is **not claimed**. The contract constant is not an enforced catalog cap.
  - now: - The broker catalog is filtered by scopes and served as a token-budgeted core (750 estimated tokens) plus `search_tools` and `load_tool`; a universal 15-tool limit is **not claimed**. The contract constant is not an enforced catalog cap.
- `README.md`
  - was: - Compose hardening is declared and statically checked. Runtime egress probes are **written, not run**. Postgres shares the runtime's internal network, so exclusive broker reachability is **not claimed**. See the [threat model](docs/THREAT-MODEL.md).
  - now: - Compose hardening is declared, statically checked, and was probed live on a Linux Docker host: from inside a claimed cell and the warm cell, the internet, the host metadata address, Postgres, the web service and the owner control plane were unreachable, and the broker with its model gateway was the only peer. See the [threat model](docs/THREAT-MODEL.md).
- `apps/melete/src/broker/README.md`
  - was: The internal listener combines broker routes, a service-authenticated action read adapter and the model gateway. Live exclusive-broker reachability is **not claimed**: the container probes are **written, not run**, and Postgres shares the declared runtime network.
  - now: The internal listener combines broker routes, a service-authenticated action read adapter and the model gateway. Scenario 6 on the Linux Compose stack (2026-09-12) showed this listener as the cell's only reachable peer: Postgres, the web service and the owner control plane were unreachable from a claimed attempt and from the warm cell.
- `apps/melete/src/connectors/README.md`
  - was: File checks use portable filesystem APIs and do not establish a kernel boundary against another process racing directory replacement. Live container enforcement is **written, not run**. Mail and calendar use local protocol fixtures; general live-account compatibility is **not claimed**.
  - now: File checks use portable filesystem APIs and do not establish a kernel boundary against another process racing directory replacement; the container mount boundary (a per-attempt `work/<job>` subpath) was probed live on Linux in scenario 6. Mail and calendar use local protocol fixtures; general live-account compatibility is **not claimed**.
- `apps/melete/src/knowledge/README.md`
  - was: See [MEMORY](../../../../docs/MEMORY.md) for authoritative retrieval and startup requirements. Whole-stack retraction/restart conformance is **written, not run** in scenario 7.
  - now: See [MEMORY](../../../../docs/MEMORY.md) for authoritative retrieval and startup requirements. Scenario 7 runs whole-stack retraction and restart against the Linux Compose stack when the Compose opt-in is set (2026-09-12: the restart took 17.9 seconds).
- `docs/CONNECTORS.md`
  - was: | Test destination | Durable acceptance with optional lost acknowledgement | `destination drops its acknowledgement only after acceptance and verify resolves it` |
  - now: | Test destination | Durable acceptance with optional lost acknowledgement | `destination drops its acknowledgement only after acceptance and verify resolves it` | | Exec | `exec.run` and `exec.python` carried out inside the cell against a broker-reserved action, with the finished record settled afterwards | `the exec manifest parses and declares in-cell execution with a record schema`; `execution-admission.test.ts` | | Artifacts | Declared writes become artifact records with deterministic checks; publishing to the space or by email is an approved external effect | `artifacts.test.ts` | | Generation (speech) | `audio.synthesize` as a `spend` capability with approval, reservation, receipt and an authenticated artifact endpoint | `is a real RIFF/WAVE file, not a placeholder string`; `speech-broker.test.ts` | | MCP | Operator-configured HTTP servers behind the broker with operator-chosen effect classes, scopes and audience | `MCP config is strict, operator scoped, and defaults unclassified tools to external writes`; `MCP worker and server claims cannot make an ungranted tool callable` |
- `docs/CONNECTORS.md`
  - was: symlinks without touching outside content`. These are connector checks, not proof of container filesystem isolation. The container probes are **written, not run**.
  - now: symlinks without touching outside content`. These are connector checks, not proof of container filesystem isolation; that boundary was probed live in scenario 6 on a Linux Docker host, where a sibling job's canary was unreadable from the cell while its own workspace was writable.
- `docs/CONNECTORS.md`
  - was: The broker's database scenarios also run under the full test command in [README](../README.md). [REPORT.md](../REPORT.md) records verification results.
  - now: The broker's database scenarios also run under the full test command in [README](../README.md).
- `docs/THREAT-MODEL.md`
  - was: comparison is **written, not run**. API-key forwarding is implemented; subscription OAuth credential storage and its isolation are **not claimed**.
  - now: comparison is **written, not run**. API-key forwarding through the gateway is the verified path. Configuring provider OAuth inside Hermes would place those credentials in the runtime's auth store, outside this boundary: a runtime compromise exposes an OAuth token stored there, and it does not expose a provider API key kept in Melete's gateway. The tested images and volumes contain no such OAuth configuration.
- `docs/THREAT-MODEL.md`
  - was: Live container containment is **not claimed**. The scenario 6 container probes are **written, not run**: internet, Postgres, metadata, sibling service, broker reachability and filesystem/UID checks all remain `test.todo`. The Compose file declares an internal-only runtime network, non-root UID, read-only root, dropped capabilities, no-new-privileges and process/memory limits. The static test `passes every boundary check` reads that configuration; it does not establish runtime network behavior. In particular, Postgres shares the runtime's internal network. The assertion that Postgres cannot be reached, and the assertion that the broker is the only reachable peer, are **not claimed**. Writable paths include `/work`, `/var/lib/hermes` and a `/tmp` tmpfs. The declared Hermes home is checked by `taking away the runtime writable Hermes home`; container enforcement is **written, not run**. A shared kernel, runtime volume contents and reachable broker remain attack surfaces. Virtual-machine isolation and host-compromise containment are **not claimed**.
  - now: Live container containment was probed on a Linux Docker host (Engine 29.1.3, 2026-09-11 and 2026-09-12) from a real claimed Hermes container and the warm probe container: the internet, the host metadata address, a live host listener, Postgres (by DNS and by container IP), the web service and the owner control plane (`/setup`, `/login`, `/health` on port 8787) were unreachable; the broker and model gateway on port 8788 were the only reachable peers; the cell ran as UID 10001 with a read-only root, zero effective capabilities, no-new-privileges and no Docker socket. The table below records that evidence and what would falsify it. These checks establish the tested Linux configuration, not macOS, Windows, rootless Docker, or protection from kernel exploits. The Compose file declares an internal-only runtime network with isolated bridge gateway mode, non-root UID, read-only root, dropped capabilities, no-new-privileges and process/memory limits. The static test `passes every boundary check` reads that configuration; the live probes above are what establish runtime behavior. Writable paths are the current job's `/work` subpath (`work/<job>`, mounted with a volume subpath so sibling jobs' directories are hidden by the OS mount), the attempt's named `/var/lib/hermes` volume, and a size-limited `/tmp` tmpfs. The declared Hermes home is checked by `taking away the runtime writable Hermes home`. A shared kernel, the runtime volume's own contents and the reachable broker remain attack surfaces. Virtual-machine isolation and host-compromise containment are **not claimed**.
- `docs/THREAT-MODEL.md`
  - was: The first command checks YAML only; the second uses temporary files, fake transports and local protocol fixtures. Full-suite results and the unrun container probes are recorded in [REPORT.md](../REPORT.md).
  - now: The first command checks YAML only; the second uses temporary files, fake transports and local protocol fixtures. The container probes run as scenario 6 when `MELETE_CONFORMANCE_COMPOSE=1` is set against a running Linux stack (see the README). The Linux deployment and restoration checks use a scripted model and a test destination; they do not establish live provider behavior or the safety of an arbitrary external account.
- `docs/THREAT-MODEL.md`
  - was: gate (conformance 4). Skill selection is deterministic (`matches a trigger in the objective`, `loads at most three skills, however many match`); schema length limits are tested by `refuses a skill that is longer than the contract allows`.
  - now: gate (conformance 4). Initial skill selection is deterministic (`matches a trigger in the objective`, `loads at most three skills, however many match`); on-demand discovery can load a skill the model requests, but the broker filters it by the current job's scopes and withholds space skills in the public compartment, so a requested skill never supplies its own authority. Schema length limits are tested by `refuses a skill that is longer than the contract allows`.
- `packages/runtime-hermes/README.md`
  - was: Automatic construction of this adapter by the default service bootstrap is **not claimed**; callers must inject a runtime or use the explicit local stub.
  - now: The service constructs and supervises this adapter itself when `MELETE_RUNTIME_ADAPTER=docker` is set (one container per attempt, retired when the attempt ends); otherwise callers inject a runtime or use the explicit local stub.
- `packages/runtime-hermes/README.md`
  - was: The container build and its live configuration behavior are **written, not run** for this documentation verification. Historical measurements remain in [the engineering record](../../.agents/notes/0009-hermes-surface.md); they are not a current deployment benchmark.
  - now: The image was built from the pinned tag and run on a Linux Docker host on 2026-09-12; its labels record the Hermes commit and the plugin content hash, and `build-metadata.py` refuses a build whose plugin bytes do not match the pin. Historical measurements remain in [the engineering record](../../.agents/notes/0009-hermes-surface.md); the current scaffolding measurement is below.
- `packages/runtime-hermes/README.md`
  - was: The broker filters tools by scopes, but a universal 15-tool cap is **not claimed**: the current broker catalog does not truncate to the contract constant.
  - now: The broker filters tools by scopes and serves a token-budgeted core (750 estimated tokens, discovery tools included) plus `search_tools` and `load_tool`; a universal 15-tool cap is **not claimed**, and the contract constant is not an enforced catalog cap.
- `packages/runtime-hermes/README.md`
  - was: The plugin forwards broker proposals and returns their dispositions. Its Python test suite is **written, not run** for this documentation verification; see `tests/`. A local TypeScript adapter pass does not imply Python plugin or container execution passed.
  - now: The plugin forwards broker proposals and returns their dispositions, carries out `in_cell` execution tools itself, and registers a schema the broker loads on demand. Its Python test suite (`tests/`) runs with `bun run test:plugin`; a local TypeScript adapter pass does not imply container execution passed.
- `packages/runtime-hermes/README.md`
  - was: Compose declares an internal-only runtime, read-only root, non-root UID and dropped capabilities. It provides writable `/work`, `/var/lib/hermes` and temporary storage. The home volume supports durable engine run-idempotency; the static check `taking away the runtime writable Hermes home` covers the declaration. Inside-container egress/filesystem probes are **written, not run** in [conformance 6](../../conformance/scenarios/06-no-route-out.test.ts). Postgres shares the internal network, so exclusive broker reachability is **not claimed**. The per-attempt environment and writable home configuration do not by themselves implement the service's missing runtime lifecycle wiring.
  - now: Compose declares an internal-only runtime, read-only root, non-root UID and dropped capabilities. Each attempt's container mounts only its job's `work/<job>` subpath, a named `/var/lib/hermes` volume and temporary storage. The home volume supports durable engine run-idempotency; the static check `taking away the runtime writable Hermes home` covers the declaration. Inside-container egress and filesystem probes are [conformance 6](../../conformance/scenarios/06-no-route-out.test.ts); they ran on a Linux Docker host on 2026-09-12 from a claimed attempt and the warm cell, and found the broker and model gateway to be the only reachable peers, with Postgres, the web service and the owner control plane unreachable. The service starts and retires these containers itself when the Docker runtime is selected.
- `SECURITY.md`
  - was: pre-release. [REPORT.md](REPORT.md) records the verification performed for the documentation revision.
  - now: pre-release. The documentation lane's pull request (#17) records the verification performed for the documentation revision.
- `conformance/README.md`
  - was: See [REPORT.md](../REPORT.md) for observed failures and retry results.
  - now: See the documentation lane's pull request (#17) for observed failures and retry results.
- `conformance/README.md`
  - was: arm. [REPORT.md](../REPORT.md) records command results and limitations.
  - now: arm. The documentation lane's pull request (#17) records command results and limitations.
- `conformance/memory/README.md`
  - was: Results for this documentation revision are in [REPORT.md](../../REPORT.md).
  - now: Results for this documentation revision are in the documentation lane's pull request (#17).
- `docs/ARCHITECTURE.md`
  - was: scenarios and prints the todos. See [REPORT.md](../REPORT.md) for run outcomes.
  - now: scenarios and prints the todos. See the documentation lane's pull request (#17) for run outcomes.
- `docs/CLIENT.md`
  - was: command in [README](../README.md). [REPORT.md](../REPORT.md) records outcomes.
  - now: command in [README](../README.md). The documentation lane's pull request (#17) records outcomes.
- `docs/DEPLOYMENT.md`
  - was: The [deployment report](../REPORT.md) records the tested revision, image sizes,
  - now: The [deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records the tested revision, image sizes,
- `docs/DEPLOYMENT.md`
  - was: to choose another parent directory. The [deployment report](../REPORT.md) records
  - now: to choose another parent directory. The [deployment note 0020](../.agents/notes/0020-deployment-evidence.md) records
- `docs/ENGINEERING.md`
  - was: Run outcomes are in [REPORT.md](../REPORT.md).
  - now: Run outcomes are in the documentation lane's pull request (#17).
- `docs/MEMORY.md`
  - was: and [REPORT.md](../REPORT.md) for command outcomes. Neither establishes model
  - now: and the documentation lane's pull request (#17) for command outcomes. Neither establishes model
- `docs/THREAT-MODEL.md`
  - was: those restore claims. Commands and measured results are in [REPORT.md](../REPORT.md).
  - now: those restore claims. Commands and measured results are in [deployment note 0020](../.agents/notes/0020-deployment-evidence.md).
- `docs/mail-calendar.md`
  - was: or remote calendar is used. See [REPORT.md](../REPORT.md) for results.
  - now: or remote calendar is used. See the documentation lane's pull request (#17) for results.
- `packages/runtime-hermes/README.md`
  - was: provider. [REPORT.md](../../REPORT.md) records the result.
  - now: provider. The documentation lane's pull request (#17) records the result.

Checks: typecheck; lint 395 files; OpenAPI and client regeneration unchanged; plugin 53 passed; Compose 17 checks; public-copy scan empty; no `REPORT.md` link remains outside `.agents/notes` and this report.

