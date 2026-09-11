# 0024 · The web app is built from the design canvas, behind one adapter

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

## How conversations run against the mock

`apps/mock-api` serves the designed surfaces under `/surfaces`. A
conversation is a view over jobs: each message a person sends becomes a job
played by a scenario through the real state machine, and the trail, cards,
permissions, receipts, questions and unknown outcomes are derived from that
job's persisted events (`apps/mock-api/src/surfaces.ts`). So the approval
flow, the hash mismatch, the one-question-at-a-time rule and the unknown
outcome all hold in the new interface with the same mock that held them in the
reference client. The scenario vocabulary grew additively: `say`, `card`,
`draft`, `ask`, `browser`, and human `title` / `meta` / `sources` on `tool`.

Text deltas are streamed live and never stored, so a reconnect draws a gap
marker where streamed text may be missing rather than stitching two halves
together. Durable events replay from the last seq the client drew.

## Consequences

- When `packages/contracts/src/experience.ts` lands, the adapter is the file
  to change; the screens and the reducer stay.
- `bun run --cwd apps/web screens` walks every surface at 1440, 1024 and 390
  in light and dark, checks for horizontal overflow and console errors, and
  writes `apps/web/docs/screens/`. It is the visual regression check.
- Inbox, Messages, a Calendar page and Files are not built and not offered in
  the navigation. The day panel carries today's events and tasks.
