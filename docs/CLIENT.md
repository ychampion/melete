# Building a client

This page describes how to build a client for Melete: the typed client, the
contract it follows, and the rules the web app adds on top. The typed client,
the web app and the scripted mock are separate from the deployed service: the
generated client follows `openapi.json`, and a deployment mounts the routes its
entry point wires.

## Typed requests and errors

`createMeleteClient` from `@melete/client` accepts a base URL, optional fetch
implementation, headers and credential mode. `client.api` uses generated
OpenAPI types. Tests in [client.test.ts](../packages/client/src/client.test.ts)
cover `posts a job as JSON and fills the path parameter`, `carries the caller
headers on every request`, and `hands back the error body rather than throwing`.
HTTP error responses return the API error body; network exceptions are still
possible. Use `errorMessage` to extract a message or supply a fallback.

The generated declarations are checked by `is byte-identical to a fresh run of
client:generate` and `covers every path in openapi.json`.

## Authentication

The real service uses an opaque `melete_session` cookie. Setup creates one
owner, personal space and session; login verifies the password and creates a new
session. Evidence in [auth.test.ts](../apps/melete/test/integration/auth.test.ts):
`racing setup requests atomically create one owner, space, and session`;
`passwords use argon2id and only a digest of the opaque cookie is stored`;
`login verifies the password, issues a fresh cookie, and returns the public owner`.

The client defaults to `credentials: 'include'`, and the service rejects
cross-origin mutations (`browser mutation gates reject cross-origin setup,
login, and authenticated writes`), so serve a browser client and the API from
the same origin. The service authenticates the owner by the session cookie;
headers a caller adds through the generic client carry no owner authentication.

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

Show reconnect gaps as possible missing text. The runner persists incoming
text-delta events, although the contract helper labels them non-durable, and
conformance 5 checks their stored rows, so streamed text can arrive again on
replay. The helper marks any sequence jump as a gap, but a filtered stream may
skip global sequence numbers without losing durable history. The service test
`a gap marker names its persisted notice and rollback holes never invent gaps`
checks the server's more precise rule.

## Approvals and uncertain outcomes

Render the canonical action payload, hash and supplied origin warnings, rather
than treating model prose as an approval card. Submit the exact reviewed hash.
A hash/revision conflict requires a refresh and a new owner decision; do not
silently approve the replacement payload. Evidence: conformance 4,
`An approval cannot be spent on different content`, and the mock test
`the payload the approval shows is canonical, not what the model typed`.

An `unknown` action may have happened. Keep it distinct from success and
failure, and do not offer an automatic resend. Connector verification can resolve
it without a person; where it cannot, the owner is asked, and the manual
resolution route accepts succeeded, failed or unresolved. Conformance 3 tests
`verify resolves the action to succeeded and the job continues` and
`against a destination with no verify, the action rests at unresolved and the
owner is asked`.

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
These tests cover the service's behaviour.

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
state machine uses`; transition behaviour is tested in
`packages/contracts/src/job-state.test.ts`.

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
needs_reconciliation`. The mock plays these scripted flows rather than calling
a model.

For real-service authentication, event and attention checks, use the full test
command in [README](../README.md).

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

## Building a personal interface

Use the experience operations in [`packages/contracts/src/experience.ts`](../packages/contracts/src/experience.ts).
They translate saved work into conversations, answers, cards, receipts, permissions,
plans, and the one decision the person needs to make. The existing lower-level API
remains additive and compatible for scripts; it is not the presentation contract.

The source of truth is [`packages/contracts/openapi.json`](../packages/contracts/openapi.json).
Run `bun run openapi` and `bun run client:generate` after contract additions.
Every experience response is either the documented success shape or
`{ status: 'not_available', reason: string }`. Hide unavailable surfaces and retain
the reason where the person explicitly requested the feature. Never manufacture
events, receipts, browser previews, or successful actions.

### No backend vocabulary in the interface

