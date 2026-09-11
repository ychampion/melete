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

## Slice 5 — mail, calendars, and sealed secrets

- SHA `d9297ac`: core connector boundary and durable destination tests pushed.
- Command `bun test apps/melete/src/connectors/email.test.ts apps/melete/src/connectors/mail-transport.test.ts apps/melete/src/connectors/calendar.test.ts apps/melete/src/connectors/secrets.test.ts --max-concurrency=2`: all 18 tests passed using local IMAP/SMTP/CalDAV doubles.
- Test `secret.safeParse`: generated secret references use frozen prefixed ULIDs; sealed box ciphertext binds the record and space, rejects tamper, row swaps and wrong keys.
- Test `SMTP acknowledgement loss`: stable action-derived Message-ID can be verified in Sent without a second send.
- Test `CalDAV verification`: compares UID, action/hash marker and approved fields; stale ETags and credential redirects rejected.
- Test `inbox hygiene`: MIME-decoded OTP, password reset and magic link content withheld from search and read; documented as best-effort.

## Assumptions — connector semantics

- Test `email.draft`: local durable draft lives in its action receipt; only email.send writes to the mailbox transport.
- Test `calendar.update`: preserves the creation action UID and records the update action/hash in ICS, because replacing UID would identify a new event.
- Test `ICS import`: read-only series list includes recurrence rules; recurrence occurrences are not expanded.
- Test `email.health`: IMAP connectivity is checked; this does not claim SMTP delivery.

## Slice 6 — gateway integration in progress

- SHA `7c6749a`: mail/calendar/sealed-secret slice pushed; focused mail suite is 18 pass / 96 assertions / 735 ms.
- Command `git -C C:/Users/gamin/melete-oss-w2 status --short --branch`: re-read with REPORT.md at owner resume, 2026-09-11 08:25 UTC; continuing from existing edits.
- Command `bun test apps/melete/src/gateway --max-concurrency=2`: 14 unit tests / 68 assertions green, including actual CONNECT with a test-only certificate and metered inner requests.
- Test `scripted fake streams through the gateway, broker approval, destination, and final response`: passed against real HTTP and Postgres with two persisted model usage records and one destination delivery.
- Test `service startup binds the W2 internal port and runs pg-boss against the fixture`: passed on 127.0.0.1:3112.
- Log `cancellation fences both broker and provider HTTP routes ... timed out after 5000ms`: focused diagnosis in progress before slice 6 commit.

## Slice 7 — conformance verification

- Command `bun test conformance/scenarios/03-unknown-outcomes.test.ts conformance/scenarios/04-approval-binding.test.ts --max-concurrency=2`: 11 pass, 84 assertions, 0 fail, 34.70 seconds.
- Test `verify resolves the action to succeeded and the job continues`: adjusted the assertion to count the reconciliation wake separately from the earlier approval wake; both are durable queue records.
- Test `approval binding`: one-byte tamper, revision drift, edited action identity, cancel/admit race and both late final/unknown dispositions pass against the durable test destination.

## Slice 6 — gateway verification checkpoint, 2026-09-11 08:46 UTC

- Command `bun test apps/melete/src/gateway --max-concurrency=2`: 14 pass, 68 assertions, 0 fail, 768 ms after integration shutdown changes.
- Command `bun test apps/melete/test/integration/gateway.test.ts --max-concurrency=2`: 3 pass, 1 fail, 35 assertions, 26.49 seconds; scripted streaming/approval/destination round trip, concurrent request cap, and pg-boss startup pass.
- Log `cancellation fences both broker and provider HTTP routes without a request record ... timed out after 5000ms`: persists after the two permitted fixes (HTTP shutdown ordering and rejected-request draining); no further fix cycles on this check.
- Command `bun run compose:check`: 11 checks pass; compose runtime stays on internal-only network, effect port unpublished, keys supplied only to Melete, shared work volume and proxy configuration added.
- Command `if ($env:FIREWORKS_API_KEY)`: absent; real Fireworks smoke `skipped: no key`; no external provider request made.
- Log `owner steering A-F`: preserve commits; add full approval binding and generation resolver, cancelled action listing, fenced late receipt reconciliation, execution generation fencing, post-destination timeout identity, and uncertain usage evidence before final report.

## Assumptions — D06/D07 integration

- Log `owner steering A`: frozen contracts remain untouched; generation and approval binding metadata use broker-owned injected resolvers and durable event evidence until W1 columns merge.
- Log `slice 6 failing check`: gateway edits remain uncommitted while the reported check is red; continue the requested sharpening and report exact final check status before opening the PR.

## D06/D07 — implemented and focused verification

