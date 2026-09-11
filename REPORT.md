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
