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
command in [README](../README.md). The documentation lane's pull request (#17) records outcomes.

## The reaction rule

**Draw a reaction on the message it belongs to. Never as a row of its own.**

A message in Melete is an event, so a message id is that event's `seq` as a
decimal string. There is no message table: the durable event stream is the
transcript, and a bubble on screen is one event.

```ts
await client.api.POST('/messages/{messageId}/reactions', {
  params: { path: { messageId: String(event.seq) } },
  body: { emoji: '👍' },
});
```

Reactions come back on the same stream as everything else, as events of type
`reaction` with `{ message_id, emoji, by }`. So a client that already renders
the stream needs no second fetch: collect them by `message_id` as they arrive
and draw them under the bubble. `GET /messages/{messageId}/reactions` and
`GET /jobs/{jobId}/reactions` exist for a client that is not following the
stream.

`by` is `person` or `assistant`. Both are drawn the same way. The assistant
reacts when a message needs only acknowledgement, which is what the `react` tool
in its catalog is for: an acknowledgement is a better answer than three
sentences manufactured to fill a reply.

A system line saying "the owner reacted to a message" is exactly the noise a
reaction exists to replace. If you find yourself adding one, the interface has
turned an acknowledgement back into a notification.

Two glyphs mean something to the service, and the rest are expression:

| Emoji | From a person, on an assistant message | Why |
|---|---|---|
| 👎 | the result it lands on counts as two unread ones | read and wrong for them is worse news than unread |
| 👍 | the unread streak clears | it is a read receipt, the same as opening the job |

That is the only way a reaction changes anything. It never wakes a job, never
sends anything, and never stands in for an answer to a question: a job waiting
on `waiting_for_input` is still waiting after a thumbs-up.

Reacting twice with the same emoji records one reaction, so a retry after a
dropped connection is safe and does not push a job further into frequency
reduction than the person pushed it.

## The safe-stop rule

**Show a safe stop as its own state, never as a failure.**

When a connector fails, the broker classifies the fault and repairs the cause
rather than retrying blindly. `GET /jobs/{id}/repairs` reports what it did: the
fault classes the action met, the decisions the policy took, and the
`disposition` the action came to rest at.

`completed` is the only disposition that means the effect happened. Every other
one sets `safe_stop: true`, and a safe stop is not a failure: nothing was sent
twice, nothing was changed to make a call go through, and in most cases the
responsibility is still going.

| Disposition | What to draw |
|---|---|
| `completed` | done, with its receipt |
| `parked_until_retry` | waiting until `retry_after_at`, in the same weight as any other wait |
| `needs_reconciliation` | the unknown-outcome rule above; a person says what they found |
| `needs_reconnect` | one action: reconnect the account. Never a generic error |
| `needs_input` | the question in the inbox is the interface; do not restate it as an error |
| `repair_exhausted` | stopped after trying, with the diagnosis in the inbox |

Never sum completions and safe stops into one "processed" figure, and never
badge a safe stop red. A run that stopped safely eleven times out of eleven
delivered nothing, and a screen that reports eleven successes is lying; a screen
that reports eleven failures is scaring someone about a system that behaved
correctly. Count them apart, and use the plain words:

> The destination asked me to wait an hour, so I will try again at 14:20. I have
> not sent anything yet.

A repair never re-aims an effect. An approved external send or spend keeps the
exact bytes the person read, so nothing corrects one in flight; a send that
needs different details comes back as a new request with its own approval card.
Say that plainly when a `needs_input` stop names it, rather than offering a
retry the service will refuse.

`counters` gives the fault classes an action met, and `trace` gives the ordered
decisions with the hash of the bytes each attempt put on the wire. That hash is
the action's own approved hash throughout, because a repair may change a
selector, a route or a field's name and may never change a recipient, an amount,
a resource, or what the person asked for. A schema-drift mapping appears under
`candidates` as the proposal it is, with the test it had to pass; a candidate in
`candidate` or `rejected` state changed nothing and should be shown as a note,
not as an action taken.
