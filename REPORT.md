# W10c discovery report — base 9484023

## Assumptions

- `git -C C:/Users/gamin/melete-oss-w10c log -4 --oneline`: the existing lane starts at `9484023`, immediately after `9b897ef`; preserve the existing commit.
- `gh pr create --base integration`: use the objective and DONE line's target, `integration`, where the later rule says `main`.
- `packages/contracts/src/runtime.ts`: leave frozen types unchanged; discovery metadata and any Hermes continuation signal stay service-local and do not add a public attempt outcome.
- `apps/melete/package.json`: embedded-postgres `17.10.0-beta.17` is already a devDependency; reuse its throwaway database fixtures and pg-boss.
- `packages/contracts/src/entities.ts`: the frozen provider enum has no MCP member; production MCP registration requires a contract decision unless a truthful existing seam is available.
- `rg --files packages`: W9 provider capability producers are absent at `9484023`; expose a scoped registration seam and verify with scripted producers.
- `bun test --max-concurrency=2`: keep test concurrency at two; use lane ports 3140/3142 where fixed ports are needed and allocated loopback ports for disposable database fixtures.

## Start — 2026-09-11 19:09 UTC

- `bun install`: exit 0, 372 packages installed with Bun 1.3.13 in 16.89 seconds.
- `git -C C:/Users/gamin/melete-oss-w10c status --short --branch`: clean `lane/w10c-discovery`, tracking `origin/integration`.
- `docs/ARCHITECTURE.md`, `packages/contracts/src/*.ts`, `.agents/notes/`, `apps/melete/src`: inspected frozen inputs before implementation; broker already owns approval, intent identity, scope and epoch checks, and trust-origin admission.

## Catalog implementation checkpoint — 2026-09-11 19:40 UTC

- `apps/melete/src/broker/catalog.ts`: added scoped compact manifests, Postgres tsvector ranking, budgeted core selection, durable attempt_tool_context, schema loading and broker-served skill reads.
- `packages/runtime-hermes` pinned source `2237be355906fbe6065ce1815711eee52b2d646e`: active agents snapshot tools at initialization; use a fresh HTTP run within the same bounded attempt after a verified load.
- `packages/contracts/src/entities.ts` and `ConnectorRegistry.register`: MCP cannot register under the frozen provider enum; isolate transport/policy tests and propose the provider extension rather than impersonating an existing provider.
- `clock__curr_time`: returned `2026-09-11 19:22:06 UTC`; the preceding `19:40` checkpoint label was a clock transcription error, and refers to work completed before this reading.
- `bun run typecheck`: first check found only two transient errors in concurrently edited `mcp-transport.ts` (`TS2741 readMany`, `TS18048 reader possibly undefined`); forwarded to its implementation worker before verification.
- `bun test --max-concurrency=2 apps/melete/src/broker/catalog.test.ts apps/melete/test/integration/catalog.test.ts apps/melete/test/integration/broker.test.ts`: 33 pass, 0 fail, 167 assertions in 64.41 seconds.
- `bun test --max-concurrency=2 apps/melete/src/broker/catalog.test.ts apps/melete/test/integration/catalog.test.ts`: after adding execution-classification and schema/health-drift rejection cases, 13 pass, 0 fail, 60 assertions in 27.53 seconds.
- `rg -n 'react|knowledge.search' apps/melete/src`: no registered react or knowledge connector exists at `9484023`; core prioritizes those tool families when supplied by trusted producers, and does not advertise nonexistent tools.
- `apps/melete/src/broker/catalog.ts:CORE_CATALOG_TOKENS`: default lowered to 750 estimated tokens to reserve the pinned Hermes engine's scaffolding within the 4,000-token tripwire; real wire measurement is pending.

## Defensive review and fixture checkpoint — 2026-09-11 19:53 UTC

