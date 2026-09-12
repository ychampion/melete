# Capabilities

This matrix describes the W14 follow-up on integration commit `55b6a50`, verified
on 2026-09-12. The audited Hermes pin is `v2026.9.7`, commit
`2237be355906fbe6065ce1815711eee52b2d646e`, with adapter revision
`hermes@v2026.9.7+melete-observers.2`. An upstream interface becomes a Melete capability only after it is
connected to Melete's authority and tested.

- **implemented-and-tested**: the named behavior has an executed Melete test.
- **implemented-but-unverified**: code exists, but the required proof has not passed.
- **missing**: an implementation or necessary connection is absent.

## Requested capability matrix

| Capability | Status | Test or reason |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | implemented-and-tested | The real capability test's `dynamic discovery and broker receipt` stage passes search, load, continuation, one MCP call and a durable receipt. MCP HTTP exchanges use dedicated connections to avoid the pinned Windows Bun pool stalling a request while Hermes streams. |
| MCP connect after session start | implemented-and-tested | The real proof installs through authenticated `POST /connections` during a running attempt, then searches, loads and calls in that attempt. `runtime-mcp.test.ts` covers setup and restart; `runtime-mcp-revocation.test.ts` pauses initialization, revokes through the lifecycle route, and proves both successful and failed handshakes preserve revocation, dispose any opened worker and deny fresh-attempt calls. Service-side stdio launch remains disabled. |
| MCP disconnect recovery | implemented-and-tested | The real Hermes proof terminates an HTTP session, then observes W12 reconnect, a fresh initialization, one call and a durable receipt. HTTP and stdio integration fixtures exercise the callback; repeated termination stops after three attempts. A lost acknowledgement stays unknown without replay. |
| Connection auth refresh and reconnect | implemented-and-tested | The real Hermes proof refreshes an expired credential once through the sealed store and receives one action receipt. Revocation makes no call, leaves an open question and commits waiting for input. HTTP and stdio fixtures also cover revocation during refresh, token rotation and bounded repeated expiry. |
| Lifecycle hooks persisted with dedup and replay | implemented-but-unverified | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` passes in `hooks.test.ts`; Python tests prove observer failure isolation and continuation identity. The real proof records session start/end and pre/post tool events, including distinct continuation capture IDs. Real compaction remains unverified. |
| Automatic skill selection in a job | implemented-and-tested | The real capability test's `teammate audience isolation and revocation` stage selects exactly `alpha`, `beta`, `gamma` despite a matching private skill. Actual provider requests exclude the private canary. `principals.test.ts` also tests membership and audience filtering. |
| Correction → candidate → evaluation → promotion → rollback | implemented-and-tested | The real capability test performs correction, bounded proposal, validation and sealed evaluation, private owner canary reuse, explicit activation and rollback. Both evaluation phases require held-out improvement without regression; the fake provider reasons from the actual HTTP prompt. |
| Teammate reuse of an evaluated shared skill | implemented-and-tested | `correction, evaluation, private canary and evaluated teammate reuse` proves A's evaluated procedure reaches B's materially different task only after explicit space promotion. `shared-procedure.test.ts` proves private defaults, principal-bound source access, compiled-body-only delivery, other-space/public refusal, and no delivery or dispatch after revoking B. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The real capability test proves queued work cancellation, refused reads and admission, an old capability's refusal, and personal context without shared skills. `principals.test.ts` additionally covers delivered-context invalidation, gateway fencing and stale capabilities after regrant. |

## Components with narrower evidence

| Component | Status | Exact evidence and limit |
|---|---|---|
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. The real capability proof also confirms the MCP receipt in the ledger and subsequent provider request. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite. |
| Deterministic bounded skill selection | implemented-and-tested | `at most three load, however many match`, `the same inputs always give the same bundle`, and `load alongside the built-ins` in `packages/skills/src/skills.test.ts`, plus the actual job-bundle integration test above. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` now upgrades through production `migrateDatabase`. `production migration upgrades the integration schema with MCP setup and procedure promotion` starts with a real ledger through 0032, verifies all three new columns, and checks a second startup is idempotent. Migrations 0033/0034 have increasing timestamps after 0032. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter/client suites. Uses recorded HTTP responses. |
| Real local Hermes hook run | implemented-and-tested | The real capability test passes its session start/end and pre/post tool assertions and records 23 lifecycle events across discovery and continuation with a successful MCP receipt. Actual compaction remains outside this executed scenario. |
| Whole end-to-end capability proof | implemented-and-tested | `real Hermes capability chain: discovery, hooks, learning, teammate context and revocation` passes through the real pinned HTTP engine: 85 assertions, 208.62 seconds, all five stages passed, no missing entries. Evidence `melete-w14-capability-JAbcAJ` includes the actual provider requests. |

