# Capabilities

This matrix describes `lane/w14-capabilities`, based on integration commit
`9484023cabd32b786cb4d336dec818f441cd0cc1`. The audited Hermes pin is `v2026.9.7`,
commit `2237be355906fbe6065ce1815711eee52b2d646e`; W14 adds the reviewed observer
patch. An upstream interface becomes a Melete capability only after it is
connected to Melete's authority and tested.

- **implemented-and-tested**: the named behavior has an executed Melete test.
- **implemented-but-unverified**: code exists, but the required proof has not passed.
- **missing**: an implementation or necessary connection is absent.

## Requested capability matrix

| Capability | Status | Test or reason |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | missing | The plugin loads the broker catalog at startup; the Hermes search bridge is disabled. W10c is not integrated. |
| MCP connect after session start | missing | This revision has no operator installation route or broker MCP connector. Requires W10c. |
| MCP disconnect recovery | missing | Requires the W10c connector, W12 repair path, and real-server proof of exactly one effect. |
| Connection auth refresh and reconnect | missing | Upstream recovery is not connected to Melete's sealed credentials, grants and typed repair policy. |
| Lifecycle hooks persisted with dedup and replay | implemented-but-unverified | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` passes in `apps/melete/test/integration/hooks.test.ts`; Python tests prove observer failure isolation. The real-Hermes test reaches lifecycle hooks and `hook_error`, but fails its final broker-action assertion. Real compaction observation is not yet proven. |
| Automatic skill selection in a job | implemented-and-tested | `member bundles select at most three shared skills; revocation fences work, replay, knowledge and old capabilities` in `apps/melete/test/integration/principals.test.ts` exercises the actual `buildBundle` path, capped at three and filtered by membership and audience. |
| Correction → candidate → evaluation → promotion → rollback | missing | W11's evaluated procedure lifecycle is not integrated. Hermes background mutation is not this pipeline. |
| Teammate reuse of an evaluated shared skill | missing | Shared principals and reuse of a published skill are tested; evaluation and promotion still require W11 and the real-server scenario. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The principal integration test proves refused reads, new-job admission, stale broker/gateway capabilities, cancelled queued work, invalidated delivered memory and a fresh personal bundle without shared context. Regrant leaves old capabilities stale. |

## Components with narrower evidence

| Component | Status | Exact evidence and limit |
|---|---|---|
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. The real pin rejects the forwarder's dictionary result; see the real-server failure below. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite. |
| Deterministic bounded skill selection | implemented-and-tested | `at most three load, however many match`, `the same inputs always give the same bundle`, and `load alongside the built-ins` in `packages/skills/src/skills.test.ts`, plus the actual job-bundle integration test above. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` applies the old migrations, seeds real account/session/work rows, upgrades, and verifies login and both attempt fences. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter/client suites. Uses recorded HTTP responses. |
| Real local Hermes hook run | implemented-but-unverified | `real Hermes persists lifecycle hooks and a throwing observer without stopping the tool run` reaches the real hooks and durable `hook_error`, but records zero successful broker actions instead of one. Log: `Tool files.read handler returned unsupported result type: dict`. Two permitted fix cycles are exhausted. |
| Whole end-to-end capability proof | missing | No passing single real-Hermes test combines mid-job MCP installation/reconnect, one effect, evaluated promotion/reuse, private-data isolation and revocation. W10c/W11/W12 are not integrated. |

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
recall path must supply the current claim revision. The W11 evaluation pipeline
is still pending. An invitation UI is outside v0.1.

## Verification

```sh
bun test apps/melete/test/integration/principals.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2
bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2
bun run test:plugin
bun run lint
bun run typecheck
bun run compose:check
```

On the shared Windows runner, acquire the full-suite lock before running all
tests, and release it even when tests fail:

```sh
until mkdir C:/Users/gamin/.melete-test.lock 2>/dev/null; do sleep 15; done
trap 'rmdir C:/Users/gamin/.melete-test.lock' EXIT
bun test --max-concurrency=2
```

The optional real-server command is
`MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`.
It uses W14's ports 3160/3162 and a scripted fake provider. Prepare the local
Hermes environment as described in the runtime README. It currently fails as
recorded above; skipping it during ordinary unit checks is not end-to-end proof.

the lane's pull request (#13) contains command results and the refreshed dependency
check. The serialized full suite exceeded its 180-second budget after 376
passing tests and no assertion failures; it did not finish and is not green.
Tests use disposable PostgreSQL 17 and pg-boss when `DATABASE_URL` is
unset. A skipped database test is not a pass. Docker isolation remains unverified
on this Windows machine. The accepted additions are recorded in the
[contract note](../.agents/notes/proposed/2026-09-12-w14-contract-additions.md).
