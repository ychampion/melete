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
wires it to `memory_contexts.style_violations` (migration 0015), so how an
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

## 3. Delta briefs

`since_last` is an additive field on the attempt bundle, built in
`buildSinceLast` from durable rows only: the actions this job took since the
last attempt ended with their status and the connector's own receipt reference,
artifacts and knowledge records written since, the question already asked and
the ones still held, the approvals nobody has decided, and any repair brief.

`renderSinceLast` is the model-facing text. It is plain lines and nothing that
is not on a row. An action with no receipt is never described as though it had
one, and a first wake says "This is the first attempt on this job" rather than
inventing prior work. The identity file tells the model to refer to prior work
in one clause; this is what it refers to it from.

The delta is measured from the newest attempt whose context still matches the
current policy and connection generations, so a delta never names work the next
attempt is not allowed to build on. The memory runtime wrapper puts the pending
repair briefs on both `inputs.repair_briefs` and `since_last.repair_briefs`.

```
bun run typecheck                 clean
bun run lint                      Checked 301 files. No fixes applied.
bun test --max-concurrency=2      940 pass, 14 todo, 1 fail, 3930 expect() calls, 77 files
bun run openapi                   wrote packages/contracts/openapi.json
bun run client:generate           wrote packages/client/src/schema.d.ts
bun run compose:check             compose:check passed (12 checks)
```

The one failure is `packages/knowledge/src/space.test.ts` "a record carries the
trailer of the write that made it, not of its neighbour", which fails the same
way on integration at 9484023 with none of this branch's changes: `EBUSY:
resource busy or locked, rm 'C:\...\melete-space-...'` while removing a Windows
temp directory, plus a 5s timeout. It is a pre-existing platform flake in a
package this lane does not touch.

Falsifier tests: `apps/melete/test/integration/since-last.test.ts` "after a
completed send the next bundle names the receipt, and the model-facing text says
it"; `apps/melete/test/integration/properties-e1-tests.ts` "the next attempt is
handed the repair brief in its inputs", extended to assert the bundle built
after a correction carries the brief in `since_last` and that the rendered text
names the old and new values.

Also: `packages/contracts/src/since-last.test.ts` "an action with no receipt is
not described as though it had one", "a first wake has no prior work to name",
"the brief is bounded, so one busy job cannot crowd out the rest of the prompt".

## 4. Watch predicates

Trigger kind `watch`: a connection, an event name, and a predicate the service
evaluates against the observation when it arrives. No match, no wake. The
language is dotted field paths into the observation, at most five clauses all of
which must hold, and six operators: `eq`, `contains`, `matches`, `lt`, `gt`,
`changed`. There is no `or`, because two reasons to wake are two watches, and
that keeps every wake traceable to one predicate a person can read.

Everything unclear is false: a missing field, a comparison between things that
are not comparable, a pattern that does not compile, a first sighting under
`changed`. A pattern that does not compile is refused when the watch is made
rather than silently never matching. `changed` compares against the last
observation this watch looked at, kept on the trigger row (migration 0016), so
observations that do not match still advance the cursor and are never tested
twice.

When one matches, the job wakes with the observation as its evidence and the
consumed-event notice carries `because: ["event:<seq>"]`. `docs/CONNECTORS.md`
gains "Watching a feed without spending on it".

Falsifier test: `apps/melete/test/integration/watch.test.ts` "a hundred
observations that do not match wake nothing; the one that matches wakes exactly
once" — after 100 non-matching observations the job's state and state version
are unchanged, there is no `trigger_event` row and exactly one attempt exists;
the next, matching, observation wakes it once, `because` names that
observation's seq, and the following attempt's bundle carries it as a trigger
event.

Also: "a changed clause is quiet on a first sighting and wakes on the second,
different one", "a pattern that does not compile is refused when the watch is
made, not silently never matched", "the cursor moves past observations that were
tested, so none is tested twice", and fourteen unit tests in
`packages/contracts/src/watch.test.ts`.

## 5. Capability manifests and the podcast skill

A connector reaches something that already exists; a capability makes something
that did not. The difference that matters is that generation costs money and
produces a file, so a capability is implemented behind the connector interface:
one action of effect class `spend`, an approval bound to the payload hash, a
budget reservation, an idempotency key, a receipt persisted before the runtime
hears anything, and a verify that reads the file back off disk. Cost and effect
class come from trusted configuration, never from a tool argument. Adding a
second path to the world would mean a second place to get approval, fencing and
idempotency right.

`packages/contracts/src/capabilities.ts` carries the enum (`audio.synthesize`,
`audio.transcribe`, `image.generate`, `code.execute`, only the first
implemented), the manifest, `buildToolCatalog` (connectors ∪ capabilities
filtered by grants) and `skillsWithToolsAvailable` (a skill is offered only when
every tool it names is in the catalog). Connections gain a `generation`
provider, and `configuredConnectors` registers the capability connector for one.

The fake provider gains a text-to-speech adapter that writes a valid RIFF/WAVE
file of silence with the script in a LIST/INFO comment chunk, so the whole path
runs with no key and no network and "the episode says what the script said" is a
real read of a real file. The real adapter posts to an OpenAI-compatible speech
endpoint, is advertised only when `OPENAI_API_KEY` or an OpenAI-compatible base
URL is configured, and its test is skipped without one.

`packages/skills/builtin/make-a-podcast/SKILL.md` is 381 tokens by the loader's
estimate, inside its 400 cap. The reference app renders an audio artifact with a
player, built from the receipt's artifact detail.

Falsifier test: `packages/skills/src/capability-skills.test.ts` "is offered when
the speech capability is configured" and "is absent when it is not, and the
other skills are unaffected" — with the capability in the catalog the skill is
offered and trigger selection picks it; without it the skill is not offered at
all, selection returns nothing, and the other built-ins are untouched.

Also: `apps/melete/src/connectors/tts.test.ts` "writes a playable artifact and
returns a receipt naming its hash" (reads the script back out of the file that
was written), "verify reads the file back, so an unknown dispatch has an
answer", "a path that is not a simple file name is refused", "with no adapter it
fails honestly instead of writing an empty file";
`packages/contracts/src/capabilities.test.ts` "an unavailable capability is
absent rather than advertised and refused".

Deliverables 4 and 5 land in one commit. They share three contract files
(`index.ts`, `entities.ts` and the generated `openapi.json`), so splitting them
would have produced a first commit that does not typecheck, which is a worse
thing to put in the history than a commit that does two things.

## Rebase and final verification

Rebased onto `origin/integration` at 9484023, which had landed the memory
conformance runner and the one-owner-queue commit while this lane was working.
Three conflicts, all resolved: `conformance/package.json` keeps both new
dependencies; the two migrations added here were renumbered to 0015 and 0016
behind integration's own 0014; and this lane's note became 0015 in
`.agents/notes/`.

```
bun run typecheck                 clean
bun run lint                      Checked 329 files. No fixes applied.
bun run openapi                   wrote packages/contracts/openapi.json
bun run client:generate           wrote packages/client/src/schema.d.ts
bun run compose:check             compose:check passed (12 checks)
```

Tests after the rebase, in three groups:

```
bun test conformance/style packages/contracts packages/skills \
  apps/melete/src/runtime apps/melete/src/connectors \
  apps/melete/src/knowledge apps/mock-api
                                  352 pass, 1 skip, 0 fail, 1060 expect() calls, 28 files