Render the adapter's text and typed fields. Do not fetch internal records to build
cards. Tool names, arguments, raw JSON, hashes, model identities, token counters,
logs, internal handles, and model reasoning do not belong in the interface.
Opaque ids, versions, and undo handles are request parameters, not labels.
The `say` step is a short statement of intended action; it is never reasoning.

Permission cards come from the saved action being reviewed. Never reconstruct
permission from an answer, or substitute fresh permission bytes after a stale
decision. Display `what`, `why`, and the offered choices. For sending, show `draft` in full, including every recipient in `recipient`, `cc`, and `bcc`; the result-card preview may be shortened. A message that cannot be reviewed safely offers only denial. Sources identify the
connected app and the readable source title; `connection_id` selects its logo.

### Authentication and scope

An installation has one owner, who can add accounts and shared spaces through
the API (`POST /principals`, `POST /spaces/shared` and
`POST /spaces/{id}/memberships`); the web app offers no screen for inviting
them. Set up or sign in with the
existing password endpoints; the client sends the `HttpOnly` session cookie with
`credentials: 'include'`. Experience routes derive their space from the
account that session authenticates: that account's own personal space, created
on first use when an older installation lacks one. Requests cannot supply an
owner or space id. An item from another space or another account is unavailable
and reads as 404.
Browser mutations must originate from the same origin as the API.

For email sign-in, configure `MELETE_PUBLIC_URL` and connect the owner's own
mailbox with send access. `POST /signin/magic-link` accepts `{ email }`. The
connector sends a link to that same mailbox; it cannot send sign-in mail to a
different recipient. The link expires in ten minutes and works once. Revoking or
replacing the connection invalidates its outstanding links. Requests are limited
to one per minute and five per hour for the owner.

The link carries its token in the URL fragment. Read it on the sign-in page,
remove the fragment from browser history, and post `{ token }` to
`/signin/magic-link/consume`; the response sets the normal session cookie.
Never place the token in a query string or store it in browser persistence.
Google and Apple sign-in return `not_available`.

### Conversations and the composer

```ts
import { createMeleteClient } from '@melete/client';

const client = createMeleteClient({ baseUrl: 'http://localhost:3200' });
const { data } = await client.api.POST('/conversations', {
  body: { title: 'Plan dinner', agent_id: selectedAgent.id },
});
if (data && !('status' in data)) {
  await client.api.POST('/conversations/{id}/messages', {
    params: { path: { id: data.conversation.id } },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { text: 'Find a free evening this week.' },
  });
}
```

Keep an idempotency key while retrying the same message. A successful submission
returns its receipt and turn id. Resending that key with different text is refused.
`GET /conversations/{id}/messages` returns the saved turns and partial answers.
Client delivery states are `sending`, `queued_offline`, and `failed_retry`; they
describe delivery to the service, not completion of the requested work.

Use `conversation.status` and `conversation.composer`. A completed turn leaves
the conversation ready for another message. `PATCH /conversations/{id}/agent`
selects the agent for the following turn; a running turn keeps its original agent.

`POST /conversations/{id}/stop` fences the active turn, interrupts the runtime,
and retains its partial answer. Queued work can pause and resume without a new
turn. A running pause needs a runtime with a safe checkpoint; the runtime
adapters Melete ships have none, so pausing a running turn returns
`not_available` and the turn can be stopped instead. Do not turn pause into a
new run or repeat completed actions.

### Trail and answer streaming

Read `GET /conversations/{id}/events?since=0`, or the personal feed at
`GET /events?view=experience&since=0`. JSON responses contain `events`,
`next_cursor`, and `has_more`. Use `Accept: text/event-stream` for SSE.
`Last-Event-ID` takes precedence over `since`; the SSE id is the persisted `seq`.
Experience events have `conversation_id`, `turn_id`, `created_at`, and `item`.

