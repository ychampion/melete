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
| MCP connect after session start | missing | During a running real-Hermes job, `POST /connections` returns 404. MCP configuration is read from an operator file at startup; service-side stdio launch is disabled. |
| MCP disconnect recovery | missing | The MCP adapter has no repair callback that reconnects the session and resolves an uncertain action. The capability test observes health failing and recovering, which does not prove job recovery or exactly one effect. |
| Connection auth refresh and reconnect | missing | Generic connection repair exists, but the configured MCP adapter has no credential-refresh or reconnect callback. |
| Lifecycle hooks persisted with dedup and replay | implemented-but-unverified | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` passes in `hooks.test.ts`; Python tests prove observer failure isolation and continuation identity. The real proof records session start/end and pre/post tool events, including distinct continuation capture IDs. Real compaction remains unverified. |
| Automatic skill selection in a job | implemented-and-tested | The real capability test's `teammate audience isolation and revocation` stage selects exactly `alpha`, `beta`, `gamma` despite a matching private skill. Actual provider requests exclude the private canary. `principals.test.ts` also tests membership and audience filtering. |
| Correction → candidate → evaluation → promotion → rollback | implemented-and-tested | The real capability test's `correction, evaluation, private reuse and rollback` stage passes: correction, bounded proposal, validation and sealed evaluation, owner canary reuse on a different task, activation and rollback. Promotion is owner/private only; the fake provider reasons from the actual HTTP prompt. |
| Teammate reuse of an evaluated shared skill | missing | `procedureScope` accepts only `role: owner`, `audience: private`; qualified shared promotion is rejected. Tests prove a member cannot obtain that private procedure by requesting an owner scope. Published shared Markdown skills are a separate tested path. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The real capability test proves queued work cancellation, refused reads and admission, an old capability's refusal, and personal context without shared skills. `principals.test.ts` additionally covers delivered-context invalidation, gateway fencing and stale capabilities after regrant. |

## Components with narrower evidence

| Component | Status | Exact evidence and limit |
|---|---|---|
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. The integrated plugin fixes the earlier dictionary-result incompatibility; the current MCP receipt failure is recorded separately. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite. |
| Deterministic bounded skill selection | implemented-and-tested | `at most three load, however many match`, `the same inputs always give the same bundle`, and `load alongside the built-ins` in `packages/skills/src/skills.test.ts`, plus the actual job-bundle integration test above. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` applies the old migrations, seeds real account/session/work rows, upgrades, and verifies login and both attempt fences. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter/client suites. Uses recorded HTTP responses. |
| Real local Hermes hook run | implemented-but-unverified | The current real capability test records 18 hook events across the initial run and continuation. Its broker receipt assertion fails before its hook assertions; this is observed evidence, not a green combined test. Compaction and a complete successful MCP lifecycle remain unverified. |
| Whole end-to-end capability proof | implemented-but-unverified | `real Hermes capability chain: discovery, hooks, learning, teammate context and revocation` exists as one opt-in integration test. The final strict run fails with 37 assertions in 180.60 seconds; independent learning and revocation stages pass, while MCP receipt proof fails and the missing capabilities above remain explicit. |

## Authority and observer behavior

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
it can remove skills whose tools are unavailable. Evaluated procedures currently
remain private to the space owner. An invitation UI is outside v0.1.

## Verification

```sh
bun test apps/melete/test/integration/principals.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2
bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2
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

The append-only [REPORT.md](../REPORT.md) records the current strict result,
focused checks and the final single full-suite run. The earlier 376-test budget
stop and dictionary-result failure are historical, before integration `55b6a50`.
The current single locked full suite stopped at 180 seconds after 990 passing
tests, one context-test timeout and 26 skips. All five context tests pass after
replacing the database async rejection matchers, but the full suite was not
repeated and remains incomplete. The focused integration/runtime set has 77
passes and one platform skip; the plugin suite has 61 passes.
Skipping opt-in real-runtime checks during ordinary tests is not end-to-end proof.
Tests use disposable PostgreSQL 17 and pg-boss when `DATABASE_URL` is
unset. A skipped database test is not a pass. Docker isolation remains unverified
on this Windows machine. The accepted additions are recorded in the
[contract note](../.agents/notes/proposed/2026-09-12-w14-contract-additions.md).
