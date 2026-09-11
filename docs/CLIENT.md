# Building a client

The typed client, reference web UI and scripted mock are separate from the
deployed service. OpenAPI describes the contract; it is not proof every route is
wired in the default entry point. This page describes code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1`.

## Typed requests and errors

`createMeleteClient` from `@melete/client` accepts a base URL, optional fetch
implementation, headers and credential mode. `client.api` uses generated
OpenAPI types. Tests in [client.test.ts](../packages/client/src/client.test.ts)
cover `posts a job as JSON and fills the path parameter`, `carries the caller
headers on every request`, and `hands back the error body rather than throwing`.
HTTP error responses return the API error body; network exceptions are still
possible. Use `errorMessage` to extract a message or supply a fallback.

The generated declarations are checked by `is byte-identical to a fresh run of
client:generate` and `covers every path in openapi.json`. This verifies
generation, not endpoint availability.

## Authentication

The real service uses an opaque `melete_session` cookie. Setup creates one
owner, personal space and session; login verifies the password and creates a new
session. Evidence in [auth.test.ts](../apps/melete/test/integration/auth.test.ts):
`racing setup requests atomically create one owner, space, and session`;
`passwords use argon2id and only a digest of the opaque cookie is stored`;
`login verifies the password, issues a fresh cookie, and returns the public owner`.

The client defaults to `credentials: 'include'`, but that does not enable
cross-origin browser writes. The service rejects cross-origin mutations
(`browser mutation gates reject cross-origin setup, login, and authenticated
writes`). Serve a browser client and API through the same origin for that
path; a working cross-origin deployment recipe is **not claimed** here.
Header-based owner authentication is also **not claimed**: the service reads
the cookie even though the generic client supports caller-supplied headers.

## Events and resume

The service exposes global and per-job JSON/SSE event reads. Retain the last
rendered `seq` and supply it as the reconnect cursor. Last-Event-ID takes
precedence over the URL cursor (`Last-Event-ID overrides the URL cursor and
unknown jobs fail before streaming`). The service tests cover persisted replay,
duplicate suppression and explicit gap notices.

The helper `subscribeEvents` yields `open`, `event` and `gap` items.
Evidence in [events.test.ts](../packages/client/src/events.test.ts):
`marks a reconnect as a gap and resumes with Last-Event-ID`,
`drops events the caller already has when the server replays them`,
and `reports a skipped sequence as a gap with both ends`.

Show reconnect gaps as possible missing text. The current runner persists
incoming text-delta events, despite the contract helper's non-durable label;
conformance 5 checks their stored rows. Do not promise that all streamed text
is absent from replay. The current helper also marks a sequence jump as a gap,
but a filtered stream may skip global sequence
numbers without losing durable history. The service test `a gap marker names
its persisted notice and rollback holes never invent gaps` checks the server's
more precise rule. A complete gap-aware reference UI across these surfaces is
**not claimed**.

## Approvals and uncertain outcomes

Render the canonical action payload, hash and supplied origin warnings, rather
than treating model prose as an approval card. Submit the exact reviewed hash.
A hash/revision conflict requires a refresh and a new owner decision; do not
silently approve the replacement payload. Evidence: conformance 4,
`An approval cannot be spent on different content`, and the mock test
`the payload the approval shows is canonical, not what the model typed`.

An `unknown` action may have happened. Keep it distinct from success and
failure, and do not offer an automatic resend. Connector verification can resolve
it; the manual resolution route accepts succeeded, failed or unresolved.
It is incorrect to say only a person can resolve an unknown action.
Conformance 3 tests `verify resolves the action to succeeded and the job
continues` and `against a destination with no verify, the action rests at
unresolved and the owner is asked`.

## Questions, notifications and states

The service's owner question queue ranks blocking external effects, then
deadlines, then age. Render the question text together with its `because`
handles and `if_ignored` consequence; preserve server ordering. Evidence:
`three questions in the same minute make one queue entry per job, and answering
the middle one wakes only that job` and `an attempt that emits two questions
asks one and asks the other on the next wake`.

Quiet-monitor and notification requirements are tested by `a quiet monitor
with no delta writes no outbox row, and one with a delta writes one that cites
its reason` and `the outbox refuses a notification that cites nothing`.
These prove service behavior; full reference-UI support for all new attention
routes is **not claimed**.

| State | Client guidance |
| --- | --- |
| `queued`, `running` | Show pending/active work |
| `waiting_for_input` | Show the current question and answer control |
| `waiting_for_approval` | Show the recorded action for a decision |
| `waiting_for_event_or_time` | Show the wait predicate or scheduled wake |
| `needs_reconciliation` | Show the uncertain action and verification/resolution controls |
| `completed` | Show the recorded result |
| `failed` | Show the failure and available evidence; this is a terminal state, not a wait |
| `cancelled` | Show cancellation without hiding uncertain prior effects |

The closed states are checked by `types the job state as the closed set the
state machine uses`; transition behavior is tested in
`packages/contracts/src/job-state.test.ts`. This table is interface guidance,
not a claim that every control has shipped.

## Reproduce the examples without a deployed service

From the repository root after installing dependencies:

```bash
bun run client:generate
bun test packages/client/src
bun test apps/mock-api/src/app.test.ts
```

These tests supply valid IDs, request bodies and fake transports. The mock has
scripted approved-send and unknown-outcome flows, tested by `an approved send
runs to completed with a receipt` and `an unknown outcome parks the job at
needs_reconciliation`. The mock is not a real-model assistant; full coverage
of every newly added OpenAPI operation is **not claimed**.

For real-service authentication, event and attention checks, use the full test
command in [README](../README.md). [REPORT.md](../REPORT.md) records outcomes.
