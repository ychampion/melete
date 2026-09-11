# W7 memory core

## Assumptions

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: the supplied revised memory design supersedes the Markdown authority described in frozen `docs/ARCHITECTURE.md`; that file remains unchanged.
- Command `bun install`: completed with Bun 1.3.13 in `C:/Users/gamin/melete-oss-w7` on `lane/w7-memory` at 2026-09-11 14:10 +05:30; campaign deadline is 19:10 +05:30.
- Command `rg --files .agents apps/melete packages/contracts packages/knowledge`: W1/W2/W4 implementations and `.agents/notes/proposed/2026-09-11-knowledge-api-gaps.md` are absent at the starting SHA; integration hooks will be explicit, and missing frozen-contract hooks will be proposed without changing those types.
- Command `rg -n PENDING_CONTRACT .`: no W4 pending list exists in this checkout. The existing `ProposalStore.list/apply/discard` names define the three additive knowledge operations for this branch; this mapping needs reconciliation when W4 lands.
- Test configuration `bun test --max-concurrency 2`: scripted gateway only; no real-provider smoke step is requested by a slice.
- Log `2026-09-11 14:10 +05:30`: work remains in this worktree; no stash, other checkout, force push, or main push is authorized.

## Initial evidence

- Command `git -C C:/Users/gamin/melete-oss-w7 status --short --branch`: clean `lane/w7-memory...origin/main` before implementation.
- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: broker, gateway, attempt worker, and authenticated API are README stubs; the service currently serves health only.

## Slice 1

- Command `bun run typecheck`: pass; command `bun run lint`: pass (60 files).
- Command `bun test --max-concurrency 2`: 195 pass, 1 baseline DB skip, 36 baseline conformance todos, 0 fail in 995 ms.
- Test `memory authority contracts`: strict scope rejection, typed proposals, empty versus unavailable, and additive OpenAPI operations pass.
- Command `bun run openapi`: regenerated the committed document from the additive schemas.

## Slice 2

- SHA `651df9d`: slice 1 pushed to `origin/lane/w7-memory`.
- Command `bun run db:generate`: new memory tables only; migration `0001_ancient_impossible_man.sql` leaves existing authority tables unchanged.
- Command `bun add -d --exact embedded-postgres@17.10.0-beta.17`: pinned Postgres 17 binaries; fixture listens on 127.0.0.1:3122 and creates a disposable database even with DATABASE_URL supplied.
- Test `persist before acknowledgment, dedup, immutable versions, separate streams`: initial 60 s / 20 s timeouts isolated to Bun's async rejection matcher waiting on a rollback. Fix cycle 1 awaits the rejection before asserting; the test passes in 125 ms.
- Test `concurrent inputs commit contiguous stream sequences and reject cross-space metadata`: pass; test `pg-boss uses the embedded database`: pass.
- Command `bun run typecheck`: pass; command `bun run lint`: pass (65 files); command `bun test --max-concurrency 2`: 198 pass, 1 baseline skip, 36 baseline todos, 0 fail in 18.82 s.

## Slice 3

- SHA `9abf95f`: evidence ledger and new-table migration pushed to `origin/lane/w7-memory`.
- Test `memory resolve rules`: 11 rules pass, including source event time, protected corrections, attributed disagreement, source identity deduplication, temporary exceptions, preference precedence, and reserved job/action authority rejection.
- Test `claim revisions retain exact support and direct corrections are immediate and idempotent`: pass; July remains inspectable with validity and supersession times; August is protected; stale correction evidence rolls back; one active head remains.
- Command `bun run typecheck`: pass; command `bun run lint`: pass (68 files); command `bun test --max-concurrency 2`: 210 pass, 1 baseline skip, 36 baseline todos, 0 fail in 17.40 s.

## Slice 4

- SHA `e1f2e67`: versioned claims and resolve rules pushed to `origin/lane/w7-memory`.
- Test `HTTP extraction racing a correction retries from a fresh fenced snapshot`: pass against the scripted HTTP gateway on 3120; stale revision rejected, replacement fence increased, protected August remains the sole active head.
- Test `whole-set validation rejects wrong spans, spoofed attribution, and conflicting creates`: pass; no partial claim mutation and original evidence remains inspectable.
- Test `continuation cursors and queue repair survive lost delivery and an obsolete lease holder`: pass; cursor stays at zero until the final 20-character continuation commits.
- Command `bun run typecheck`: pass; command `bun run lint`: pass (72 files); targeted command `bun test apps/melete/src/memory apps/melete/test/integration/memory.test.ts --max-concurrency 2 --timeout 20000`: 18 pass, 0 fail in 19.04 s.
- Command `bun test --max-concurrency 2`: 213 pass, 1 baseline skip, 36 baseline todos, 0 fail in 20.54 s before the slice 4 push.

