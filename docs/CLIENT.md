# Building a personal interface

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

## No backend vocabulary in the interface

Render the adapter's text and typed fields. Do not fetch internal records to build
cards. Tool names, arguments, raw JSON, hashes, model identities, token counters,
logs, internal handles, and model reasoning do not belong in the interface.
Opaque ids, versions, and undo handles are request parameters, not labels.
The `say` step is a short statement of intended action; it is never reasoning.

Permission cards come from the saved action being reviewed. Never reconstruct
permission from an answer, or substitute fresh permission bytes after a stale
decision. Display `what`, `why`, and the offered choices. For sending, show `draft` in full, including every recipient in `recipient`, `cc`, and `bcc`; the result-card preview may be shortened. A message that cannot be reviewed safely offers only denial. Sources identify the
connected app and the readable source title; `connection_id` selects its logo.

## Authentication and scope

v0.1 has one owner. Set up or sign in with the existing password endpoints;
the client sends the `HttpOnly` session cookie with `credentials: 'include'`.
Experience routes derive their personal space from that session. Requests cannot
supply an owner or space id. An item from another space is unavailable.
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

## Conversations and the composer

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
turn. A running pause is offered only when the runtime supports a safe checkpoint;
the currently pinned runtime returns `not_available` for that case. Do not turn
pause into a new run or repeat completed actions.

## Trail and answer streaming

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

## Drafts, permissions, receipts, and rules

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
recipient never authorizes another, and an untrusted destination cannot create
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

## Quick answers, agents, and saved details

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
retracted evidence is not shown. Show an empty explanation honestly when no
recent usage is recorded.

## Plans, home, routines, and search

| Surface | Operations and behavior |
| --- | --- |
| Plans | `GET/POST /plans`, `GET /plans/{id}`; progress and next step are derived from milestones |
| Milestones | `PATCH /plans/{id}/milestones/{milestoneId}` updates a person's done state; agent steps complete from their scheduled work |
| Plan conversation | `POST /plans/{id}/conversation` accepts an agent id and preserves the plan as context |
| Profile | `GET/PATCH /profile` sets name, time zone, and day-hours window, including overnight windows |
| Home | `GET /home` returns the local greeting/date, calendar events when connected, and open tasks |
| Tasks | `GET/POST /tasks`, `PATCH/DELETE /tasks/{id}` |
| Routines | `GET/POST /automations`, `POST /automations/{id}/test`; sentences describe schedules and recent runs describe outcomes |
| Morning brief | `POST /automations/morning-brief` accepts `agent_id` and `at` in the profile's time zone |
| Connections | `GET /experience/connections` returns app names, labels, status, and readable access levels |
| Search | `GET /search?q=` searches conversations, plans, tasks, connected apps, recent actions, and cached calendar events in the session's space |

Agent milestones use the durable timer queue. Routines use the existing schedule
triggers and return to their schedule after a completed occurrence. Each
occurrence has its own spending and attempt allowance. Home calendar refreshes
can only read and share a result within a minute. Search is lexical; action and
calendar search examine the most recent 500 confirmed action records, with at
most 100 results overall.

Plan sharing, browser sessions and controls, now playing, and live data have typed
contracts but return `not_available` until their backing capability is connected.

## Developing against the mock

Run `MOCK_PORT=3202 bun run dev:mock` in Git Bash and point the client at that
address. The mock uses the existing scripted scenarios and the service's pure
projection functions, and validates experience requests and responses against
the same schemas. Its data is local to the mock process.

The repair/email scenario prepares a draft, asks for permission after the explicit
send, and produces a receipt after approval. The unknown/flaky scenario leaves
an unconfirmed send for the person and does not send it again. Saved details are
projected from the mock's active seeded records. Profile, agents, tasks, plans,
rules, and routines can be exercised without connecting an external service.
Browser tasks and sign-in delivery remain honestly unavailable in the mock.

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
