# W8b: four provable properties on the memory core

Append-only. Each slice records what was built, the checks that ran, and the
falsification that showed the rule was load-bearing.

## Assumptions

- Branch `lane/w8b-memory` from `origin/integration` at `d822707`, worktree
  `C:/Users/gamin/melete-oss-w8b`. No other worktree, `main` or `integration` was
  touched, and nothing was stashed.
- Toolchain bun 1.3.13; integration tests run against embedded Postgres 17 on
  127.0.0.1:3122, one disposable database per file.
- `bun add --cwd apps/melete --exact chrono-node@2.10.1`: a maintained date
  parser, pinned, as the addendum requires. Time zone offsets come from the
  platform's own database through `Intl`, not from a table in this repo.
- Lane W8c had not landed on `integration` at branch time, so the owner question
  goes to the memory outbox as `kind = 'question'` with `because` set to the two
  revision handles, exactly as the brief specifies for that case. Nothing in this
  branch imports W8c, so it merges either way.
- Contract changes are additive. Every new field either has a default or is
  supplied by this branch's own producers.

## Slice 1: the vocabulary, the tables, and the four implementations

SHA `90ba26a` "Make memory dependence, keys, extraction and trust checkable".

The four properties share one migration and one commit path, so they landed
together; the falsifier for each is its own commit below.

- `packages/contracts/src/memory.ts`: the key registry `MEMORY_KEY_SHAPES`, the
  `origin_trust` classes with their rank and minimum, and the handle format with
  `claimHandleOf`, `sourceHandleOf` and `parseMemoryHandle`. `claim` gains `key`,
  `claimRevision` gains `origin_trust`, `sourceEvent` and `ingestSourceRequest`
  gain `author` and `time_zone`, `recallItem` gains `handle`, `key`,
  `origin_trust` and `disputed`, `recallResult` gains `disputed_keys`,
  `contextRecord` gains per-item handles plus `unattributed` and `disputed_keys`,
  and a proposal may carry `key` and `confidence`.
- `packages/contracts/src/provenance.ts`: outputs and their `uses` manifests, the
  attribution request and report, repair briefs, contradictions, owner questions,
  rejection reasons, per-field trust, and the `TrustResolver` interface the
  broker holds.
- `packages/contracts/src/runtime.ts`: `knowledgeExcerpt` gains `handle`, `key`,
  `origin_trust` and `disputed`; `attemptBundle.inputs` gains `repair_briefs`.
- Migration `0010_memory_provenance.sql`: `key` on claims with the partial unique
  index `memory_claim_key_head`; `origin_trust` and `confidence` on revisions;
  `author`, `origin_trust` and `time_zone` on sources; `unattributed` and
  `disputed_keys` on contexts; and six new tables, `memory_outputs`,
  `memory_output_uses`, `memory_repair_briefs`, `memory_contradictions`,
  `memory_questions`, `memory_rejections`.
- New modules under `apps/melete/src/memory/`: `trust.ts`, `tier0.ts`,
  `validate.ts`, `attribution.ts`, `outputs.ts`, `contradictions.ts`.
- New routes: `POST /memory/outputs`, `POST /memory/attribution`,
  `POST /memory/trust`, `GET /memory/questions`, `GET /memory/contradictions`,
  `GET /memory/rejections`, `GET /memory/jobs/{id}/repair-briefs`.

Checks at this SHA:

- Command `bun run typecheck`: pass.
- Command `bun run lint`: pass, 265 files.
- Command `bun test --max-concurrency=2`: 795 pass, 14 todo, 1 fail; the single
  failure was a mediator lookup that returns `null` rather than `undefined`, and
  the file passed 26 of 26 after the assertion was corrected.
- Command `bun run openapi`: regenerated. Command `bun run client:generate`:
  regenerated.

## Slice 2: the proposal review surface has one owner

SHA `b7472bd` "Give the proposal review surface a single owner".

The knowledge module's `GET /knowledge/proposals` and
`POST /knowledge/proposals/{proposalId}/apply` are removed; the memory module
already serves both, from Postgres, which is the authority for what is staged and
for what applying it means. The declared response shape was the memory one, so
the file-backed handlers were serving something the document did not describe.

`POST /knowledge/proposals` stays in the knowledge module: it is the mediator,
the one write path an agent has, it is declared in the contract, and memory does
not serve it. The four tests that reached the removed handlers now call
`listProposals`, `applyProposal`, `requiresApproval` and `getProposal` directly,
which is what they were testing.

`GET /knowledge` is now declared in the contract, so `PENDING_CONTRACT` is empty
and `.agents/notes/proposed/2026-09-11-knowledge-api-gaps.md` is deleted; note
0012 records that it is resolved.

## Slice 3: the four falsifiers

Each is its own commit, with the unit tests for that property's pure rules.

