# W2 effect boundary — `lane/w2-broker`

## Assumptions

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: frozen contracts and architecture govern; the brief's section numbers differ from the checked-in headings.
- Test `action status`: reconciliation resolves to `succeeded`, `failed`, or `unresolved`; the frozen contract has no `reconciled` status.
- Command `bun install`: completed in `C:/Users/gamin/melete-oss-w2`, Bun 1.3.13, 126 packages installed.
- Command `git -C C:/Users/gamin/melete-oss-w2 status --short --branch`: clean lane branch before edits; no other checkout is used.
- Log `campaign start 2026-09-11 07:49 UTC`: five-hour limit ends at 12:49 UTC.
- Test `private compartment`: missing public-compartment flag is treated as private; only trusted persisted job constraints select the compartment.

## Slice 1 — broker HTTP surface

- SHA `65e26f1438cd5c8e95e7bf160f456be07d8cb534`: reviewed architecture, contracts, decision notes, and service skeleton before implementation.
- Command `bun test --max-concurrency=2`: 199 pass, 1 existing DATABASE_URL skip, 36 pre-existing conformance todos, 0 fail, 18.68 seconds.
- Command `bun run typecheck`: passed after two test-response typing fixes (`Response.json()` is unknown); no contract edits.
- Command `bunx biome check apps/melete/src/broker apps/melete/src/connectors/types.ts`: passed; whole-tree lint deferred while later connector slices are being authored.
- Test `attempt credential cannot approve itself`: approval route requires a distinct API-only bearer credential; capability JWTs cannot self-approve.

## Slice 2 — durable action lifecycle

- SHA `71ee0f6`: broker HTTP gate pushed to `origin/lane/w2-broker`.
- Command `bun test apps/melete/test/integration/broker.test.ts --max-concurrency=2`: 10 pass, 60 assertions, 0 fail, 10.56 seconds against embedded Postgres 17.
- Test `approval and wake commit together in pg-boss`: approval decision, job wake and real queue row share the transaction.
- Test `late receipt after cancellation is stored without reopening work`: receipt late=true, job remains cancelled at the bumped epoch.
- Test `proposal retries reuse action identity across service restart and refuse edited content`: same client_ref retrieves one action; changed content is rejected.
- Log `ZodError created_at Invalid ISO datetime`: fixed the Drizzle-shared timestamp text conversion at the broker read boundary (first fix).
- Log `Bun rejects.toMatchObject stalled postgres BEGIN`: direct asynchronous rejection observation resolved retry/denial test stalls (second fix); production rejection independently reproduced with rollback.
- Command `bun run typecheck`: passed with integration helper and test sources included in tsconfig.
- Command `bun test apps/melete/test/integration/postgres.test.ts --max-concurrency=2`: 2 pass; actual Postgres 17 and pg-boss enqueue/fetch/complete.
- Command `bun test --max-concurrency=2`: full suite 268 pass, 1 existing DB skip, 36 pending conformance todos, 0 fail, 36.80 seconds; supersedes the interrupted full run that loaded the pre-fix destination encoder.
- Log `pg_ctl ... melete-w2-postgres-9a160y/data stop -m fast -w`: stopped the interrupted full-run fixture; its temporary data is preserved.
- Log `automatic approval review blocked by policy`: one failed destination-test temporary-directory cleanup was rejected; its Postgres process is stopped and the directory is preserved.

## Slice 3 — transactional budgets

- SHA `721e377`: lifecycle and embedded Postgres fixture pushed to the lane branch.
- Command `bun test apps/melete/test/integration/budget.test.ts --max-concurrency=2`: 6 pass, 19 assertions, 0 fail, 11.55 seconds.
- Test `two parallel reservations against a small allowance admit exactly one`: 7 tokens reserved against a 10-token job ceiling; one contender rejected.
- Test `a new attempt cannot spend a previous attempt allowance again`: job-wide ledger totals survive epoch changes.
- Test `gateway reserves both requests and tokens before recording a provider result`: request cap under row lock; token reservation before request, settlement to actual usage, duplicate receipt idempotent.
- Test `gateway retains unknown usage and rejects a principal after the epoch bump`: missing usage remains charged and cancellation remains visible.
- Command `bun run typecheck`: passed, including budget integration tests; full-suite evidence is 268 pass / 0 fail above.

## Slice 4 — files, test destination, and web

- SHA `fbeab86`: atomic gateway budget adapter and request/token reservation tests pushed.
- Command `bun test apps/melete/src/connectors --max-concurrency=2`: core files/test/web/registry coverage is 18 pass, 88 assertions, 0 fail (322 ms focused run).
- Test `destination accepts nested JSON with the SQL client shared by Drizzle`: explicit JSON text binding fixes the captured ERR_INVALID_ARG_TYPE encoder failure.
- Command `bun test apps/melete/test/integration/test-destination.test.ts --max-concurrency=2`: 3 pass, 9 assertions, 0 fail, 8.48 seconds; durable ledger and separate-handle verification.
- Test `parallel destination retries retain exactly one durable acceptance`: action.id is the destination primary idempotency key.
- Test `web SSRF guard`: rejects private/link-local/mapped ranges, mixed DNS answers and private redirects; pins the checked address through the transport.
- Test `files traversal`: rejects parent segments, absolute/device/stream paths and existing symbolic links; trusted roots define the job and space boundary.
- Log `files boundary limitation`: portable checks require service-controlled directory structure and do not claim protection against another process racing directory replacement.
- Command `bun test --max-concurrency=2`: full-suite 268 pass / 0 fail / 36.80 seconds includes the corrected destination integration.
