# 0025 · The web app is built from the design canvas, behind one adapter

## Decision

`apps/web` is the Melete web application, not a reference client. It is built
from the owner's design canvas: the tokens, primitives and components in the
canvas source are ported one to one into `apps/web/src/design/`, and a living
component sheet at `#/design` renders every primitive in every state from the
product's own code, so the canvas and the product cannot drift apart silently.

Everything a surface needs from a backend goes through one adapter,
`apps/web/src/experience/adapter.ts`, typed by
`apps/web/src/experience/types.ts`. Those types follow
`docs/design/INTEGRATION.md` and are the shapes the experience contract will
carry. Nothing above the adapter knows a route, a tool name, a model name or a
token count.

## What the interface shows, and what it never shows

The interface shows outcomes, receipts and the one decision only the person
can make. The trail under an assistant turn has exactly four kinds of step:
`say` (one or two plain sentences from the agent), `action` (a past-tense
human label with a short meta and the sources it read, drawn with their
logos), `note`, and `done` (the collapsed resting line: how long, which apps,
how many sources). There is no `thought` step and there never will be: the
trail is written for the person, not a transcript of the model.

The permission card is built from the action record's canonical payload and
decided against its hash, exactly as the approval-card rule in
`docs/CLIENT.md` requires. It has three outcomes: allow once, always (which
creates a rule visible under Settings › Rules, revocable), and deny. When a
result card's primary button is the decision ("Add to calendar"), the
separate permission card is not drawn; the card's More menu carries the other
two outcomes.

Every write comes back as a receipt (what, where, when) with an undo valid for
a stated window, drawn under the card that caused it. Drafts are objects with
a recipient and a channel; sending is a separate explicit press, and nothing is
sent by the model.

Any surface whose capability the adapter reports as unavailable is not drawn
and is not offered: the browser task card and its docked panel, the OAuth
buttons, the voice control, attachments, and the tour stages. There is no
"coming soon".

## How conversations run against the contract

The web app reads `packages/contracts/src/experience.ts` through the generated
client and nothing else. `apps/web/src/experience/adapter.ts` is the single
file that talks to the service: every call returns data, an error, or the
contract's `not_available` reason, and a surface whose call answers
`not_available` is not drawn. `apps/web/src/experience/reduce.ts` folds the
event stream (`say`, `action`, `note`, `done`, `text_delta`, `card`,
`receipt`, `permission`, `question`, `status`) into turns with their trail and
blocks; the `status` item carries the composer state, so the interface never
guesses whether the agent can be paused or stopped.

`apps/mock-api/src/experience.ts` plays the designed scenarios
(`apps/mock-api/scenarios/*.json`) through those routes: a message picks a
scenario by what it says, tool steps become `action` steps with app-named
sources, `await_approval` becomes a permission card with the result card as
its preview, `dispatch` becomes a receipt with an undo handle. Every body it
emits is validated against the contract's schemas, and its text is checked
against the backend vocabulary list, so a tool name cannot reach the interface.

An effect the connector never confirms is not a note alone. The mock records
it in the store's action ledger at `unknown` (the same ledger the broker
routes serve), the interface reads `GET /actions?job_id=` when a turn settles
and draws the unknown-outcome card, and the person's answer goes to
`POST /actions/{id}/resolve`, after which the chat continues. A permission or
question decided from somewhere else closes on the first event that follows
its `needs_you` status, without claiming which way it went; the contract has
no decision event, and the note lists one.

Reactions come from the W9 contract rather than the experience one. A
conversation is a job, so its reactions list under `GET /jobs/{id}/reactions`,
and a message is addressed by an event seq: the mock mirrors every experience
event and every person message into the store's job stream so the two share
one seq space and the reaction routes accept them. The interface posts a tap to
the turn's first event seq, maps an agent's glyph to the turn whose events
follow the person's message, and reads the list when a turn settles.

Text deltas are streamed live and never stored, so a reconnect draws a gap
marker where streamed text may be missing rather than stitching two halves
together. Durable events replay from the last seq the client drew.

## Consequences

- What the contract does not carry is not drawn, and each such gap is listed
  as a proposed additive change in
  `.agents/notes/proposed/2026-09-12-w16b-experience-shapes.md`.
- `bun run --cwd apps/web screens` walks every surface at 1440, 1024 and 390
  in light and dark, checks for horizontal overflow and console errors, and
  writes `apps/web/docs/screens/`. It is the visual regression check.
- Inbox, Messages, a Calendar page and Files are not built and not offered in
  the navigation. The day panel carries today's events and tasks.