## Slice 5

- SHA `df8f7dd`: fenced extraction and transactional publication pushed to `origin/lane/w7-memory`.
- Test `recall supplements a lagging lexical index and dates historical revisions`: pass; current August, historical July, degraded lag, complete empty search, unavailable failed search, byte-budget trimming, poisoned candidate rejection, and revoked-source rejection are distinct assertions.
- Test `lexical and dense candidates are independent and incompatible embeddings fail closed`: pass; lexical-only July survives a dense-only August pool; mismatched embedding versions and dimensions fail without publishing an incomplete generation.
- Test `cache identity binds audience, policy, data, access, job revision, query, and recipe`: pass.
- Log `TypeError: The string argument must be of type string ... Received an instance of Array`: slice 5 fix cycle 1 uses explicit text-to-jsonb parameters because the installed Drizzle driver changes JSON serializers on the shared postgres.js handle; the TypeScript callback-narrowing error was fixed in the same cycle.
- Command `bun run typecheck`: pass; targeted command `bun test apps/melete/src/memory apps/melete/test/integration/memory.test.ts --max-concurrency 2 --timeout 20000`: 22 pass, 0 fail in 28.62 s.
- Command `bun run lint`: pass (75 files); command `bun test --max-concurrency 2`: 217 pass, 1 baseline skip, 36 baseline todos, 0 fail in 28.88 s before the slice 5 push.

## Slice 6 progress at 15:14 +05:30

- SHA `93ffb03`: published indexes and scoped recall pushed to `origin/lane/w7-memory`.
- Test `correction fences dependent attempts, clears drafts, and preserves action receipts`: pass; invalidation events persist, callback discards delivered context, job revision/epoch advance, previous approval binding is stale, and the succeeded action receipt remains unchanged.
- Test `approved shared context and public compartments are assembled before delivery`: pass; the companion receives shared August only and public research receives no private memory.
- Test `forget suppresses old replay, allows fresh explicit evidence, and survives an old database snapshot`: pass against a real Postgres table snapshot and an independently fsynced restriction journal.
- Test `deletion hides synchronously, cleanup failures retry, and startup refuses a missing journal`: pass; serving restrictions precede physical cleanup, and a failed startup replay leaves recall and extraction gated.
- Test `source and space revocation invalidate delivered context and block stale serving`: pass across replay.
- Command `bun run typecheck`: pass; targeted memory tests: 27 pass, 0 fail in 30.19 s; lint fix cycle 1 removed unsafe optional indexing in a test assertion.
- Log `frozen EventType`: memory invalidation events are stored in `memory_invalidations` and bridged through the existing `notice` event payload. The missing W1/W2 admission/worker integration remains described in `.agents/notes/proposed/2026-09-11-memory-integration-hooks.md`.
- Command `bun run typecheck`: pass; command `bun run lint`: pass (82 files); command `bun test --max-concurrency 2`: 222 pass, 1 baseline skip, 36 baseline todos, 0 fail in 29.51 s before the slice 6 push.
- Test `source excerpts`: publication/indexing and supplemental retrieval now use exact UTF-16 source offsets; partial suppression masks text without moving those offsets.

## Slice 7 at 15:39 +05:30

- SHA `ca30974`: correction, forgetting, revocation and restore adapters pushed to `origin/lane/w7-memory`.
- Test `authenticated routes reject body scope, foreign claim IDs, and reader writes`: pass; server-injected scope is required and missing authentication returns 401.
- Test `Markdown round trips support, preserves local edits, and owner edits become protected revisions`: pass; exact source spans and revision timestamps survive frontmatter parsing, owner edits produce protected `owner_edit` evidence, and unrelated staged files survive derived Git commits.
- Test `review mediation stages diffs and revalidates apply against authoritative evidence`: pass; `.proposed/` previews share eventual stable claim IDs, approval rechecks expected revisions, stale approval returns 409, and discard terminates durable work.
- Test `view paths reject directory links before any claim content is written`: pass; no content reaches the redirected directory.
- Log `slice 7 fix cycles`: typecheck cycle 1 removed an unused import; cycle 2 parsed HTTP test responses through their schemas. Integration cycle 1 scoped the Markdown fixture to its own temporary space rather than scanning unrelated test spaces.
- Command `bun run openapi`: regenerated; command `bun run typecheck`: pass; command `bun run lint`: pass (85 files); command `bun test --max-concurrency 2`: 226 pass, 1 baseline skip, 36 baseline todos, 0 fail in 10.61 s.
- Command `rg -n PENDING_CONTRACT .`: W4's list remains absent, so no existing list can be emptied; the three implemented operations are list, apply, and discard as recorded in the proposed integration note.

