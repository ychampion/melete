# Prod-readiness pass on integration 55b6a50

Branch `lane/prod-readiness`, based on `origin/integration` 55b6a50. Append-only.

## Assumptions

- The brief names `main` in one place and `integration` in another as the PR
  target; the landing ledger and the team lead name `integration`. The PR
  targets `integration`.
- The brief forbids subagents and says to do the work in this session; that
  overrides the standing orchestrator-only rule for this task.
- The VPS checkout at `$HOME/melete-land` has no GitHub credential, so the lane
  branch was pushed to it over SSH after detaching its HEAD; nothing outside
  `$HOME` was touched.
- "One builder" for the delta brief: `buildSinceLast`, inside the lease
  transaction, is the only place a brief is built. `buildBundle` keeps its
  post-lease role (recall, tools, repair briefs) and completes that same brief
  with the memory sources only readable under the memory scope; it no longer
  builds a second brief.
- The one-clock rule is applied where a database timestamp met process time in
  a decision (the runner's claim guard and the recovery scan), not to every
  `Date.now()` that writes a lease.
- Two hanging assertions in `runtime/context.test.ts` are rewritten to settle
  the promise by hand instead of skipping on win32: the behaviour under test is
  unchanged and the file now passes on both platforms.

## Linux reproduction (VPS, bun 1.3.13, Debian, DATABASE_URL set)

- `deploy/scripts/serve-static.test.ts` on 55b6a50: 23 pass, 0 fail, 377 ms.
  The "first request answered, the rest time out" report from bun 1.3.12 does
  not reproduce with bun 1.3.13.
- On 9adb6e7: `execution-admission.test.ts`, `home.test.ts`, `runner.test.ts`,
  `serve-static.test.ts`, `compose-check.test.ts`, `artifacts.test.ts`,
  `runtime/context.test.ts`, `python.test.ts`, `dates.test.ts`,
  `preflight.test.ts`: 114 pass, 0 fail across 10 files, 13.6 s.
  `bun run doctor` on that host: every prerequisite present.

## Commits

- caf67e5 Resolve the Python interpreter once for the supervisor and the plugin tests.
  New `apps/melete/src/runtime/python.ts` (explicit path, then `MELETE_PYTHON`,
  then `python3`, then `python`; an explicit path that does not exist fails by
  name). `ProcessRuntimeSupervisor` resolves through it before spawning;
  `execution-admission.test.ts` and `artifacts.test.ts` use it. Test:
  `apps/melete/src/runtime/python.test.ts`, 2 pass.
- 72b9e39 Assemble people-facing dates from parts instead of locale strings.
  New `apps/melete/src/dates.ts` (`describeDate`, `describeDay`, `numericDate`
  from `formatToParts`); used by `experience/home.ts`, `experience/evidence.ts`,
  `experience/rules.ts`, `memory/trust.ts`. Test: `apps/melete/src/dates.test.ts`;
  `home.test.ts` and `trust.test.ts` unchanged, passing on both platforms.
- d12079d Name each missing test prerequisite once before the suite runs.
  New `apps/melete/test/helpers/preflight.ts` (root uid, writable TMPDIR,
  libpq5, DATABASE_URL on Linux, uv), printed by the preload and by
  `bun run doctor`; `database.ts` refuses to start embedded Postgres with the
  named reason and maps libpq/ICU startup errors to "set DATABASE_URL on
  Linux". CONTRIBUTING.md gained one paragraph. Test:
  `apps/melete/test/helpers/preflight.test.ts`, 3 pass.
- 44e9a4e Prove the static server answers several requests on one connection.
  New case in `deploy/scripts/serve-static.test.ts`: three requests on one
  keep-alive socket, close on request. 24 pass on Windows and Linux.
- d2d1e21 Restore the build-only runtime image service and the two compose guards.
  `deploy/docker-compose.yml`: `melete` depended on `runtime-image`, which the
  landed file no longer declared; Compose refuses such a project before
  anything starts. Restored as a build-only service (`entrypoint: /bin/true`,
  `network_mode: none`); `runtime` uses the image it builds. `compose-check.ts`
  gains "every dependency names a service in the file", "the supervisor image
  is built without a running engine" and "the warm cell carries no attempt
  authority" (no service secret, no `${...}` substitution, no signed token in
  the static cell). PR #21's development-profile check is covered by the
  adapter check plus the authority check and is not restored as written.
  `bun run compose:check`: 22 checks pass. Tests: three new cases in
  `compose-check.test.ts`.
- 9adb6e7 Judge wakes by the database clock and end every attempt a later epoch fences.
  `jobs/runner.ts`: `claim` and the recovery scan compare `next_wake_at` and
  `lease_expires_at` with `select now()` from the same transaction; the claim
  ends every still-open attempt on the job as `fenced/superseded` before the
  epoch bump; the recovery scan closes an expired attempt of a stale epoch
  without moving the job. Tests in `runner.test.ts`: "a wake is judged by the
  database clock, not by a process clock up to 50 ms off", "an attempt still
  open when a later epoch claims the job ends as superseded", "the recovery
  scan closes an expired attempt a later epoch already fenced". Against the
  55b6a50 runner all three fail (`Expected an admitted attempt`;
  `expect(received).not.toBeNull() Received: null` twice); with the fix the
  file has 31 pass on Windows and on Linux.