| Item type | Render |
| --- | --- |
| `say` | One or two first-person sentences before a group of actions or a decision |
| `action` | One past-tense label for the group, its metadata, and app sources |
| `note` | A plain update or interruption notice |
| `done` | Summary, elapsed time, app names, and source count |
| `text_delta` | Append to the answer for that turn |
| `card` | The supplied result card |
| `receipt` | What changed, where, and when |
| `permission` | The saved permission card |
| `question` | The question and its offered options |
| `status` | Update the composer and agent face |

Remember the last rendered sequence and drop duplicates after reconnecting.
Sequence values are shared with other persisted events and can skip; a numerical
gap alone does not mean content is missing. Display explicit interruption notes.
Saved projected deltas replay; refresh the turn's saved answer when reconciling a
reconnection. The legacy `subscribeEvents` helper reads a different event shape;
use an SSE reader for this endpoint and parse each body with `experienceEvent`.

Groups are deterministic projections of the action records. Do not split a
compound action back into one row per call. Result cards come from files,
calendar events, draft messages, pages, and saved artifacts. Treat `primary_action`
and `secondary_actions` as typed controls; do not interpret their handles.

### Drafts, permissions, receipts, and rules

Read a conversation's `/drafts`, `/cards`, and `/receipts`. A draft contains
recipient, channel, body, subject when present, and its current status. The
assistant cannot directly send from a chat conversation. The person's
`POST /drafts/{id}/send` creates the exact send for review and returns the draft,
permission when needed, and a receipt only when success is confirmed.

`GET /permissions` contains the owner decisions. Post to `/permissions/{id}`:

```ts
await client.api.POST('/permissions/{id}', {
  params: { path: { id: permission.id } },
  body: { option: 'allow_once', version: permission.version },
});
```

`always` additionally requires `bounds: { count_cap, expires_at,
reconsent_after_days }`. Offer it only when present in the card's options.
The service resolves the exact recipient from trusted evidence. A grant for one
recipient never authorises another, and an untrusted destination cannot create
a rule. The current reviewed action is allowed once; the cap applies to future
actions. A reserved use consumes the cap conservatively even if a later check
refuses execution. List rules with `GET /rules`, revoke with `DELETE /rules/{id}`.
Expiry, re-consent, access changes, and revocation are checked before execution.

A receipt is evidence of a confirmed change. When it includes `undo`, offer its
handle until `valid_until`, then post to `/receipts/{id}/undo`. Calendar creation
can be reversed with a conditional delete that refuses to erase a changed event.
The reversal has its own receipt. Sends cannot be recalled. Draft discard and
file restore are unavailable where the connector has no stored reversal.
An unconfirmed send is never repeated automatically; show the supplied reason.

### Quick answers, agents, and saved details

`GET /quick-answers` returns plain questions with `why`, `if_ignored`, and at
most four choices. Submit `{ option_id }` to `/quick-answers/{id}`. Invented choices
are refused. Native questions without choices remain available through the
existing free-text question API.

`GET /agents/templates` offers Planner, Travel concierge, and Study buddy.
`GET/POST /agents` and `PATCH /agents/{id}` manage the specified appearance,
tone, standing instruction, and allowed connections. Access is always limited by
both the active connection and the agent's selected connections. Usage and turn
status let a client derive the nine supported face states. Agent identity stays
within the shared 250-token bound.

`GET /memory/items` returns active saved details in plain language. Render key,
value, source (`onboarding`, `conversation`, or `inferred`), creation and last-use
dates, and editability. Patch `{ value, version }` to `/memory/items/{id}`;
delete the item to use the existing forget path. A stale edit is refused.
`/memory/items/{id}/why` explains the evidence a recent output used. Suppressed or
retracted evidence is not shown. When no recent usage is recorded, show the
explanation as empty.

### Plans, home, routines, and search

