# W1 service delivery

## Assumptions

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: frozen contracts stay unchanged; stub `{"script":[...]}` is encoded in `job.constraints.notes`, whose contract permits a string.
- Test `lease fencing`: expired attempts keep contract outcome `fenced` and loss metadata; an internal lease status may name `lost` without adding a public outcome.
- Test `SSE replay`: persisted `notice` payloads identify `gap` and `receipt`; SSE may frame the gap as `event: gap` without changing the frozen event enum.
- Command `bun test`: use throwaway Postgres 17 databases, at most two concurrent tests, W1 API port 3100 and broker port 3102 when binding ports.
- Command `bun test`: all runtime tests use scripted fake outcomes; no slice requests a real-provider smoke call.

## Initial inspection

- Command `git -C C:/Users/gamin/melete-oss-w1 status --short --branch`: `lane/w1-service...origin/main`, clean before dependency installation.
- Command `bun install`: `126 packages installed [4.67s]`.
- Command `bun add --dev embedded-postgres@17`: no stable version matched; command `bun add --dev --exact embedded-postgres@17.10.0-beta.17` succeeded (`6 packages installed [9.13s]`).
- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: read `docs/ARCHITECTURE.md`, frozen contracts, `.agents/notes/`, service skeleton and conformance assertions 1, 2, 5.

## Slice 1: auth and spaces

- Test `single-owner authentication against Postgres`: setup uses an atomic singleton index, Argon2id password hashes, hashed persistent sessions, and one personal space; setup signs in, minimum password length 8, session expiry 30 days.
- Test `browser mutation gates`: rejects mismatched Origin and cross-site browser requests; script clients may omit Origin.
- Command `bun test apps/melete/test/integration/auth.test.ts`: `9 pass`, `0 fail`, `49 expect() calls`, `11.12s` before adding the migrated-database ping assertion.
- Command `bun run typecheck`: passed (`$ tsc -b`).
- Command `bun run lint`: passed (`Checked 78 files in 124ms. No fixes applied.`); `.omx` runtime state is excluded from source lint and Git.
- Command `bun test --dots`: `283 pass`, `36 todo`, `0 fail`, `908 expect() calls`, `Ran 319 tests across 24 files. [24.38s]`; this working-tree run also exercised the prepared job and runtime unit slices, whose commits follow separately.
- Test `illegal inputs from queued`: initial rejection-matcher loop timed out at 5 seconds; first fix split state cases, second fix used native await/catch after Postgres showed `ClientRead` with no blockers. Final focused run: `14 pass`, `0 fail`, `252 expect() calls`, `12.99s`.
