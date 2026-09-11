# W9 — the product surface that makes Melete agentic and natural

Append-only. Each section is one green commit: what changed, and the check line
that says it holds.

## 1. Identity and reply style

`packages/skills/builtin/identity.md` rewritten inside its 250-token cap (244 by
the loader's estimate). It now states the reply rules the style check measures:
answer first, one to three sentences unless detail was asked for or the thing is
the deliverable, a deliverable is an artifact, no preamble, no restating the
question, no bullets in a casual reply, never call yourself an AI, contractions
are fine, match the register, one question at a time. It also carries the
receipt rule, the stop rule (external, spend, irreversible, disputed,
untrusted origin), and the instruction to refer to prior work in one clause.

`packages/contracts/src/style.ts` is the deterministic check: banned openers
matched at the start of the reply only, a sentence budget by reply class
(casual 3, detailed 12, deliverable unbounded), at most one question mark, and
no self-reference as an AI. Code fences and code spans are removed before
counting, so a snippet containing a question mark is not a question.

`conformance/style/` holds the samples and the runner: seven good samples that
must come back clean and eight bad ones that must trip exactly the codes written
beside them. `bun run conformance/style/check.ts` prints the table.

`apps/melete/src/runtime/style.ts` wraps any runtime adapter, reads the text the
attempt committed, and hands the violations to a recorder. It never blocks: a
recorder that throws changes nothing about the outcome. `withMemoryRuntime`
wires it to `memory_contexts.style_violations` (migration 0014), so how an
attempt talked is recorded beside what it was given.

```
bun run typecheck                 clean
bun run lint                      Checked 295 files. No fixes applied.
bun test --max-concurrency=2      920 pass, 14 todo, 0 fail, 3845 expect() calls, 74 files
bun run openapi                   wrote packages/contracts/openapi.json (unchanged)
bun run client:generate           wrote packages/client/src/schema.d.ts (unchanged)
bun run compose:check             compose:check passed (12 checks)
```

Falsifier tests: `conformance/style/style.test.ts` "every sample gets the
verdict written next to it", "every banned opener is actually caught when it
opens", "the identity file is inside the 250-token cap it loads on every attempt
against"; `apps/melete/src/runtime/style.test.ts` "never blocks: a recorder that
throws does not fail the attempt".

## 2. Reactions

A reaction is an event about an event. A message id is the `seq` of the event
that carries the message, because Melete has no message table: the durable event
stream is the transcript and a bubble on screen is one event. That means a
reaction replays on reconnect with the message it belongs to and needs no
storage of its own.

`packages/contracts/src/reactions.ts` adds the `reaction` event type, the emoji
validator (a glyph, not a word), `POST /messages/{id}/reactions`,
`GET /messages/{id}/reactions` and `GET /jobs/{id}/reactions`. The runtime
reaches the same behaviour through the broker: `react` is in every catalog with
effect class `read`, no connection and no approval, and the broker refuses a
reaction aimed at another job's message.

Attention: a thumbs-down from a person on an assistant message makes the result
it lands on count as two unread ones; a thumbs-up clears the streak the way
opening the job does. Reacting twice with the same emoji records one reaction and
counts once, so a retry after a dropped connection is safe.

The reference app draws reactions under the bubble with quiet controls that
appear on hover or focus, never as a transcript row. The mock API implements all
three routes. `docs/CLIENT.md` gains "The reaction rule".

```
bun run typecheck                 clean
bun run lint                      Checked 299 files. No fixes applied.
bun test --max-concurrency=2      930 pass, 14 todo, 0 fail, 3899 expect() calls, 75 files
bun run openapi                   wrote packages/contracts/openapi.json
bun run client:generate           wrote packages/client/src/schema.d.ts
bun run compose:check             compose:check passed (12 checks)
```

Falsifier test: `apps/melete/test/integration/reactions.test.ts` "two thumbs-down
trip the frequency reduction one cycle earlier than unread alone" — two
background monitors on the same threshold of three, one reacted to and one left
alone; the reacted-to one is `frequency_reduced` at cycle two while the silent
one is still `normal`, and the silent one only gets there at cycle three.

Also: "a thumbs-up clears the unread streak", "reacting twice with the same emoji
records one reaction and counts once", "a reaction is an ordinary event:
persisted, replayed and readable over HTTP" (asserts the SSE frame),
`apps/melete/test/integration/broker.test.ts` "the runtime can answer a message
with a glyph instead of prose".