| Surface | Operations and behaviour |
| --- | --- |
| Plans | `GET/POST /plans`, `GET /plans/{id}`; progress and next step are derived from milestones |
| Milestones | `PATCH /plans/{id}/milestones/{milestoneId}` updates a person's done state; agent steps complete from their scheduled work |
| Plan conversation | `POST /plans/{id}/conversation` accepts an agent id and preserves the plan as context |
| Profile | `GET/PATCH /profile` sets name, time zone, and day-hours window, including overnight windows |
| Home | `GET /home` returns the local greeting/date, calendar events when connected, and open tasks |
| Tasks | `GET/POST /tasks`, `PATCH/DELETE /tasks/{id}` |
| Routines | `GET/POST /automations`, `POST /automations/{id}/test`; sentences describe schedules and recent runs describe outcomes |
| Morning brief | `POST /automations/morning-brief` accepts `agent_id` and `at` in the profile's time zone |
| Connections | `GET /experience/connections` returns app names, labels, status, and readable access levels, without removed connections. Settings adds one from `GET /connection-kinds` and `POST /connections`, tests one with `POST /connections/{connectionId}/health`, and removes one with `POST /connections/{id}/lifecycle`; see [CONNECTORS](CONNECTORS.md#installing-a-connection) |
| Search | `GET /search?q=` searches conversations, plans, tasks, connected apps, recent actions, and cached calendar events in the session's space |

Agent milestones use the durable timer queue. Routines use the existing schedule
triggers and return to their schedule after a completed occurrence. Each
occurrence has its own spending and attempt allowance. Home calendar refreshes
can only read and share a result within a minute. Search is lexical; action and
calendar search examine the most recent 500 confirmed action records, with at
most 100 results overall.

Plan sharing, browser sessions and controls, now playing, and live data have typed
contracts but return `not_available` until their backing capability is connected.

### Developing against the mock

Run `MOCK_PORT=3202 bun run dev:mock` in Git Bash and point the client at that
address. The mock uses the existing scripted scenarios and the service's pure
projection functions, and validates experience requests and responses against
the same schemas. Its data is local to the mock process.

The repair/email scenario prepares a draft, asks for permission after the explicit
send, and produces a receipt after approval. The unknown/flaky scenario leaves
an unconfirmed send for the person and does not send it again. Saved details are
projected from the mock's active seeded records. Profile, agents, tasks, plans,
rules, and routines can be exercised without connecting an external service.
In the mock, browser tasks and sign-in delivery answer `not_available`.

The web app in `apps/web` also uses the mock: run it on `3210` (`MOCK_PORT=3210 bun run dev:mock`) and `bun run dev:web` on `5180`. Its scenarios are chosen by what the message says:

- **approved-send** and **unknown-outcome**, as above.
- **dinner-with-friends** — checks the calendar, searches the web and Maps,
  drafts a note, and asks before adding the event; the result card's button is
  the decision. Ask for "dinner".
- **book-a-table** — the follow-up: opens the sandboxed browser, picks the
  slot, and asks before reserving. Say "book it".
- **kyoto-in-october**, **passport-renewal**, **welcome** — a question with
  numbered answers, a plain answer with its source, and the first message
  after setup.

The web app reads only the experience contract
(`packages/contracts/src/experience.ts`, through the generated client in
`packages/client`): conversations, turns, events, cards, receipts, drafts,
permissions, questions, agents, memory, plans, tasks, home, automations,
connections, rules and search. The mock serves those routes from
`apps/mock-api/src/experience.ts`, seeded with a person, three agents, calendar
events, plans, tasks and routines so every surface has something to show;
`MOCK_SEED=off` starts it empty, which is how the tests run it. There is no
second set of routes for the interface: what the web app can do against the
mock, it can do against the service.

Adding a case is a JSON file, not a branch. The mock parses every request with
the contract's schemas on the way in and every response on the way out, so a
body it invented that the document does not describe fails there rather than in
your client.

## Rules the web app adds

These are what `apps/web` does on top of the API. A second interface should
do the same, so a person who moves between them is never told two stories.

**The trail has four kinds of step and no more.** `say` is one or two plain
sentences from the agent to the person. `action` is a past-tense human label
("Read your calendar, checked Alex and Priya's availability"), a short meta
("free after 7:00 PM"), and the sources it read, each drawn with its app's
logo. `note` is a quiet aside. `done` is the resting line: how long, which
apps, how many sources. There is no `thought` step: the trail never shows
model reasoning, a tool name, or "Thought for N seconds".

**One decision, three outcomes.** A permission card offers allow once, always,
and deny. "Always" creates a rule the person can see and revoke under
Settings › Rules, and a later request the rule covers is allowed with the rule
named on its card. When a result card's own button is the decision ("Add to
calendar"), the separate permission card is not drawn; the card's More menu
carries the other two outcomes. A hash mismatch is shown as "This changed while
you were reading it" on the card, and the person decides again.

**Every write leaves a receipt.** What, where, when, with an undo valid for a
stated window, drawn under the card that caused it. An undone receipt says so
in place; nothing disappears.

**A setup answer is a saved detail, on the record.** Each answer in "Let Nova
get to know you" is posted to `POST /memory/items` as it is chosen: a registered
key, the value, and the sentence that was said. The service keeps it as an
owner-trusted claim on that key (one current value per key; the same key again
replaces it), lists it under `GET /memory/items` with source `onboarding`, and
the memory profile picks it up after its queued rebuild. The first conversation
opens with a message referencing a saved answer. Event and contact keys are
refused with `409 extractor_owned_key`, because deterministic extractors maintain
them; correct their existing items instead. Identity and space come from the
session, and extra identity fields in the request are refused.

**Signing out ends the session, not the account.** `POST /signout` removes the
session behind the cookie and clears the cookie; the next request is refused
until a new sign-in. Other sessions remain live. The web app offers it under
Settings and returns to the sign-in screen, including after a reload with the
revoked cookie.

**A reaction sits on its bubble.** The web app follows the reaction rule
above: the person answers an agent turn with one tap from a small fixed set,
posted to `POST /messages/{seq}/reactions` with the seq of an identified text
event. Card-only, receipt-only and acknowledgement-only turns have no reaction
controls. The glyphs come from `GET /jobs/{id}/reactions`, read when a turn
settles. The job event stream supplies the original message identities: an
explicit turn ID when present, otherwise a unique match on the conversation,
message text and transaction timestamp shared with the accepted turn. Projected
text also retains its source event identity. Unknown or ambiguous targets are
omitted; event ordering never chooses a neighbouring bubble. Switching chats
clears the reaction state. A refused reaction adds no glyph and hides that
message's controls; nothing is drawn as a "reacted" line of its own.

**An unconfirmed effect is a question, not a retry.** When a connector never
answers, the action rests in the broker's ledger at `unknown`
(`GET /actions?job_id=`), the transcript says so in a note, and the card asks
the person what happened: it arrived, it did not, or they cannot tell yet.
Their answer goes to `POST /actions/{id}/resolve` and the ledger records who
decided. Nothing is sent again in the meantime, and a draft that never
confirmed stays theirs to send.

**Drafts are sent by the person.** A draft names its recipient and channel
("Send via Messages"), can be edited in place, and nothing leaves until that
button is pressed.

**The composer has one state button.** Send when it is the person's turn,
Pause while an agent works, Resume after a pause, Stop while an answer streams.
Stop keeps the partial text. Enter sends; Shift+Enter is a new line. An
attachment queues as a tile with a progress bar and a cancel that works
mid-upload.

**A gap is drawn, not hidden.** On reconnect the durable events replay and a
marker says text that streamed while the connection was down may be missing.

**One question at a time, numbers answer it.** A question with up to four
options listens to the keys 1–4 (and the next number focuses "type your own")
only while it is the newest open question in the newest turn.

**Delivery is honest.** A message shows sending, then its time; offline it says
it will send when you are back; a failure offers retry and keeps the text.

**Unavailable means absent.** A surface whose capability the adapter reports as
unavailable (the browser card and panel, an OAuth button, voice, attachments, a
tour stage) is not drawn and not offered. Nothing says "coming soon".

**The technology stays in Settings.** Memory items, connections and rules are
the only places a person sees what Melete remembers, may reach, or may do
without asking. Errors say what happened and what already happened about it.