- `bun test --max-concurrency=2 > .agents/w10c-full-tests.log`: first full run exceeded three minutes and stopped at `apps/melete/test/integration/memory.test.ts` fixture startup; one earlier failure was the old gateway catalog assertion expecting only `test.send` rather than the two discovery tools as well.
- `apps/melete/test/helpers/database.ts`, `helpers/postgres.ts`, `integration/postgres.ts`: reuse one embedded server with separately created disposable databases; preserve each fixture's migrations, real pg-boss and default WAL/fsync. The memory fixture no longer competes for fixed port 3122.
- `Stop-Process -Id 20292`: stopped the verified owned full-test Bun process after interruption left it running; its owned Postgres child exited, and the subsequent `pg_ctl` reported `No such process`. No unrelated process was stopped.
- `catalog_review`: found loaded-name account drift and asynchronous Ajv validation; `catalog.test.ts` now covers grant/revocation name binding, replacement accounts, asynchronous schema rejection and independent duplicate schema IDs.
- `bun test --max-concurrency=2 apps/melete/src/connectors/mcp.test.ts`: 9 pass, 0 fail, 55 assertions; server `$async` schemas are rejected before registration.
- `bun test --max-concurrency=2 apps/melete/src/broker/compose.test.ts`: 20 pass; `apps/melete/test/integration/compose.test.ts`: 10 pass, 0 fail, 78 assertions in 69.31 seconds including fixture startup.
- `bun run typecheck`: passed before review changes; later focused TypeScript check found the new Ajv `$async` property needed an explicit property guard, now corrected before rerunning.
- `packages/contracts/src/entities.ts`: slice 3 production registration stops at the frozen missing MCP provider; `.agents/notes/proposed/2026-09-12-mcp-provider.md` records the required extension and OS isolation gap. The test adapter identifies itself as `test` and is not production registration.
- `clock__curr_time`: returned `2026-09-11 19:51:44 UTC` after that checkpoint was appended; its `19:53` heading is a transcription error. Subsequent timestamps use explicit clock readings.

## Solo continuation — 2026-09-11 20:03 UTC

- `REPORT.md`, `git -C C:/Users/gamin/melete-oss-w10c status --short --branch`, `git -C C:/Users/gamin/melete-oss-w10c log -5 --oneline`: reread after owner steering; continuing sequentially at xhigh with no active subagents and base commit `9484023` intact.
- `bun run typecheck`: passed after the Ajv property guard; `bun run lint` reported only formatting in the in-progress `packages/runtime-hermes/scripts/e2e.ts`, now formatted.
- `bun test --max-concurrency=2 apps/melete/src/broker/catalog.test.ts apps/melete/test/integration/catalog.test.ts apps/melete/test/integration/gateway.test.ts`: 21 pass, 1 fail, 115 assertions in 54.77 seconds. The remaining gateway failure used port zero, rejected by `startEffectBoundary`; it now allocates a valid unused loopback port.
- `bun test --max-concurrency=2 > .agents/w10c-full-tests-shared.log`: interrupted by owner steering before completion; stopped its verified owned Bun PID 880 and Postgres child, then restarted solo.
- `bun test --max-concurrency=2 > .agents/w10c-full-tests-solo.log`: exceeds three minutes; existing knowledge fixtures time out during repeated Git setup (`a beforeEach/afterEach hook timed out`, Git exit 143).
- `packages/knowledge/src/fixtures.ts:seededSpace`: second performance fix cycle copies independently mutable real Git fixtures for lint, mediation, retraction and API route tests; creation/commit behavior still executes in `space.test.ts`. `bunfig.toml` allows 15 seconds for process-backed tests on this shared Windows host, without changing application budget assertions.

## Catalog verification — 2026-09-11 20:14 UTC

- `bun test --max-concurrency=2 > .agents/w10c-full-tests-solo.log`: completed with 963 pass, 14 existing todo, 9 fail and 7 follow-on errors in 682.55 seconds; timeout output is retained locally.
- `bun test --max-concurrency=2 > .agents/w10c-full-tests-final-fixtures.log`: 972 pass, 14 existing todo, 0 fail, 4,107 assertions across 80 files in 329.02 seconds after fixture fixes.
- `bun test --max-concurrency=2`: the whole-suite three-minute target remains unmet after two performance fix cycles. Stop further performance changes under the brief's fix-cycle limit; continue the functional slices and report this limitation in the PR.
- `bun run typecheck` and `bun run lint`: both exit 0; Biome checked 321 files. `git -C C:/Users/gamin/melete-oss-w10c diff --check`: exit 0.
- `service startup binds the W2 internal port and runs pg-boss against the fixture`: passes on an allocated loopback port and proves discovery resolves an installed skill under `personal/skills` through the same space identifier as the knowledge API.
- `packages/contracts` and `docs/ARCHITECTURE.md`: `git -C C:/Users/gamin/melete-oss-w10c diff -- packages/contracts docs/ARCHITECTURE.md` remains empty.