- Command `bun test apps/melete/test/integration/broker.test.ts apps/melete/test/integration/budget.test.ts --max-concurrency=2`: 26 pass, 134 assertions, 0 fail, 35.33 seconds; full tuple, current policy/generation refusal, expiry extension refusal, connection revoke/replace fencing, and uncertain usage flags verified.
- Command `bun run conformance`: 14 pass, 109 assertions, 0 fail, 35.63 seconds; 26 pre-existing todos remain in scenarios outside W2.
- Test `provider timeout after the destination write reconciles the original logical action identity`: destination accepts before the injected deadline; restart and verification use one original action id and one destination row.
- Test `cancelled jobs still expose unknown and unresolved sends through the owner action API`: returns both uncertain states after cancellation; runtime credential and another space are refused.
- Test `an authentic fenced receipt resolves an unknown action without reopening its attempt or cancelled job`: succeeded action with late=true; cancelled job and ended attempt remain terminal; no recovery wake is enqueued.
- Test `gateway retains unknown usage and rejects a principal after the epoch bump`: token reservation remains unsettled and attempt.outcome_detail.gateway_usage_uncertain is true; provider model_actual remains independent from requested model.
- Command `bun run lint`: 107 files passed after formatting W2 files and excluding generated .omx state; no generated state was edited or removed.
- Log `typecheck TS18046 Response.json is unknown`: action API conformance reads now validate with the frozen actionListResponse schema; checking the correction next.

## Assumptions — approval lifetime and API integration

- Test `approval records action, bytes, resource, recipient, connection, principal and expiry together`: service approval TTL defaults to 24 hours; only trusted approvalTtlMs changes it.
- Command `startEffectBoundary(handle, env, { resolveAuthority })`: zero-generation compatibility is explicit until W1 injects its current column resolver; frozen contracts are unchanged.
- Command `GET /actions?job_id=<id>`: internal API read uses the distinct API bearer and x-melete-space-id; W1 can mount the exported adapter behind owner authentication.

## Final verification — stop-rule handoff, 2026-09-11 09:00 UTC

- Command `bun test --max-concurrency=2`: 297 pass, 1 existing DATABASE_URL ping skip, 26 pre-existing todos, 1 fail, 1030 assertions, 137.13 seconds; whole suite remains below the three-minute cap.
- Log `(fail) cancellation fences both broker and provider HTTP routes without a request record [5015.00ms]`: `this test timed out after 5000ms`; two fix cycles were exhausted before the architecture sharpening, and the final full suite reproduces it.
- Test `cancellation fences both broker and provider HTTP routes without a request record`: HTTP 403 and no-reservation assertions ran; earlier instrumentation localized the remaining wait to server.close cleanup. The failing test is retained for the handoff.
- Command `bun run typecheck`: passed after validating action-list response JSON with the frozen schema.
- Command `bun run lint`: passed, 107 files; focused formatter subsequently handled only added W2 source/test lines.
- Command `bun run compose:check`: 11 pass; Docker is absent on this laptop, so Linux container/network execution remains unverified here.
- Command `git -C C:/Users/gamin/melete-oss-w2 diff --exit-code 65e26f1438cd5c8e95e7bf160f456be07d8cb534 -- packages/contracts`: passed; frozen contracts unchanged.
- Command `git -C C:/Users/gamin/melete-oss-w2 diff --check`: passed.
- Test `full effect authority binding`: both added action-id and connection-id substitution tests passed in the final suite, in addition to resource, recipient, principal, generation, policy and expiry checks.
- Test `provider evidence parsing`: empty, partial, negative, malformed cache, and overflowing usage keep the reservation uncertain; actual returned model and parsed usage remain separate from the requested alias.
- Log `FIREWORKS_API_KEY absent`: real smoke remains `skipped: no key`; all executed provider tests use the in-process fake or a local transport double.
- Log `DONE not claimed`: one known teardown failure remains after the permitted fix cycles; preserve the implementation, open a draft PR, and do not merge.
- Log `temporary fixture cleanup`: automatic approval review rejected one recursive temporary-directory removal earlier in this run; its Postgres process was stopped and the directory remains preserved.

## Slice 7 — committed conformance handoff

- SHA `89b9ace`: gateway, service startup, full effect binding, current generation checks, API action reads, and usage uncertainty flags committed and pushed; the known gateway teardown failure is retained and documented.
- Command `bun run conformance`: scenarios 3 and 4 pass 14 tests against Postgres 17, pg-boss and the durable test connector; final full-suite execution repeats the same 14 passing scenarios.
- Test `conformance 3`: lost acknowledgement, post-destination timeout, broker restart, original logical identity, verification and unsupported verification are implemented.
- Test `conformance 4`: payload/revision binding, edited draft identity, cancel/admit ordering, truthful final/unknown dispositions, cancelled action listing and late authentic receipt reconciliation are implemented.