## Windows hang, apps/melete/src/runtime/context.test.ts

An instrumented copy with a timestamp before each statement: every step of the
fourth case up to
`await expect(f.memory.scopeForJob(newId('job'))).rejects.toThrow('scope_denied')`
completes within 2 ms of the previous one; that statement never settles (the
case fails at 60016 ms under `--timeout=60000`). A probe placed just before it
shows the same call rejecting with `Error: scope_denied` within 1 ms and
`select 1` on the same pool resolving before and after; a standalone
`expect(Promise.reject(new MemoryError('scope_denied'))).rejects.toThrow(...)`
passes on this box. Because the `finally` never runs, pg-boss keeps
reconnecting after the preload stops Postgres and the process never exits:
that is the hang seen at every head since PR #18. With the assertion settled
by hand (`.then(() => null, (error) => error)` plus `toBeInstanceOf` and a
`code` check) the case passes in about 1 s; the sixth case then showed the same
hang on its `rejects.toThrow('stale_attempt')` and got the same treatment.
The file passes on Linux unchanged and on Windows after the change.

## Further commits

- 8839f14 Build the delta brief once and render it once. Contract (additive):
  `SinceLast.evidence[].kind` gains `source`; `inputs.since_last` is marked
  deprecated and stays optional. `buildBundle` no longer builds a second
  brief; it appends memory-source evidence to the delta the skeleton built.
  `memory/context.ts` carries the completed delta into the attempt.
  `packages/runtime-hermes/src/instructions.ts` renders the delta once through
  `renderSinceLast`. Tests updated: `bundle-assembly.test.ts`
  (`inputs.since_last` undefined, one `source` evidence item),
  `wired-assistant.test.ts` (skipped on both hosts: no `.hermes-venv`),
  `runtime-hermes/src/client.test.ts`. `bun run openapi` and
  `bun run client:generate`: no drift (the bundle is not an HTTP shape).
  Note: `.agents/notes/proposed/2026-09-12-prod-readiness-contract-additions.md`.
- e836a94 Settle two rejections by hand in the deployment context test (see the
  hang section above). `context.test.ts`: 6 pass on Windows within a 28 s
  batch of six files; passes on Linux.
- ccc33c0 Let the environment raise the fault-child and retraction fixture
  timeouts: `MELETE_TEST_CHILD_TIMEOUT_MS` is read by
  `test/helpers/process-fault.ts` (default 15 s) and by the
  `knowledge/src/retraction.test.ts` fixture (default 20 s). Test:
  `test/helpers/process-fault.test.ts` spawns a child with the variable set to
  45000 and reads the constant back.
- 6ad229c Keep biome clean: `bun run lint` failed on 55b6a50 with
  `lint/correctness/noUnusedImports` on an empty named import from postgres
  in `apps/melete/test/integration/postgres.ts`; removed, plus import order and
  formatting in files this branch touched. `bun run lint`: 537 files, clean.

## Checks on 6ad229c

- `bun run typecheck`: exit 0 (run after the source changes of 8839f14).
- `bun run lint`: clean.
- `bun run compose:check`: 22 checks pass. `bun run browser:compose:check`: 11 pass.
- `bun run test:plugin`: 60 passed in 26 s (Windows, uv, Python 3.12).
- `bun run openapi`, `bun run client:generate`: no diff.
- Linux full suite (VPS, bun 1.3.13, Debian, real Postgres 17, `bun run test`
  wrapped in `timeout 900`): 1530 pass, 61 skip, 0 fail across 151 files,
  150.8 s wall. The landed tree had 1518 pass, 4 fail, 61 skip.

## Audit (read the code)

1. Startup and configuration. `loadEnv` has no default secret: every key
   (`MELETE_MASTER_KEY`, `MELETE_CAPABILITY_KEY`, `MELETE_APPROVAL_KEY`,
   `MELETE_RUNTIME_KEY`) is optional with `min(32)`, and `bootstrap()` throws
   a named error when a selected path needs one (`MELETE_CAPABILITY_KEY is
   required to issue attempt capabilities`; `Docker runtime supervision
   requires MELETE_RUNTIME_KEY and Postgres`). `MELETE_API_BIND` defaults to
   `127.0.0.1`; the compose file binds the API to the edge alias and the
   compose check refuses `0.0.0.0`. The process-supervisor warning is written
   to stderr at bootstrap. Nothing changed.
2. Durability. The claim guard and the recovery scan compared database
   timestamps with `Date.now()`: fixed in 9adb6e7. Superseded attempt rows
   without an end timestamp (the W6 finding): fixed in 9adb6e7 on both the
   claim path and the recovery scan. Every long-lived interval found calls
   `unref` (`broker/start.ts` recovery, `events/stream.ts` poll, `index.ts`
   episode retention, `learning/start.ts`, `memory/start.ts`,
   `memory/context.ts`, `memory/service.ts`); the runner heartbeat is per
   attempt and cleared in its `finally`. No unbounded retry loop found in the
   runner; pg-boss wakes carry `retryLimit: 0`.