## Assumptions continued for slice 7

- Test `Markdown round trips support, preserves local edits, and owner edits become protected revisions`: disposable space repositories under the test-created temp root exercise the required Git view builder; they are independent fixtures, not another Melete worktree.
- Log `Markdown retention`: cleanup removes generated working files, pending previews and SQLite entries; Git history and copied exports remain retained copies and are not rewritten by memory cleanup.

## Slice 8 at 15:55 +05:30

- SHA `7283e20`: Markdown projections, protected owner edits and review routes pushed to `origin/lane/w7-memory`.
- Test `July to August survives sessions, an old import, correction races, process kills, scope, forget, and restore`: pass; one integrated scenario covers the full trip acceptance sequence, including real OS kills after proposal and publication, dated July support, protected August, fresh October evidence after forgetting, and independently journaled suppression replay.
- Tests `process killed after-input`, `after-claim`, `after-proposal`, `before-publication`, and `after-publication`: pass against the same live Postgres server after each worker is killed; cursors advance only for committed terminal work and obsolete fences cannot release or publish over a replacement lease.
- Test `duplicate delivery and reversed extraction order preserve contiguous cursors and event-time meaning`: pass; reversed processing leaves the cursor at zero until the missing earlier work commits, then advances to two while August remains current.
- Test `kill during cleanup and restore from a pre-deletion backup never reopen serving`: pass; unfinished cleanup stays retryable, its source content remains unservable, and replay closes a restored old snapshot before extraction resumes.
- Tests `extraction calls and source segments are bounded before inference`, `database timeout is unavailable and a successful empty search is complete`, and `failed index publication keeps its old manifest and retries after a correction`: pass.
- Log `22P05 WIN1252`: failure-schedule fix cycle 1 creates the disposable database from template0 with UTF8 and C locale, because Windows initdb inherited WIN1252. Test `Unicode spans and partial suppression retain only independently supported text` now passes with exact UTF-16 offsets and a retained independent food preference.
- Tests `runtime adapter discards delivered context and rejects events after an owner correction` and `automatic retraction invalidates attempts that already received its text`: pass; stale events/outcomes do not reach the sink, and extraction retractions now emit the same durable invalidations as direct corrections.
- Test `startup gates serving, pg-boss derives scope from work, and background indexing catches up`: pass in a separate disposable database on the embedded server; a forged queue space is ignored, one scripted extraction runs, and the asynchronous index reaches complete coverage.
- Test `authenticated routes reject body scope, foreign claim IDs, and reader writes`: now also verifies the additive source-inspection GET route and source text denial for a reader or foreign space.
- Log `memory comparison`: six scripted fixture outcomes pass for each strategy; compact profile/source baseline p50 3.74 ms, p95 6.08 ms, max 295 context bytes; lexical p50 5.14 ms, p95 6.07 ms, max 866 bytes; pinned dense union p50 9.89 ms, p95 13.87 ms, max 866 bytes. One gateway call reserves USD 0.01; scripted charged cost is USD 0. These six samples do not establish an answer-quality or performance advantage.
- Command `bun run typecheck`: pass; command `bun run lint`: pass (91 files); command `bun test --max-concurrency 2`: 242 pass, 1 baseline DB skip, 36 baseline conformance todos, 0 fail, 930 assertions in 16.91 s.
- Command `git -C C:/Users/gamin/melete-oss-w7 diff --check`: pass; command `bun run openapi`: regenerated after the additive source-inspection route.

## Slice 9 at 16:15 +05:30