| SHA | Property | Falsifier test |
|---|---|---|
| `0ae345d` | E1 | `E1 dependence is declared, not guessed > a correction marks stale exactly the output that cited it and says what to repair` |
| `b0ffc06` | E2 | `E2 one active head per key > July, then a document, then August, then a late email: one head, one question` |
| `fe1b3df` | E3 | `E3 deterministic extractors run first > a wrong span and a hallucinated address are rejected; the connector date is the head` |
| `a34071d` | E4 | `E4 trust class travels from evidence > a page-sourced address is external content; the same address from the owner is not` |

Supporting tests: `apps/melete/src/memory/attribution.test.ts` (7 tests),
`contradictions.test.ts` (10), `tier0.test.ts` (13), `trust.test.ts` (4), plus
`E1 dependence is declared, not guessed > the next attempt is handed the repair
brief in its inputs` and `E2 one active head per key > the database refuses a
second claim on one key`.

Each rule was falsified by restoring the behaviour it replaces, running the one
test, and restoring the rule:

| Behaviour put back | Result |
|---|---|
| `outputsCiting` selects every output in the space | `(fail) E1 ...` with `art_0` expected and all six of `art_0` through `art_prose` received |
| `resolveKeyedHead` publishes on `lower_precedence` | `(fail) E2 ...` Expected to contain `2026-07-20`, received `2026-06-15T00:00:00.000Z` |
| `validateTier1` never calls `checkTier1` | `(fail) E3 ...` two `value_not_in_evidence` rows expected, one row received |
| `originTrustOf` returns `owner` for a document | `(fail) E4 ...` Expected `external_content`, received `owner` |

## Slice 4: the addendum and the decision it settles

SHA `f7ae26f` "Write down what the service proves and why".

- `docs/ENGINEERING.md`: the addendum, with the lane references removed and the
  competitor comparison rewritten as a statement about process-level taint.
- `.agents/notes/0012-provable-memory-properties.md`: the decision note, with the
  falsification table as its evidence section, the ownership decision, and the
  two carve-outs stated plainly.
- `docs/MEMORY.md` gains a section for a self-hosting reader; `README.md` and the
  notes index link the new documents.

## Final checks

At SHA `f7ae26f`, in `C:/Users/gamin/melete-oss-w8b`:

- Command `bun run typecheck`: pass.
- Command `bun run lint`: pass, 274 files checked.
- Command `bun test --max-concurrency=2`: 836 pass, 14 todo, 0 fail, 3477
  assertions, 850 tests across 67 files, 189.61 s.
- Command `bun run openapi`: pass; a re-run leaves the committed document
  unchanged.
- Command `bun run compose:check`: pass, 11 checks, including "the internal
  network has no route out" and "the runtime publishes no ports".
- Test `trip acceptance`: pass, log line `current August, dated July, 2 process
  kills, stale proposal rejected, no cross-space delivery, suppression replayed;
  parent scripted calls=2`.
- The five process-kill failure schedules from the memory core pass unchanged.

## Carve-outs, stated rather than hidden

**Keys are not retrofitted.** A claim created without a key keeps the older
domain-key uniqueness and the existing `resolveMeaning` rules. Keys are required
of Tier-1 proposals that name one and of everything Tier 0 produces. This is why
the trip scenario and the failure schedules still pass unchanged, and it is the
reason the one-head property is stated over keyed claims rather than over all of
them. Retrofitting is a migration plus a review of every existing domain key, and
it belongs in its own change.

**The registry has no shape for a money amount.** A receipt contributes its date;
its amount stays evidence that can validate a proposal but cannot be a claim on
its own. Adding a spend shape is a reviewed commit, which is the point of having
a registry.

**The broker half of E4 is not here.** This branch implements and exposes the
resolver and the attribution check; refusing an admission with
`untrusted_recipient_origin` is the effects lane's work against the seam this one
provides.

## Slice 5: kept mergeable after integration renumbered the migrations

`origin/integration` moved to `67f93b9`, which renamed `0009_memory.sql` and
added `0010_mysterious_silverclaw.sql`, colliding with this branch's own `0010`.
Rather than hand the integrator a branch that cannot merge, `origin/integration`
is merged in here and the collision is resolved in the lane:

- Integration's migration chain is taken whole. This branch's migration is
  regenerated from its schema on top of it and named
  `0011_memory_provenance.sql`, with a matching `meta/0011_snapshot.json` and
  journal entry. Its contents are unchanged: the same six tables, the same
  columns, the same two partial unique indexes.
- `apps/melete/src/knowledge/routes.test.ts` conflicted on its import block only.
  Both sides are kept: integration's `testDatabase` helper and this branch's
  mediator imports.

Checks after the merge, at `C:/Users/gamin/melete-oss-w8b`:

- Command `bun run typecheck`: pass.
- Command `bun run lint`: pass, 274 files checked.
- Command `bun test --max-concurrency=2`: 836 pass, 14 todo, 0 fail, 3475
  assertions, 850 tests across 67 files, 250.10 s.
- Command `bun run openapi` and `bun run client:generate`: regenerated, no drift.
- Command `bun run compose:check`: pass, 11 checks.