## Authority and observer behavior

An owner can install an HTTP MCP server through `POST /connections` with
`provider: mcp`, `space_id`, `label`, and `mcp` containing `id`, `url`,
`allowed_scopes`, `audience: owner`, and operator-declared `tools`. Each tool
names its raw server name, alias, required scopes and effect class. Installation
persists its configuration and exposes `connecting`, `connected`, or `error`;
the live registry publishes tools only after the connection becomes active.
Publication and failure updates require the original generation and the original
disabled/connecting state. A lifecycle change during initialization wins;
the opened worker is removed and closed, and a changed generation returns a
conflict. The existing owner audience boundary still applies.

An MCP installation may supply `credentials` with `access_token`, optional
`expires_at`, and a paired `refresh_token` / `token_url`; optional client
credentials remain in the same sealed record. Credential endpoints require
TLS, with loopback allowed for local fixtures. Refresh follows only the
operator-configured token endpoint, refuses redirects, rotates the sealed
reference only while the same grant is current, and never changes scopes.
Credentials are absent from connection responses, runtime bundles and hooks.

MCP repair distinguishes proved pre-dispatch failure from uncertain execution.
A terminated session or refused connection can reconnect under W12's bounded
retry policy; an acknowledgement lost after dispatch cannot. Reconnection
checks the catalog against its pinned schemas and operator policy. Expiry can
refresh once; revocation leaves the operator's question open even if the
runtime claims completion. Stdio exercises these callbacks only in fixtures;
the production launcher still requires OS isolation.

Service-issued principal-bound attempts opt into signed `live_connection_scopes`
so a running session can follow current operator grants. Explicitly restricted
and legacy capabilities retain their fixed scope lists. Discovery and admission
still check the current connection, principal, membership, epoch, space,
compartment and agent restrictions. A loaded schema grants no authority.

Hooks observe; the broker enforces tools, approvals, budgets and generations.
The plugin registers lifecycle observers and the adapter stores their events in
its ordinary sequence before fan-out. Identical captures are deduplicated;
conflicting reuse of a capture ID fails the stream. Records contain bounded
names, attempt/tool identity, capture time, outcome and a digest of an argument
shape with all values erased. Full payloads, credentials and exception text are
never copied into hook records.

Hermes has 37 hook names at the audited pin. W14's hash-checked patch adds a real
`on_compaction` dispatch after committed compaction progress and a per-run HTTP
queue bridge. `on_session_end` still means turn finalization. The source audit,
MCP retry analysis and reuse/patch/replace decisions are in
[note 0021](../.agents/notes/0021-hermes-capability-audit.md).

The installation retains its singleton setup owner. Additional accounts live
in `principal`; a session, job and new capability name the authenticated
principal. Personal spaces are private. Shared-space membership has a retained,
monotonic generation. Revocation advances the space policy generation, clears
cached delivered memory, invalidates prepared outputs, fences active attempts
and cancels the revoked member's queued/waiting work. A regrant gets a new
generation. Checks occur at API reads, bundle construction, broker admission
and model-budget reservation.

