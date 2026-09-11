# Capabilities

This matrix describes Melete on `lane/w14-capabilities`, based on
`9484023cabd32b786cb4d336dec818f441cd0cc1`. Hermes is pinned to `v2026.9.7`, commit
`2237be355906fbe6065ce1815711eee52b2d646e`. An interface in Hermes is not a
Melete capability until it is connected to Melete's authority and tested.

- **implemented-and-tested**: the named Melete behavior has an executed test.
- **implemented-but-unverified**: the path exists, but the required proof has
  not passed in this lane.
- **missing**: an implementation or necessary connection is absent. A source
  audit or a test of a helper does not fill that gap.

## Requested capability matrix

| Capability | Status | Test or reason |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | missing | Current plugin loads the broker catalog once at startup. The Hermes search bridge is disabled. W10c integration is required. |
| MCP connect after session start | missing | No Melete operator installation route or broker MCP connector in this revision; a Hermes live-registry helper is insufficient. Requires W10c. |
| MCP disconnect recovery | missing | No broker MCP fault-to-reconnect path in this revision. Requires W10c/W12 and the real-server test with one recorded effect. |
| Connection auth refresh and reconnect | missing | Upstream OAuth recovery is not connected to Melete's sealed credentials, grants or typed repair policy. No Melete MCP refresh/reconnect test exists here. |
| Lifecycle hooks persisted with dedup and replay | missing | No plugin hook registration or adapter bridge; frozen `RuntimeEvent` lacks `hook_event` / `hook_error`. Compaction additionally lacks an HTTP plugin hook at the pin. Slice 2 stopped for the required contract proposal. |
| Automatic skill selection in a job | missing | The deterministic selector is implemented and tested below, but `apps/melete/src/jobs/bundle.ts` still emits `skills: []`. |
| Correction → candidate → evaluation → promotion → rollback | missing | W11's evaluated procedure lifecycle is absent from this revision. Hermes background mutation and backup rollback are not this pipeline. |
| Teammate reuse of an evaluated shared skill | missing | Second-principal/membership/shared-space contracts are absent and W11 promotion is pending. Slice 3 stopped for the required contract proposal. |
| Revocation prevents subsequent shared-space use | missing | No principal membership to revoke or principal-specific bundle exclusion. Existing connection and memory generation fences do not establish this behavior. |

## Components with narrower evidence

| Component | Status | Exact evidence and limit |
|---|---|---|
| Broker tool registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`; `bun run test:plugin`: 20 passed. Uses a test broker, not the real Hermes loop. |
| Broker approval result tells the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the same Python suite. |
| Short skill loading and deterministic selection | implemented-and-tested | `choosing a skill for an objective > at most three load, however many match`, `the same inputs always give the same bundle`, and `skills a person adds to a space > load alongside the built-ins` in `packages/skills/src/skills.test.ts`. This proves selection helpers, not job wiring or membership filtering. |
| Adapter sequence and instruction assembly | implemented-and-tested | `a recorded run > every event carries the one dedup key format` in `packages/runtime-hermes/src/adapter.test.ts`; `context assembly > the instructions are identity, then skills, then knowledge` in `packages/runtime-hermes/src/client.test.ts`. Uses recorded HTTP responses. |
| Real local Hermes park-and-resume path | implemented-but-unverified | W3's `packages/runtime-hermes/scripts/e2e.ts` exists. W14 has not run it and it is not the required single capability-chain integration test. |
| Whole end-to-end capability proof | missing | No single real-Hermes integration test yet covers mid-job MCP installation, reconnect with one effect, correction/promotion, second-principal reuse, private-data isolation and revocation. |

## Authority and hook semantics

Hooks are observers only. Enforcement remains in the broker: a missing, failing
or disabled hook must never grant a tool, bypass an approval, extend a budget,
revive a stale generation or redispatch an uncertain effect. Hook records must
contain bounded names, attempt/tool identity, timing, outcome and a digest of
redacted arguments; no raw credentials, full messages or complete tool payloads.

Hermes has 37 registered hook names. Its `on_session_end` fires at turn
finalization, while compaction uses a separate callback that the HTTP runs
surface does not expose. Its callback exception log is not a durable
`hook_error`. The complete file-and-line audit, including MCP retry behavior,
skills, curator, memory and context providers, is in
[note 0021](../.agents/notes/0021-hermes-capability-audit.md).

## Verification and remaining work

```sh
python packages/runtime-hermes/scripts/audit-pin.py .hermes-src
bun run packages/runtime-hermes/scripts/audit-contracts.ts
bun test packages/runtime-hermes/src packages/skills/src --max-concurrency=2
bun test --max-concurrency=2
bun run test:plugin
bun run lint
bun run typecheck
bun run compose:check
```

The focused runtime and skill suite passed 67 tests; the plugin suite passed
20. The full suite did not finish within three minutes and is not green.
The isolated event deduplication assertion passed, but its teardown timed out.

[REPORT.md](../REPORT.md) records current command results, failures, stop conditions and the
dependency check. Tests use the scripted fake provider. The repository already
has an embedded Postgres 17 fixture for runs without `DATABASE_URL`; a skipped
database test is not a pass. Docker isolation remains unverified on this
Windows machine.

Shared spaces and membership revocation are not implemented in this revision.
The requested invitation UI remains outside v0.1. The proposed
[durable hook contract](../.agents/notes/proposed/2026-09-12-w14-durable-hook-contract.md)
and [principal/membership contract](../.agents/notes/proposed/2026-09-12-w14-principal-membership-contract.md)
describe the blocked changes and future acceptance tests. Resume the affected
slices after those additions are accepted, then integrate W10c/W11/W12 and run
the single real-server proof on W14's ports 3160/3162.
