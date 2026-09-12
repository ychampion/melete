# W16c: reactions in the web app, from the W9 contract

Append-only. What was built, the checks that ran, and what stays hidden.

## Assumptions

- Branch `lane/w16c-reactions` from `origin/integration` at `55b6a50`, worktree
  `.`. No other worktree, `main` or `integration`
  was touched, and nothing was stashed.
- The merged tree was checked before any change: `bun run --cwd apps/web typecheck`
  clean, `bunx biome check apps/web apps/mock-api` "Checked 53 files … No fixes
  applied", `bun run --cwd apps/web build` green, `bun test apps/mock-api` 38 pass /
  0 fail, `node apps/web/scripts/screens.mjs` "126 checks, 0 failed". Nothing
  regressed in the web lane merge; nothing needed fixing there.
- A conversation is a job. The mock names conversations with job ids and the
  service's experience adapter keys them by `jobId`, so `GET /jobs/{id}/reactions`
  with the conversation id is grounded on both sides.
- A message is addressed by the seq of the event that carries it, as
  `packages/contracts/src/reactions.ts` says. The experience stream and the job
  stream now share one seq space in the mock.

## Slice: reactions on the bubbles they belong to

- `apps/mock-api/src/experience.ts`: every experience event is also appended to the
  store's job stream (`text_delta` keeps its type, the rest are `notice` rows), and
  its seq comes from that append, so the reaction routes accept it as a message id.
  The person's message is appended as a `turn_started` row and its seq kept per
  turn. A new scenario step `react { emoji }` appends a `reaction` event by the
  assistant on that seq. A turn that opens with a glyph gets no generic opener, and
  a `complete` with an empty answer after a `react` ends the turn without words. The
  resting line counts the turn's own sources rather than the conversation's (a
  pre-existing mock slip that showed once a chat had two turns).
- `apps/mock-api/src/scenario.ts`: the `react` step; `scenarios/acknowledgement.json`
  matches "thanks", "thank you", "got it", "perfect" and answers with 👍.
- `apps/web/src/experience/types.ts`, `adapter.ts`: `Reaction` from the generated
  paths; `reactions(conversationId)` on `GET /jobs/{jobId}/reactions`,
  `react(seq, emoji)` on `POST /messages/{messageId}/reactions`.
- `apps/web/src/experience/reduce.ts`: each turn records `firstSeq`, the seq of the
  first event the agent produced for it; `turnIndexForReaction` maps a reaction to
  its turn (the person's tap lands on the turn whose first event it names; the
  agent's glyph names the person's message, which precedes that turn's events).
- `apps/web/src/chat/parts.tsx`, `Chat.tsx`, `chat.css`: `REACTION_SET` (👍 👎 ❤️ 🙏),
  `ReactionRow` drawn under the bubble it belongs to (never a row of its own), the
  four one-tap buttons in the agent turn's action bar, the agent's glyph under the
  person's bubble. Reactions are read when a turn settles and after a tap. No control
  is drawn on a turn without a first seq (local, queued) or one the service refused
  a reaction on (404 or 409 hides the buttons for that turn). Cards, receipts and
  permissions are not messages and carry no control.
- `apps/web/scripts/screens.mjs`: after the dinner flow the walk sends "Thanks, that
  is perfect.", waits for the agent's reaction on the job, taps 👍 on the earlier
  result, and fails unless the tap is drawn as the person's and the agent's glyph
  sits under the person's bubble (`chat-reactions`, 1440 and 390, both themes).
- `docs/CLIENT.md`: the web app's paragraph under the reaction rule;
  `.agents/notes/0025-web-app.md` and the mapping note updated (the reactions row is
  closed; the live-item proposal remains).

## Checks

`bun run --cwd apps/web typecheck` clean; `bunx biome check apps/web apps/mock-api`
"Checked 54 files … No fixes applied"; `bunx tsc -b` clean;
`bun run --cwd apps/web build` "✓ built in 318ms"; `bun test apps/mock-api`
38 pass / 0 fail; `node apps/web/scripts/screens.mjs` against the seeded mock on
:3210 and vite on :5180: "130 checks, 0 failed" (27 surfaces at their declared
widths, light and dark, no horizontal overflow, no console or page errors; one
earlier run had a single `ERR_CONNECTION_REFUSED` on a page load with ~780 sockets
in TIME_WAIT on this box, and the re-run was clean). The full repo suite was not
run, as instructed.

## Still hidden

- A reaction arrives when the turn settles, not live: this client follows the
  conversation stream, which has no `reaction` item. Proposed in the mapping note.
- The person's message seq is inferred from the turn's first event rather than
  carried on `conversationTurn`; proposed there too.
- Reactions cannot be removed; the contract has no delete route, so a tap adds and
  a second tap on the same glyph is the same reaction.
- Memory items from setup answers and sign-out: no route on any branch.

## Current integration behavior

The earlier ordering-based reaction association is replaced by message identity.
The client retains job-stream message records and resolves an explicit turn ID
or a unique conversation, text and transaction-timestamp match. Unknown and
ambiguous targets are omitted. Text events provide the targets for controls;
card-only, receipt-only and acknowledgement-only answers have none. Switching
conversations resets reaction state.

The regression file passes 20 cases, including two person messages before one
reply, delayed projection, repeated text, ambiguous identity and rendered
control visibility. The screen walk passes 130 checks. Setup answers and
sign-out are also implemented on integration; the earlier limitations above
describe the original reaction implementation only.