Jobs and their timelines remain private to the principal who owns the job,
including inside a shared space. Membership shares published skills and
knowledge; it does not expose another principal's private attempt context.

Published shared skills use `audience: space:<space-id>`; plain `space` remains
valid within its checked container. Missing skill audiences are private. The
bundle reads only the job's authorized space and at most three selected skills.
It also includes bounded, active published Markdown knowledge with matching
container and audience. Derived memory Markdown is excluded: its authoritative
recall path supplies the current claim revision. The service preserves the
actual reader principal and membership generation in memory scopes. Catalog
enrichment preserves the already authorized selection and evaluated procedures;
it can remove skills whose tools are unavailable. An invitation UI is outside v0.1.

Evaluated procedure activation accepts `scope: private | space`, defaulting to
`private`. Its promotion record also stores the authenticated principal; callers
cannot nominate another principal. Canary delivery stays private. Explicit
space activation requires the source space's owner, a shared space, the sealed
evaluation gate and a completed private canary. Task applicability remains a
separate evaluated object and grants no access by itself. A current member can
receive only the verified compiled procedure body for a matching task, model and
runtime in that space. Episodes, corrections, evaluations and job timelines stay
private. Selection rechecks membership under the existing revocation lock;
revocation cancels queued reuse and fences already delivered context. Rollback
removes subsequent procedure delivery.

## Verification

```sh
bun test apps/melete/test/integration/principals.test.ts apps/melete/test/integration/shared-procedure.test.ts packages/contracts/src/principals.test.ts --max-concurrency=1
bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=1
bun run test:plugin
bun run lint
bun run typecheck
bun run compose:check
```

Run the real capability proof sequentially with the local engine already
prepared as described in the runtime README:

```sh
MELETE_CAPABILITY_PROOF=1 bun test apps/melete/test/integration/capability-proof.test.ts --max-concurrency=1
```

It starts pinned Hermes over HTTP through the service supervisor, uses ports
3160/3162, a local HTTP MCP fixture, PostgreSQL and pg-boss, and a scripted fake
model provider. The provider sees HTTP requests, not expected answers or the
database. Validation and sealed evaluation each include three paired record
tasks through real Hermes, plus scope and memory checks. Evidence and provider
requests remain in the test's temporary directory. `MELETE_CAPABILITY_AUDIT=1`
allows recording known missing implementations but still fails broken available
seams; only strict proof requires an empty missing-capability list.

On the shared Windows runner, acquire the full-suite lock before running all
tests, write an ownership marker, and release only that lock even when tests fail:

```sh
until mkdir C:/Users/gamin/.melete-test.lock 2>/dev/null; do sleep 20; done
printf '%s\n' "w14 $$" > C:/Users/gamin/.melete-test.lock/w14-owner
trap 'rm C:/Users/gamin/.melete-test.lock/w14-owner; rmdir C:/Users/gamin/.melete-test.lock' EXIT
bun test --max-concurrency=1 --timeout=30000
```

The append-only [REPORT.md](../REPORT.md) records the passing strict proof,
focused checks and final single full-suite run. The earlier dictionary-result,
MCP receipt and context-matcher failures are historical. The final release-gate
full suite ran once under the shared lock and reached its 180-second budget:
1,312 passing test lines, no failing lines and 29 skips before termination
(exit 124, 180.75 seconds). It remains incomplete and was not rerun. Typecheck,
lint, clean database/OpenAPI/client regeneration, 61 plugin tests and 19 Compose
declaration checks pass. Actual compaction and Docker isolation remain unverified.
Skipping opt-in real-runtime checks during ordinary tests is not end-to-end proof.
Tests use disposable PostgreSQL 17 and pg-boss when `DATABASE_URL` is
unset. A skipped database test is not a pass. Docker isolation remains unverified
on this Windows machine. The accepted additions are recorded in the
[contract note](../.agents/notes/proposed/2026-09-12-w14-contract-additions.md).