bun test apps/melete/test/integration/{reactions,watch,since-last}.test.ts
                                  15 pass, 0 fail, 70 expect() calls, 3 files

bun test apps/melete/test/integration/{memory,broker,gateway}.test.ts
                                  69 pass, 0 fail, 687 expect() calls, 3 files
```

The one skip is the real OpenAI-compatible speech adapter, which is key-gated
and says so.

Whole-suite runs on this machine stopped being trustworthy near the end: other
lanes were running their own suites concurrently, a single `bun test` went from
509 seconds to over 900, and the failures that appeared were 5-second hook and
test timeouts in files this lane does not touch — `conformance/scenarios/01`,
`apps/melete/test/integration/jobs.test.ts`, `packages/knowledge/src/space.test.ts`
— the last of which fails the same way on integration with none of this branch's
changes. The last clean whole-suite run on this branch, before the podcast skill
landed, was 930 pass / 14 todo / 0 fail across 75 files. Two real failures did
come out of those runs and are fixed: `apps/melete/src/knowledge/routes.test.ts`
hard-coded six built-in skills and now reads `BUILT_IN_SKILLS.length`, and
`apps/melete/test/integration/{broker,gateway}.test.ts` asserted exact tool
catalogs that now also contain `react`.

Anyone re-running this branch on a quiet machine should expect the whole suite
green; the groups above are the part I can state as verified.

## Assumptions

- `git -C C:/Users/gamin/melete-oss-w9 status --short`: six tracked draft edits existed at 000b590; no untracked files. Drafts preserved outside the repository; the reaction tests will be finished separately for findings 1 and 2.
- `rg resolveSpace apps/melete/src`: the reviewed W1 auth code has no session-space resolver. Finding 1 will bind the authenticated owner to the oldest personal space, matching the single-owner setup, and will ignore caller-supplied space headers.
- `gh pr view 14 --repo ychampion/melete`: PR 14 already exists against integration. Keep that PR and branch; no duplicate PR to main.
- `bun install`: passed; embedded-postgres 17.10.0-beta.17 already exists as a devDependency, with disposable Postgres and pg-boss fixtures.
- `clock`: W9-fix began 2026-09-11 20:40 UTC; campaign deadline 2026-09-12 01:40 UTC.

## Finding 1

- `bun test apps/melete/test/integration/reactions.test.ts -t "a session cannot reach"`: reproduction added before restoring the draft fix.
- `a session cannot reach a message in another space, and learns nothing by trying`: RED at 000b590; expected 404, received 201.
- `bun test apps/melete/test/integration/reactions.test.ts --max-concurrency=2`: GREEN, 7 pass, 0 fail, 43 assertions, 21.64s; cross-space add/list/listForJob return 404 with no reaction or attention write.
- `bun run typecheck`: passed. `bunx biome check` on the four changed TypeScript files: passed after formatting.
- `bun test --max-concurrency=2`: full suite running under `C:/Users/gamin/.melete-test.lock` before the first push; log `melete-w9-full-first.log`.

## Finding 2

- `266a2e0`: finding 1 committed; finding 2 reuses and finishes the preserved spoofing draft test.
- `a client cannot sign a reaction as the assistant` and `the public mock route rejects assistant attribution without writing`: RED at 266a2e0, expected 400, received 201 in both APIs.
- `personReactionRequest`: additive public schema; retained the existing createReactionRequest fields and assigned person identity server-side.
- `266a2e0`, `bun test --max-concurrency=2` under the full-suite lock: 992 pass, 1 key-gated skip, 14 existing todo, 0 fail, 4099 assertions, 511.34s. Three-minute target exceeded; final run will share one throwaway Postgres through DATABASE_URL without changing fixture isolation.
- `git -C C:/Users/gamin/melete-oss-w9 push -u origin lane/w9-product`: pushed finding 1 after the locked suite.
- `bun test apps/melete/test/integration/reactions.test.ts apps/mock-api/src/app.test.ts --max-concurrency=2`: GREEN, 42 pass, 0 fail, 143 assertions; both preserved reaction draft tests are finished.
- `bun run typecheck`, `bun run openapi`, `bun run client:generate`, and changed-file `biome check`: passed for finding 2.

## Finding 3

- `e6d6596`: finding 2 committed and pushed.
- `bun test packages/contracts/src/watch.test.ts -t "nested repetition" --max-concurrency=2`: RED, the 8192-character `^(a+)+$` probe took 786.6364ms against the 500ms bound. The subprocess watchdog protects the shared test event loop.
- `bun add --cwd packages/contracts --exact re2js@2.8.6`: installed the linear-time matcher; `compileWatchPattern` is shared by watch creation and evaluation. API verified against https://github.com/le0pard/re2js and the installed README.
- `bun test packages/contracts/src/watch.test.ts apps/melete/test/integration/watch.test.ts --max-concurrency=2`: GREEN, 20 pass, 0 fail, 63 assertions, 26.39s; the adversarial matcher finishes below 500ms.
- `bun run typecheck`, `bun run openapi`, `bun run client:generate`, changed-file `biome check`: passed for finding 3; generated files unchanged.

## Finding 7

- `1c9c272`: finding 3 committed and pushed.
- `bun test packages/runtime-hermes/src/adapter.test.ts -t "actual Hermes run request"`: RED; the real loopback POST /v1/runs contained only title/objective and omitted the receipt marker.
- `the actual Hermes run request carries the since-last receipt and pending question`: GREEN through a fake API server on port 3190 after rendering the durable delta into input.
- `bun test packages/runtime-hermes/src --max-concurrency=2`: 43 pass, 0 fail, 105 assertions, 711ms. `bun run typecheck` and changed-file `biome check`: passed.

## Finding 6

- `b0dffec`: finding 7 committed and pushed.
- `uv run --no-project --python 3.12 --with pytest==9.1.1 python -m pytest packages/runtime-hermes/tests -q -k react`: RED, both probes returned unknown_connection without reaching the broker.
- `test_registered_react_forwards_to_reactions_with_the_attempt_token` and `test_react_preserves_the_brokers_same_job_refusal`: GREEN through registered runtime handlers and the loopback HTTP broker.
- `bun run test:plugin`: 22 passed in 13.48s; unknown connection entries for other tools remain rejected.
- `bun test apps/melete/test/integration/broker.test.ts -t "runtime can answer a message" --max-concurrency=2`: GREEN, 1 pass, 0 fail, 5 assertions, 16.90s; uses the existing `rejectionOf` helper to avoid the documented Windows async-matcher stall.
- `bunx biome check apps/melete/test/integration/broker.test.ts` and `git diff --check`: passed.