- Log `handover`: the codex agent that built slices 1-8 stopped at its usage limit during slice 9. This section is written by the finishing agent from the state on disk at SHA `9857ea9`.
- Command `git -C C:/Users/gamin/melete-oss-w7 diff`: the inherited uncommitted work is three files. `apps/melete/src/memory/routes.ts` adds the `message` field that the frozen `errorResponse` contract requires and that the previous handler omitted, maps `invalid_forget_target` and `invalid_validity` to 400 and `source_version_conflict` and `idempotency_conflict` to 409 instead of 503, and reads a request body through a streaming byte cap with a fatal UTF-8 decoder. `apps/melete/test/integration/markdown-tests.ts` covers the 401 body shape, the 400 for an empty forget target, and the 400 for an oversized body. `.agents/notes/proposed/2026-09-11-memory-integration-hooks.md` records that the call reservation is a test policy and that scope must come from verified membership. All three are kept: they are coherent with the committed code and covered by the tests below.
- Command `bun run openapi`: regenerated; `packages/contracts/openapi.json` is unchanged, so the status and message work matches the already committed contract.
- File `docs/MEMORY.md`: finished for a self-hosting reader. Added the relationship to the `docs/ARCHITECTURE.md` files principle, `memory_streams` and `memory_proposals` in the location table, a worked trip correction with real request bodies on the default port 8787, the HTTP status meanings, the coverage reasons `ready`, `index_lag`, `budget`, `timeout`, `index_failure`, `restore_pending` and `public_compartment`, and a section on how restoring a backup replays removals before serving resumes.
- File `README.md`: the docs row now links `docs/MEMORY.md`.
- Command `bun run typecheck`: pass.
- Command `bun run lint`: pass, 91 files checked.
- Command `bun test --max-concurrency=2`: 242 pass, 1 baseline DB skip, 36 baseline conformance todos, 0 fail, 933 assertions, 279 tests across 23 files in 21.76 s.
- Test `trip acceptance`: pass; log line `current August, dated July, 2 process kills, stale proposal rejected, no cross-space delivery, suppression replayed; parent scripted calls=2`.
- Log `memory comparison`: `{"fixtures":6,"strategies":{"baseline":{"checks_passed":6,"p50_ms":2.73,"p95_ms":3.22,"max_context_bytes":295},"lexical":{"checks_passed":6,"p50_ms":3.86,"p95_ms":4.35,"max_context_bytes":866},"hybrid":{"checks_passed":6,"p50_ms":6.16,"p95_ms":7.54,"max_context_bytes":866}},"extraction_calls":1,"reserved_usd":"0.01","charged_usd":0,"provider":"scripted"}`. Six scripted fixtures are not evidence of a retrieval advantage.
- Command `bun run compose:check`: pass, 11 checks, including `the internal network has no route out` and `the runtime publishes no ports`.
- Log `fix cycles`: none were needed in this slice; every check passed on its first run.

## Assumptions continued for slice 9

- File `docs/ARCHITECTURE.md`: left unchanged because the brief freezes it. Its files principle and the Postgres authority are reconciled in `docs/MEMORY.md` instead of by editing the frozen file.
- File `docs/MEMORY.md`: the curl examples use the default `PORT` of 8787 from `apps/melete/src/env.ts` and a claim ID in the `k_` ULID form the contracts require. They are illustrative; no authentication header is shown because this checkout's authentication module is still a stub.

## Integration note: migrations renumbered on merge

Added by the integration pass, not by the lane.

W1 landed on `integration` first and owns migrations `0001_auth` through
`0008_scheduling_attention`. This lane authored its two migrations against
`0000_initial_schema`, so both indexes collided on merge.

The two migrations were renumbered to follow W1 rather than rebased in the lane:

| Lane | On `integration` |
|---|---|
| `0001_ancient_impossible_man` | `0009_ancient_impossible_man` |
| `0002_mysterious_silverclaw` | `0010_mysterious_silverclaw` |

Both `.sql` files are byte-identical to the lane's originals; only their
filenames changed. Their journal entries keep the lane's original `when`
timestamps and were reindexed to 9 and 10.

The snapshots could not simply be renamed, because a drizzle snapshot is
cumulative: this lane's `0002_snapshot.json` describes the baseline plus memory
and knows nothing of W1's eight migrations. `0009_snapshot.json` and
`0010_snapshot.json` were therefore rebuilt as W1's `0008_snapshot.json` plus
the nineteen tables this lane's first migration adds, then plus
`memory_dense_entries` from its second, with the `id`/`prevId` chain relinked.
`bun run --cwd apps/melete db:generate` reports `No schema changes, nothing to
migrate` against the rebuilt chain.

The journal `when` values had to be raised as well, and this is the one part of
the renumbering that is not cosmetic. `drizzle-orm`'s migrator reads the single
newest `created_at` from `drizzle.__drizzle_migrations` and then applies a
migration only when that value is strictly less than the migration's `when`
(`pg-core/dialect.js`). This lane authored its migrations before W1 authored
`0003` through `0008`, so leaving the original timestamps in place at indexes 9
and 10 would have left them permanently below the newest applied row: a
database that already had `0000` through `0008` would skip both memory
migrations silently and never create the twenty memory tables. A fresh database
is unaffected, because the table starts empty, which is why no test would have
caught it.

The two entries therefore carry timestamps one minute after `0008`, keeping the
lane's own interval between them:

| Migration | Lane `when` | On `integration` |
|---|---|---|
| first | 1789116510570 | 1789122489858 |
| second | 1789118161849 | 1789124141137 |

Neither migration had been applied to any database, so no deployment is
affected by the renumbering.
