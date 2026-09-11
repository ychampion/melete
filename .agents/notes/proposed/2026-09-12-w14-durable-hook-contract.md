# Proposed - Durable lifecycle hook events

Status: proposed; slice 2 stopped at the frozen-contract boundary
Date: 2026-09-12
Base: `9484023cabd32b786cb4d336dec818f441cd0cc1`

## Why this slice cannot proceed under the freeze

The W14 brief requires `hook_event` delivery from the Melete plugin through the
adapter into the persisted stream, and a durable `hook_error` when a handler
throws. It also says: "If you need a contract change, write
`.agents/notes/proposed/<date>-<topic>.md` describing it and STOP the affected
slice; do not edit `packages/contracts` types."

`packages/contracts/src/runtime.ts:168-218` has neither event type. `EventSink`
accepts only that union. `packages/contracts/src/entities.ts:257-273` also lacks
them; the responsibility extension at `responsibility.ts:252-257` adds only
`context_invalidated`. The service's `events/store.ts` consumes this typed
stream. Hiding the records in a `notice`, using a cast, or defining a competing
private event union would not implement the requested public contract.

`bun run packages/runtime-hermes/scripts/audit-contracts.ts` reports the runtime,
persisted and responsibility hook acceptance separately. This is a diagnostic,
not a passing implementation test. No contract or runtime code is changed by
this proposal.

## Minimum additive contract

Extend the runtime discriminated union and durable event vocabulary with
`hook_event` and `hook_error`, preserving every existing variant and field.
Carry the existing attempt id, local sequence, dedup key and timestamp. The
bounded hook payload needs:

| Field | Required meaning |
|---|---|
| `name` | Original hook name, validated against the supported capture surface; do not invent a hook that the pin never dispatches. |
| `tool_name` | Nullable bounded tool name, not tool arguments or result text. |
| `timing` | Capture time and, when available, nonnegative elapsed milliseconds. Preserve the upstream boundary semantics. |
| `outcome` | A bounded normalized observation such as started, succeeded, failed, interrupted or unknown. |
| `redacted_args_digest` | SHA-256 of a bounded, allow-listed, redacted representation, or null when arguments are unavailable. Never hash raw credentials and call that redaction. |
| `error_code` on `hook_error` | A bounded failure classification. No arbitrary exception message, traceback or original payload. |

The public SSE/read models must accept both types, including the responsibility
extension and generated OpenAPI/client surface. One adapter sequencer must
order hook and ordinary events. Retried delivery must keep the same capture
identity and final `attempt_id:local_seq`; incrementing the sequence on a retry
would bypass deduplication. Persistence precedes fan-out. A failed capture or
delivery must not be reported as successful durable delivery.

## Runtime seam and enforcement

Use `ctx.register_hook` for the relevant real hook names in note 0021. Every
callback is an observer and returns no behavior-changing directive. Capture
must be bounded and failures must be converted to redacted error metadata;
blocking network calls inside `pre_tool_call` would risk Hermes's timeout veto.
The broker remains the authority even when no hook fires.

Compaction requires a separate reviewed seam: the pin calls
`agent.event_callback('session:compress', ...)` at
`agent/conversation_compression.py:3091`, but its HTTP constructor never wires
that callback. No `on_compaction` plugin hook exists. Registering an unknown
hook name would merely store an inert callback. A narrow upstream observer
exposure or approved context-engine adapter is required; this lane does not
monkeypatch or replace the frozen engine.

## Acceptance tests after the contract is available

- `lifecycle hooks > a scripted real-Hermes run persists ordered session, turn and tool observations`: assert persisted rows and cursor replay, not only an in-memory sink.
- `lifecycle hooks > retrying one capture stores one event`: replay the same capture through the adapter/ingress and prove one row and one live frame.
- `lifecycle hooks > a throwing observer records hook_error and the run completes`: exercise the registered callback through Hermes and prove the broker effect still follows its approval/identity rules.
- `lifecycle hooks > compaction and provider errors have bounded durable observations`: trigger the actual exposed boundaries and verify no full payload or credential survives serialization.

These names describe required future tests; none is claimed to exist or pass.
