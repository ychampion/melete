# Building a client

Melete is an API. The web client in `apps/web` is one consumer of it, not the
product interface; anything that client can do, a script can do, and this
document is what a second client needs to know before it starts.

Everything here is generated from or checked against
[`packages/contracts/openapi.json`](../packages/contracts/openapi.json). If this
page and the document ever disagree, the document is right and this page is a
bug.

- [The typed client](#the-typed-client)
- [Authentication](#authentication)
- [The event stream and the resume rule](#the-event-stream-and-the-resume-rule)
- [The approval-card rule](#the-approval-card-rule)
- [The unknown-outcome rule](#the-unknown-outcome-rule)
- [The safe-stop rule](#the-safe-stop-rule)
- [The inbox rule](#the-inbox-rule)
- [The five states a job can wait in](#the-five-states-a-job-can-wait-in)
- [Developing against the mock](#developing-against-the-mock)

## The typed client

```ts
import { createMeleteClient, subscribeEvents } from '@melete/client';

const client = createMeleteClient({ baseUrl: 'http://localhost:8787' });

const { data, error } = await client.api.POST('/jobs', {
  body: {
    space_id,
    title: 'Chase the heating repair',
    objective: 'Ask the building manager for a date an engineer is booked.',
  },
});
```

`client.api` is an [`openapi-fetch`](https://openapi-ts.dev) client typed by
`packages/client/src/schema.d.ts`, which `bun run client:generate` writes from
`openapi.json`. A test regenerates it and compares the bytes, so a client built
on a stale contract cannot reach a green build.

Requests never throw on a non-2xx status. Every call returns `{ data, error }`,
and `error` is the contract's error body: `{ error: { code, message, detail? } }`.
`errorMessage(error)` pulls the sentence out of it, so a screen never has to
invent wording for a failure the service already described.

## Authentication

v0.1 has one owner and authenticates with a session cookie.

The client sends `credentials: 'include'` by default, which is what a browser
client on a different origin than the API needs. That only works if the service
is configured to allow the client's origin; a client served from the same origin
as the API needs nothing at all. Pass `credentials: 'omit'` when the caller
carries its own header credential instead, and put it in `headers`.

Never put a credential in a query string. `subscribeEvents` uses `fetch` rather
than the browser's `EventSource` precisely because `EventSource` cannot send
headers and cannot be given a custom `fetch`, which forces credentials into the
URL where they end up in server logs.

## The event stream and the resume rule

`GET /jobs/{jobId}/events` and `GET /events` answer with JSON when `Accept` is
`application/json` and with Server-Sent Events when it is `text/event-stream`.
Both start after the `after` cursor, and `Last-Event-ID` overrides `after`.

Events are persisted before they are streamed. The SSE frame `id` is the event's
`seq`, which is exactly what a browser sends back in `Last-Event-ID`, so
resumption needs no bookkeeping of its own.

**The resume rule: remember the last `seq` you rendered, and send it as both
`after` and `Last-Event-ID` when you reopen the stream.**

```ts
for await (const item of subscribeEvents(client, { jobId, after: lastSeq })) {
  if (item.type === 'event') render(item.event);
  if (item.type === 'gap') renderEllipsis(item);
}
```

What comes back on reconnect is not what was lost. Durable events, the ones that
carry state, are replayed from the database and nothing is missing. Text deltas
are transient and are never replayed, so whatever streamed while the connection
was down is gone for good.

That is the only thing the client must not paper over. `subscribeEvents` yields
a `gap` item at the point the connection broke, and the client shows an ellipsis
there. An interface that silently stitches the two halves together is claiming a
transcript is complete when it is not.

| Item | When | What to draw |
|---|---|---|
| `open` | a connection was established | a live indicator |
| `event` | one event, in `seq` order | the event |
| `gap`, reason `reconnect` | the stream dropped and reopened | an ellipsis: text may be missing |
| `gap`, reason `sequence_skip` | the next `seq` jumped | an ellipsis naming both ends |

Events the caller already holds are dropped by the cursor, so a replayed event
is never rendered twice.

## The approval-card rule

**Render an approval from the `action` record, never from model text.**

`GET /approvals` returns `canonical_payload` and `payload_hash`. The payload is
what the broker canonicalised: keys sorted, strings trimmed, email recipients
normalised and de-duplicated. It is the bytes the connector will be handed. A
model's own description of what it is about to send is not evidence of what it
is about to send, and a screen that renders the description is showing the
person the wrong thing.

So: draw each field of `canonical_payload` as its own row, show `payload_hash`
next to it, and send that same hash back with the decision.

```ts
await client.api.POST('/approvals/{approvalId}', {
  params: { path: { approvalId } },
  body: { decision: 'approved', payload_hash: approval.payload_hash },
});
```

If the draft moved between the person reading it and the decision landing, the
hash no longer matches and the API answers `409 approval_hash_mismatch`. Show
that as "this changed while you were reading it", refresh, and ask again. Never
retry with the new hash on the person's behalf: they approved the old bytes.

Editing a draft produces a different hash and therefore a different action. There
is no such thing as amending an approved send.

## The unknown-outcome rule

An action that was dispatched and never acknowledged rests at `unknown`. It means
the effect may or may not have happened. It is not a failure, it is not a
success, and **it is never retried**.

Show `unknown` and `unresolved` actions as needing a person, distinct from both
success and failure, and put them at the top of the ledger. The words that work
are the plain ones:

> I sent this once and never heard back. It may or may not have arrived. I have
> not sent it again.

The only way out is a person saying what they found:

```ts
await client.api.POST('/actions/{actionId}/resolve', {
  params: { path: { actionId } },
  body: { resolution: 'succeeded', note: 'It is in the Sent folder.' },
});
```

`resolution` is `succeeded`, `failed`, or `unresolved`. `unresolved` is a real
answer and a legitimate resting place; do not hide it or make it hard to pick.
Whatever the person says is recorded as a reconciliation, and the action is not
dispatched again either way.

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

## The inbox rule

**Render `because` and `if_ignored`, and nothing else. One question at a time.**

`GET /questions` is the whole inbox. It is one queue across every
responsibility, not one queue per job: a job contributes at most one entry, and
the service keeps whatever else it wanted to ask for a later wake. Entries come
back in the order a person should deal with them, which is what blocks an
external effect first, then the nearest deadline, then the oldest. Render the
list in the order it was given and do not re-sort it.

Every entry, and every row in `GET /notifications`, carries two fields:

| Field | What it is | What to draw |
|---|---|---|
| `because` | handles of the records that made this necessary, such as `event:4821` or `claim:k_01J...` | the reason, resolvable back to the record |
| `if_ignored` | one plain sentence about what happens if nobody acts, carrying a date when one exists | under the reason, in the same weight as the rest |

Those two fields are the interface. Do not add urgency the service did not
claim: no invented severity, no red badge on a question whose `if_ignored` says
nothing breaks, no unread count that turns a queue into a backlog to clear.

Answering is one call, and the answer reaches the job as input:

```ts
await client.api.POST('/questions/{id}/answer', {
  params: { path: { id: question.id } },
  body: { text: 'Send it to the flat, not the office.' },
});
```

That job wakes and no other job moves. Resending the same answer replays the
original receipt instead of waking the job twice, so a retry after a dropped
connection is safe. A question the person has already moved past answers with
`409 question_closed`; refresh the queue rather than retrying.

A notification without a `because` does not exist. The outbox refuses it with
`notification_without_because`, and a quiet monitor whose check found nothing
new writes no row at all, because there is no handle to cite. An empty inbox
means nothing needs a person, not that something went missing.

## The five states a job can wait in

A job that is not moving is waiting for exactly one thing, and the interface's
whole job is to name it. Use these sentences.

| `job.state` | Say exactly this | What to offer |
|---|---|---|
| `waiting_for_input` | **I need one answer from you before I can go on.** | `job.wait.question`, and a box that posts to `/jobs/{id}/messages` |
| `waiting_for_approval` | **I have something to send. Read it and decide.** | the approval card, from the action record |
| `waiting_for_event_or_time` | **Nothing to do until something happens. I am watching for it.** | `job.next_wake_at`, or what the trigger is |
| `needs_reconciliation` | **I cannot tell whether one action happened. Tell me what you find.** | the unknown action and the resolve control |
| `failed` | **I stopped without finishing. Here is how far I got.** | the last attempt's outcome detail |

`job.wait` carries the specifics: a `question` for input, `action_ids` for an
approval, a `wake_at` for a timer, a `trigger_id` for an event.

The other four states need no sentence. `queued` and `running` are motion,
`completed` is a result, `cancelled` is over.

Two things to get right whatever the state. A job outlives the tab, so never
imply the person has to stay and watch. And one job asks one question at a time:
`job.wait.question` is the only thing it is waiting to hear, and anything else it
wanted to ask is held on `job.deferred_questions` until a later wake. If you find
yourself building a per-job list of prompts, the interface has drifted from what
the service actually does; the one list that does exist is
[the inbox](#the-inbox-rule), across jobs rather than within one.

## Developing against the mock

`apps/mock-api` implements every operation in `openapi.json` in memory, and runs
jobs through the same `transition` function the service uses. It is enough to
build a whole client against.

```bash
bun run dev:mock                  # http://localhost:3190
bun run dev:web                   # http://localhost:5173
```

Point a client at it with `VITE_MELETE_API`, or `baseUrl` directly. Two
scenarios ship in `apps/mock-api/scenarios/`, chosen by what the job objective
says:

- **approved-send** — runs to a receipt through an approval, and takes a denial
  to a question rather than a second attempt at sending.
- **unknown-outcome** — the connector never answers; the action rests at
  `unknown` and the job at `needs_reconciliation` until a person settles it.
  Ask for something "unknown" or "flaky" in the objective to get this one.

Adding a case is a JSON file, not a branch. The mock parses every request with
the contract's schemas on the way in and every response on the way out, so a
body it invented that the document does not describe fails there rather than in
your client.
