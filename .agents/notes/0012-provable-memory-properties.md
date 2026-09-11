# 0012. Four memory properties the service enforces

Status: accepted
Date: 2026-09-11

## Problem

The memory core stores evidence, versions claims, and serves recall under a
lock. What it could not do was answer four questions without appealing to a
model's judgement or to a conservative sweep.

- Which outputs does a correction actually break? The service knew what had been
  *delivered* to an attempt and nothing about what an output *used*, so the only
  safe answer was "everything that ever saw this claim".
- Which of two contradictory facts is current? Claims carried a free-text domain
  key, so "do not leave two active heads by accident" was a sentence rather than
  a constraint, and resolving a disagreement was left to the extractor.
- Can the facts that drive an external effect be trusted at all? Dates, times,
  recipients and amounts came out of a model call, and those are exactly the
  values models get wrong.
- Where did a value come from? Provenance existed in memory and stopped there, so
  an address planted in a fetched page could reach the recipient field of an
  approved-looking send with nothing to distinguish it from something the owner
  typed.

The full argument is in `docs/ENGINEERING.md`, which this note implements the
memory half of.

## Decision

**Dependence is declared.** Recall items carry `claim_id@revision`; sources carry
`source_id@version`. An output, an artifact, a plan step or an action, records a
`uses` manifest in `memory_outputs` and `memory_output_uses`, and a derivation
edge per handle. A correction marks stale exactly the outputs citing the
superseded revision and writes a repair brief on each affected responsibility:
the handle that moved, the value before and after, and every output with the
location inside it where the old value sat. The next attempt receives pending
briefs in `inputs.repair_briefs`. An output with an empty manifest keeps the
conservative rule and is listed as `unattributed` on the context record, so a
reader can see which outputs the precise rule did not cover.

`checkPayloadAttribution` is pure and is served at `POST /memory/attribution`, so
the broker can run it without reading claims: it reports any recipient, date,
amount or identifier in a payload that appears in a delivered item whose handle
the manifest does not name.

**One active head per key.** `MEMORY_KEY_SHAPES` in `packages/contracts` is the
registry: `event.<slug>.date`, `event.<slug>.location`, `contact.<slug>.email`,
`contact.<slug>.phone`, `pref.<domain>.<name>`, `constraint.<job>.<name>`. It
lives in the schema and grows by a reviewed commit. Two unique indexes compose
into the property: `memory_claim_key_head` allows one un-hidden claim per
(space, key, audience), and the existing `memory_one_active_revision` allows one
active-or-disputed revision per claim.

Precedence is `keyPrecedence`: owner correction, owner statement, verified
connector observation, document assertion, inference. Ties break by event time.
Import time is never an authority. Two equal candidates with no explicit
supersede leave both revisions committed, open a row in
`memory_contradictions`, and queue one question in `memory_questions` whose
`because` is the two revision handles and whose `if_ignored` says what Melete
will keep serving. Recall flags the key and the attempt bundle carries the flag,
so the runtime knows not to act externally on it without approval. An owner
correction on the key closes the contradiction and answers the question.

**Deterministic extractors first.** Tier 0 runs before any model call and, for a
structured connector observation, instead of one: a calendar entry, a contact
record or a receipt becomes a `checked_fact` with no gateway request at all.
Dates resolve through `chrono-node` against the source's event time and the
owner's zone, with the offset computed from the platform's own time zone
database; addresses, phone numbers, URLs and amounts are grammar. Tier 1 may
propose a key and a span and nothing else: `validateTier1` re-derives every span
verbatim from the evidence at the offsets it names, requires the key to be in the
registry, requires a date to parse and to be present in the cited span, requires
an address to be well formed and present, and refuses `checked` status to
anything that is not a connector observation. `confidence` is stored and never
read as a status. A failure is a row in `memory_rejections` with its reason.

**Trust class on every revision.** A source declares `author`, owner or external,
at ingest. `origin_trust` follows from how the bytes arrived, never from what
they say: an owner edit or a message the owner wrote is `owner`; an observation
or receipt is `verified_connector`; a document, or a message somebody else wrote,
is `external_content`; assistant prose is `inferred`. A revision takes the
minimum over its sources, and a model's own conclusion stays `inferred` whatever
it cites. `createTrustResolver` implements the `TrustResolver` interface the
broker holds and answers, per payload field, which handle explains it, what class
that handle carries, and a sentence for a person: "this address came from a web
page fetched on 11 September". Fields nothing explains are named in `unresolved`,
so an untraceable recipient is a fresh approval rather than a silent pass. The
Markdown view and the memory API show `origin_trust` and the disputed flag.

## Ownership: the proposal review surface

The Postgres claim store is the authority for what is staged and for what
applying it means, so the memory module owns `/knowledge/proposals`: listing,
applying and discarding. The knowledge module keeps what it is for, staging a
proposal through the mediator, the git store, the lint and the index, and its two
review handlers are gone. Its tests now exercise the mediator directly, which is
what they were about. Listing a space is declared in the contract, so
`PENDING_CONTRACT` is empty; `.agents/notes/proposed/2026-09-11-knowledge-api-gaps.md`
is resolved by this note and deleted.

## Alternatives

- **Keep conservative invalidation and skip manifests.** Rejected: it is correct
  and useless. Every correction restarts every responsibility, which is the
  behaviour that makes a long-running assistant not worth running.
- **Let the extractor resolve contradictions.** Rejected: that is the decision
  most worth taking away from a model, and a table makes it reviewable.
- **Derive trust from what a source says about itself.** Rejected: that is what a
  hostile page would write.
- **A registry that grows by extraction.** Rejected: a key an extractor invents
  is a key nothing else can find, and the uniqueness constraint would protect
  nothing.

## Evidence

Each rule was falsified by restoring the behaviour it replaces and watching the
scenario go red, then restoring the rule.

| Behaviour put back | What turned red |
|---|---|
| Mark every recorded output stale instead of the ones citing the revision | E1: all six outputs stale where one was expected |
| Let a lower-precedence candidate take the slot | E2: the head became the document's `2026-06-15` |
| Skip `checkTier1` in `validateTier1` | E3: no rejections recorded and the hallucinated address became the head |
| Resolve a document as `owner` | E4: the page-sourced address resolved as `owner` |

`bun run typecheck`, `bun run lint` (274 files), `bun test --max-concurrency=2`
(836 pass, 14 todo, 0 fail, 850 tests across 67 files), `bun run openapi` and
`bun run compose:check` (11 checks) all pass. The trip acceptance scenario and
the five process-kill failure schedules from the memory core still pass
unchanged, which is what the unkeyed carve-out below is for.

## What this leaves for later

Two carve-outs are deliberate and worth knowing about.

Claims created before a key existed, and claims created through paths that do not
name one, keep the older domain-key uniqueness and the existing
`resolveMeaning` rules. Keys are required of Tier-1 proposals that name one and
of everything Tier 0 produces; they are not retrofitted. The trip scenario and
the failure schedules still run on the unkeyed path, which is how this landed
without rewriting them.

The registry has no shape for a money amount, so a receipt contributes its date
and its amount stays evidence that can validate a proposal but cannot be a claim
on its own. Adding `spend.<slug>.amount` is a reviewed commit, which is the
point of the registry.
