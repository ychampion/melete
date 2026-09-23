# Memory

Memory authority is Postgres evidence and versioned claims. Markdown in git is a
derived inspection/edit view; the SQLite index belongs to the file-view tooling.
A plain filesystem edit does not update authoritative memory. This distinction
is exercised by `Markdown round trips support, preserves local edits, and owner
edits become protected revisions` in
[`markdown-tests.ts`](../apps/melete/test/integration/markdown-tests.ts).

The service entry point wires authenticated jobs, approvals, events and the
other service modules. Every Postgres-backed `bootstrap`
starts the memory core and worker behind the restriction-journal restore gate,
mounts the authenticated memory routes, and wraps each attempt's runtime with
context recording and invalidation; the `docker` adapter starts the deployment
memory the same way. An injected runtime receives context recording only when
the caller supplies the `memory` dependency. The broker origin resolver is wired
in `broker/start.ts` and tested by `an address read off a page is refused as
untrusted_recipient_origin`. The scripted HTTP proof `wired-assistant.test.ts`
corrects a claim over these routes through a real local engine.

## Automatic memory from chat

What a person types into a conversation or a job is offered to their memory
with no step of theirs. A capture loop reads each user message off the job's
stream once and keeps it as evidence on the `chat` stream, in the speaker's own
memory for that space; `memory_capture` records what it did with every message.
Only the person's own messages are evidence here: assistant answers, pages,
mail and tool output are never read as facts about them. The memory model then
reads the message through the model gateway (see
[DEPLOYMENT](DEPLOYMENT.md#memory-model)) and proposes claims, which pass the
same validation, precedence and correction rules as every other extraction. It
keeps preferences, standing instructions and facts about people, places,
projects and dates, and supersedes a claim the message corrects.

Messages are kept from personal spaces, and in a shared space only from its
owner. A member's messages in a shared space are not kept in any memory, theirs
or the owner's. A message counts as the owner's only when the service recorded
the owner as its speaker, in the owner's own conversation (`only the space
owner's own messages are kept; a member's are kept nowhere` in
[memory-shared-space.test.ts](../apps/melete/test/integration/memory-shared-space.test.ts)).

A person can say these in plain words:

| They say | What memory does |
| --- | --- |
| "Remember that ..." | Keeps it as their own statement, at owner trust |
| "That's wrong, it's ..." or "Actually, ... now" | Supersedes the claim it corrects |
| "Forget that" or "Don't remember that" | Removes what their previous kept message in the conversation taught, through the restriction journal |
| "Forget &lt;something&gt;" | Removes the saved details that name it, through the restriction journal |
| "Don't remember this: ..." | Does not keep that message |

Each change is shown in the conversation as a tool entry ("Remembered",
"Updated", "Forgot"). It is written as a
`notice` with payload kind `memory_tool` and operation `write`, `correct` or
`forget`, naming the detail by its plain label and quoting the value from the
person's own message; a forget names the detail without its value. The notice
goes only on the conversation the message came from. What an attempt was handed
is read from its context record.

`GET /memory/settings` and `PUT /memory/settings` (`{ "capture": boolean }`)
read and change whether new messages are kept for the signed-in person. Capture
is on by default; turned off, "forget ..." still works.

Evidence: `say, recall later, correct in plain words, and forget, each told as a
tool entry`, `a person who turns memory off is not remembered, and can still say
forget`, `a message from someone who does not own the space is never kept in its
memory` and `the memory gateway holds each person to a daily number of calls`
in [memory-chat.test.ts](../apps/melete/test/integration/memory-chat.test.ts).

## Evidence, claims and correction

Accepted evidence records exact source identity, version, spans and stream
sequence. Claims have stable IDs and numbered revisions, support references,
validity times and provenance. A correction requires the expected revision and
an idempotency key. Current recall and historical recall are distinct.

The web app's final setup step saves four owner-stated answers through
`POST /memory/items` with `{ key, value, statement? }`. The session supplies
the owner and space. `persistEvidence` records the statement on the `onboarding`
stream in the same evidence journal used by corrections; `publishRevision`
creates a protected claim with owner origin trust. No extraction is needed for
these statements. `GET /memory/items` lists their source as `onboarding`.

Stating the same key again supersedes its previous revision and leaves one
active head. The replacement uses the correction path's invalidation and
repair journal for outputs that used the old value. Preference answers enter
the memory profile after its queued rebuild and are then included in attempt
bundles. Keys maintained by deterministic event and contact extractors receive
`409 extractor_owned_key`; the existing correction route remains available.
The [onboarding integration tests](../apps/melete/test/integration/onboarding-memory.test.ts)
cover four answers, replacement, provenance, session scope, refusal, repair,
and an attempt bundle carrying an answer.

Settings also offers `POST /signout`. It revokes only the session behind the
cookie and clears that cookie; saved memory remains, and another live session
can still read it. The [sign-out test](../apps/melete/test/integration/signout.test.ts)
checks the old cookie is refused while the other session continues to work.

| Behaviour | Named test in the integration suite |
| --- | --- |
| Durable ingest and replay identity | `persist before acknowledgment, dedup, immutable versions, separate streams` |
| Stream and scope checks | `concurrent inputs commit contiguous stream sequences and reject cross-space metadata` |
| Immediate protected correction | `claim revisions retain exact support and direct corrections are immediate and idempotent` |
| Correction races with extraction | `HTTP extraction racing a correction retries from a fresh fenced snapshot` |
| Exact-span validation | `whole-set validation rejects wrong spans, spoofed attribution, and conflicting creates` |
| Current and dated historical views | `recall supplements a lagging lexical index and dates historical revisions` |
| End-to-end scripted trip | `July to August survives sessions, an old import, correction races, process kills, scope, forget, and restore` |

These tests are in [memory.test.ts](../apps/melete/test/integration/memory.test.ts)
and its imported test modules. They use Postgres, pg-boss and scripted extraction:
they check how interpretations are stored, validated, corrected and served,
while the truth of a model's interpretation rests with the model and with the
owner's corrections.

## Storage and retrieval

| Data | Authority or view |
| --- | --- |
| `memory_sources`, `memory_source_content` | Evidence metadata and retained source text |
| `memory_claims`, `memory_revisions`, support and derivation tables | Versioned interpretations and dependencies |
| `memory_work`, `memory_outbox`, `memory_streams` | Durable extraction, publication and consumption state |
| `memory_suppressions`, `memory_spaces` | Serving restrictions and generations |
| `memory_index_entries`, optional dense entries, profile and index manifest | Rebuildable retrieval views |
| `memory_contexts`, outputs and repair briefs | Delivered context and recorded dependency information |
| `knowledge/<claim-id>.md` | Derived inspection/edit surface |
| Independently retained restriction journal | Removal records replayed before restored data can serve |

The storage paths are defined in `memory/schema.ts`, `db.ts`, `views.ts`
and `markdown.ts`; the tests above and below exercise them.

Recall uses native Postgres lexical search and optionally an injected embedding
provider. Candidates still cross authoritative revision, source, suppression
and audience checks (`lexical and dense candidates are independent and
incompatible embeddings fail closed`). The comparison fixture uses scripted
three-dimensional embeddings, so it checks the independence and fail-closed
rules rather than retrieval quality.

A request is matched by any of its meaningful words, ranked by how many match
and how closely, so "Email Ana the agenda for Thursday" finds the claim on
Ana's address. An attempt recalls by the person's newest messages and the job's
objective, and always carries the eight newest preferences, read from the claims
themselves. The knowledge budget charges a quarter of each item's UTF-8 bytes
per token, the estimate the model gateway charges input by
(`a request phrased as a sentence recalls the fact it needs and not the others`,
`the four setup answers all reach an everyday request within the knowledge
budget` and `the newest preferences are the ones every attempt carries` in
[memory-recall-quality.test.ts](../apps/melete/test/integration/memory-recall-quality.test.ts)).

Recall reports `complete`, `degraded` or `unavailable`, with a coverage reason.
A successful empty search is distinct from timeout (`database timeout is
unavailable and a successful empty search is complete`). Complete refers to
the bounded search recipe, not exhaustive source coverage. The integration test
`recall supplements a lagging lexical index and dates historical revisions`
also checks the recall budget; the timeout test above checks the deadline.
The budget and deadline bound each recall; its latency at scale depends on the
host and the size of the corpus.

## Inspect and edit through authenticated routes

The optional `createMemoryRouter` requires a trusted `resolveScope`; scope is
not accepted from model/request metadata. See `authenticated routes reject body
scope, foreign claim IDs, and reader writes`.

| Route | Purpose |
| --- | --- |
| `POST /memory/sources` | Ingest source evidence |
| `GET /memory/sources/{id}` | Inspect eligible evidence with suppressed spans masked |
| `GET /memory/claims` | Inspect eligible heads |
| `GET /memory/claims/{id}/history` | Inspect dated revisions and support |
| `POST /memory/recall` | Retrieve current or historical context |
| `POST /memory/corrections` | Commit a protected correction against an expected revision |
| `POST /knowledge/{recordId}/edit` | Submit a Markdown edit as owner evidence |
| `GET /knowledge/proposals` | Inspect pending review |
| `POST /knowledge/proposals/{id}/apply` | Revalidate and apply a proposal |
| `DELETE /knowledge/proposals/{id}` | Discard a proposal |

The core route implementation is `memory/routes.ts`; the interface's saved
details are served by `experience/memory.ts` and `experience/routes.ts`.
The Markdown round-trip and
`review mediation stages diffs and revalidates apply against authoritative
evidence` tests supply authentication, actual IDs and revisions. The default
service mounts these routes whenever Postgres is configured, with scope derived
from the authenticated principal's verified membership. Run the fixture command
below for a reproducible example.

## Dependencies, contradictions and origin

Recall handles identify claim revisions and source versions. Recorded output
`uses` manifests support selective invalidation and repair briefs
(`a correction marks stale exactly the output that cited it and says what to
repair`; `the next attempt is handed the repair brief in its inputs`).
An output with an empty `uses` manifest, which is mostly chat prose, keeps the
conservative rule and is recorded as unattributed on its context record.

The typed key registry and uniqueness indexes prevent duplicate heads on keyed
claims (`the database refuses a second claim on one key`). Precedence and
disputes are tested by `July, then a document, then August, then a late email:
one head, one question`. A proposal without a registered key is stored unkeyed
and sits outside that constraint.

Tier 0 parses supported structured observations before model extraction.
Tier 1 validates keys and exact spans (`a wrong span and a hallucinated address
are rejected; the connector date is the head`). Validation confirms that a
keyed value sits in the span it cites; a value read the wrong way from a correct
span is put right by a correction.

Origin follows evidence, and the broker consults it for recognised external
payload fields (`a page-sourced address is external content; the same address
from the owner is not`; `an address read off a page is refused as
untrusted_recipient_origin`). Origin is not permission, and memory correction
does not undo an external receipt. See [ENGINEERING](ENGINEERING.md).

## Forgetting and restore

Forgetting suppresses eligible recall and old source replay. Source deletion
and revocation invalidate dependent context; cleanup retries separately.
Evidence: `forget suppresses old replay, allows fresh explicit evidence, and
survives an old database snapshot`, `source and space revocation invalidate
delivered context and block stale serving`, and `deletion hides synchronously,
cleanup failures retry, and startup refuses a missing journal`.

The retained restriction journal records memory removals for replay; actions
are recorded in Postgres, not in this journal. `restoreMemory` gates spaces
before replay, then opens eligible spaces. The break test
`skipping the restriction replay turns the forgetting family red` shows why the
journal must be retained independently of database rollback.

Cleanup deletes the forgotten content and its index entries from Melete's
database: a source removed whole loses its text, a span forgotten out of a longer
message is blanked in place, and repair briefs and owner questions that quote a
forgotten value go with it (`forgetting a detail erases its text and keeps what
was said beside it` in
[memory-forget-quality.test.ts](../apps/melete/test/integration/memory-forget-quality.test.ts)).
Old Git commits, backups, the external source account and copies
already delivered elsewhere keep what they hold, and Postgres's data files and
write-ahead log keep deleted rows until that space is reused. Rolling the
database and the journal back together also rolls back the removals made since,
so retain the newest journal as [DEPLOYMENT](DEPLOYMENT.md#backup-and-restore)
describes.

## Startup and active attempts

The default bootstrap provisions authenticated memory scope, initialises a new
journal only for new storage, calls `startMemoryService` before serving memory
traffic, mounts `createMemoryRouter`, and applies the `withMemoryRuntime`
wrapper to the attempt runtime. An application that embeds the modules
directly must do the same. Evidence for the components: `startup gates serving,
pg-boss derives scope from work, and background indexing catches up`; `runtime
adapter discards delivered context and rejects events after an owner
correction`.

Extraction and view publication use durable work and fenced leases
(`continuation cursors and queue repair survive lost delivery and an obsolete
lease holder`). pg-boss runs on the fixture database (`pg-boss uses the embedded
database`). Each attempt assembles and records its own context at start rather
than reusing one prepared earlier. Procedure promotion is a separate, scoped
loop with its own tests ([LEARNING](LEARNING.md)); the memory runner records its
procedure-transfer scenario as a todo rather than executing it.

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/test/integration/memory.test.ts
bun run conformance:memory
```

The integration fixture uses disposable Postgres and scripted HTTP extraction.
The standalone runner covers seven families with ten scenarios and a
withheld-memory arm. Its eighth family, procedure transfer, holds one scenario
recorded as a todo and so has no executed case; the learning tests cover
promotion. See the [memory conformance README](../conformance/memory/README.md)
for exact scope.
Both use scripted extraction and answers, so they measure the memory service's
behaviour rather than a model's reasoning.

`bun run conformance:memory:eval` runs conversations a person might have (in
`conformance/memory/eval`) through the same service, the chat capture loop
included, and counts what is stored, what a later attempt is handed, what a
removal erased from every memory table, what stayed out of a recall, and what
the conversation was told.