3. Broker. `lockJob` takes `pg_advisory_xact_lock(EVENT_ORDER_LOCK)` before
   the row lock (PR #16). Measured on this laptop with embedded Postgres and
   twenty jobs proposing one `test.read` action each: 20 sequential proposals
   830 ms (41 ms each); 20 concurrent proposals across 20 jobs 278 ms; 60
   concurrent proposals 628 ms. The global lock serialises proposals to
   roughly 10 to 14 ms each under concurrency, about 70 to 100 proposals per
   second on this box. Not redesigned.
4. Memory. One active head per key, the correction and forget paths, and the
   repair scan are covered by the landed property tests (E1 to E4), which pass
   in the full runs; nothing changed here.
5. Runtime cell. `dockerRunArguments` carries the internal network,
   `--read-only`, `--user 10001:10001`, `--cap-drop ALL`,
   `--security-opt no-new-privileges:true`, `--pids-limit 256`, `--memory 2g`,
   `--init`, the per-attempt `/work` volume subpath, and tmpfs for `/tmp` and
   the Hermes home; the HostConfig in the docker adapter matches it. The
   static cell in the compose file is covered by 22 compose checks, including
   the three restored in d2d1e21.
6. Connectors and workers. Not re-audited beyond the timer sweep above;
   deferred for time.
7. Tests. See the suite results.
8. Docs. CONTRIBUTING.md only (Linux prerequisites and `bun run doctor`).
   No README or docs/*.md change.

## Items from the brief

| Item | Outcome |
|---|---|
| Python interpreter resolution (three Linux failures) | fixed, caf67e5 |
| Greeting ICU date string (fourth Linux failure) and the other locale strings | fixed, 72b9e39 |
| Linux prerequisites preflight (`bun run doctor`): root, TMPDIR, libpq5, uv | fixed, d12079d |
| embedded-postgres as root: one-line instruction | fixed, d12079d (fails with the named reason; does not create a user) |
| embedded-postgres ICU 60 on current Debian: say "set DATABASE_URL on Linux" | fixed, d12079d; a newer embedded build was not attempted |
| CI workflow with a postgres service container | not found: the repo has no `.github/workflows`; documented in CONTRIBUTING.md instead |
| Static server answers only the first request on Linux | not reproduced with bun 1.3.13 (23 pass on Debian); guard test added, 44e9a4e |
| runtime/context.test.ts Windows hang | fixed, e836a94 (root cause in the hang section) |
| Two `since_last` shapes, two builders | fixed, 8839f14 (one shape, one brief builder; see Assumptions) |
| PR #21 dropped compose checks and the `famous_nova` migration | two checks restored in the landed shape and the dangling `runtime-image` dependency fixed, d2d1e21; the development-profile check is covered by existing checks; the migration stays dropped (duplicate column) |
| Superseded attempt rows without an end timestamp (W6) | fixed, 9adb6e7 |
| Database clock versus process clock (lander) | fixed, 9adb6e7 |
| Process-fault and retraction timeouts under load | fixed, ccc33c0 (environment variable); running them serially and last was not done |
| Full-run wall-clock cap for the lock protocol | the full runs here wrapped `bun run test` in `timeout 900`; no repo change |
| W6 plugin re-pin after landing | verified: `bun run test:plugin` 60 pass on the landed plugin; no re-pin needed on this branch |
| W6 real-provider comparison (scenario 8) | skipped: no key |
| W10c full suite 212 s versus 180 s target | Linux 151 s; Windows below |
| Release scrub of local paths in `.agents/notes` | left to the release lane, as instructed |
| PR #16 approval gate `=== null` on a missing row | not found in the landed broker (no such gate in `broker/service.ts`) |
| Runtime cell reaching the control-plane API (W6) | verified fixed on the landed tree: `MELETE_API_BIND: melete-api`, edge alias only, and the compose check for it |
| Contract gaps the UI needs (POST /memory/items and others) | not done; outside this pass |

## Final section

- Windows full suite on 6ad229c, once, under the shared lock (acquired
  11:13:36, released 11:18:41, `timeout 900 bun run test`): 1557 pass,
  29 skip, 0 fail across 151 files, 304.6 s wall. Over the 4-minute target on
  this box, which was running several other agents at the time; the same suite
  took 151 s on the Linux host.
- Linux full suite on 6ad229c: 1530 pass, 61 skip, 0 fail, 150.8 s.
- Deferred with reason: running the process-fault files serially and last
  (the environment variable closes the reported failure mode); a newer
  embedded-postgres build for current glibc/ICU (DATABASE_URL is the
  documented Linux path); connectors and workers audit beyond the timer sweep;
  the UI contract gaps.
- Not found: a CI workflow to change; the PR #16 approval-gate null comparison
  in the landed broker.
