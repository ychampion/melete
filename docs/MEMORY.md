# Memory

Memory authority is Postgres evidence and versioned claims. Markdown in git is a
derived inspection/edit view; the SQLite index belongs to the file-view tooling.
A plain filesystem edit does not update authoritative memory. This distinction
is exercised by `Markdown round trips support, preserves local edits, and owner
edits become protected revisions` in
[`markdown-tests.ts`](../apps/melete/test/integration/markdown-tests.ts).

The service entry point is more than health: it wires authenticated jobs,
approvals, events and other service modules. With the `hermes` adapter,
`bootstrap` starts the memory core and worker behind the restriction-journal
restore gate, mounts the authenticated memory routes, and wraps each attempt's
runtime with context recording and invalidation; the `docker` adapter starts
the deployment memory the same way. An injected runtime receives memory only
when the caller supplies it. The broker origin resolver is wired in
`broker/start.ts` and tested by `an address read off a page is refused as
untrusted_recipient_origin`. These statements describe code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1`.

## Evidence, claims and correction

Accepted evidence records exact source identity, version, spans and stream
sequence. Claims have stable IDs and numbered revisions, support references,
validity times and provenance. A correction requires the expected revision and
an idempotency key. Current recall and historical recall are distinct.

| Behavior | Named test in the integration suite |
| --- | --- |
| Durable ingest and replay identity | `persist before acknowledgment, dedup, immutable versions, separate streams` |
| Stream and scope checks | `concurrent inputs commit contiguous stream sequences and reject cross-space metadata` |
| Immediate protected correction | `claim revisions retain exact support and direct corrections are immediate and idempotent` |
| Correction races with extraction | `HTTP extraction racing a correction retries from a fresh fenced snapshot` |
| Exact-span validation | `whole-set validation rejects wrong spans, spoofed attribution, and conflicting creates` |
| Current and dated historical views | `recall supplements a lagging lexical index and dates historical revisions` |
| End-to-end scripted trip | `July to August survives sessions, an old import, correction races, process kills, scope, forget, and restore` |

These tests are in [memory.test.ts](../apps/melete/test/integration/memory.test.ts)
and its imported test modules. They use Postgres, pg-boss and scripted extraction;
general truthfulness of model-produced interpretations is **not claimed**.

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
three-dimensional embeddings; production dense-retrieval quality is **not claimed**.

Recall reports `complete`, `degraded` or `unavailable`, with a coverage reason.
A successful empty search is distinct from timeout (`database timeout is
unavailable and a successful empty search is complete`). Complete refers to
the bounded search recipe, not exhaustive source coverage. The integration test
`recall supplements a lagging lexical index and dates historical revisions`
also checks the recall budget; the timeout test above checks the deadline.
Production latency or scale service levels are **not claimed**.

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

The route implementation is `memory/routes.ts`. The Markdown round-trip and
`review mediation stages diffs and revalidates apply against authoritative
evidence` tests supply authentication, actual IDs and revisions. A fresh default
service does not expose this workflow automatically; that integration is
**not claimed**. Run the fixture command below for a reproducible example.

## Dependencies, contradictions and origin

Recall handles identify claim revisions and source versions. Recorded output
`uses` manifests support selective invalidation and repair briefs
(`a correction marks stale exactly the output that cited it and says what to
repair`; `the next attempt is handed the repair brief in its inputs`).
Unattributed output retains conservative invalidation. Complete attribution of
arbitrary model prose is **not claimed**.

The typed key registry and uniqueness indexes prevent duplicate heads on keyed
claims (`the database refuses a second claim on one key`). Precedence and
disputes are tested by `July, then a document, then August, then a late email:
one head, one question`. Older unkeyed paths remain; universal retroactive key
coverage is **not claimed**.

Tier 0 parses supported structured observations before model extraction.
Tier 1 validates keys and exact spans (`a wrong span and a hallucinated address
are rejected; the connector date is the head`). This does not prove every date,
address or instruction can be interpreted correctly.

Origin follows evidence, and the broker consults it for recognized external
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

The retained restriction journal is for memory removal replay. It is not an
exportable action-audit ledger; that product capability is **not claimed**.
`restoreMemory` gates spaces before replay, then opens eligible spaces.
The falsifier `skipping the restriction replay turns the forgetting family red`
demonstrates why the journal must be retained independently of database rollback.

Cleanup does not erase old Git commits, backups, external source accounts or
copies already delivered elsewhere. Universal physical erasure and recovery
after rolling both database and journal back together are **not claimed**.

## Startup and active attempts

An embedding application must provision authenticated memory scope, initialize
a new journal only for new storage, and call `startMemoryService` before
serving memory traffic. It must inject `createMemoryRouter` and the
`withMemoryRuntime` wrapper where required. The default bootstrap does not do
this. Evidence for the components: `startup gates serving, pg-boss derives scope
from work, and background indexing catches up`; `runtime adapter discards
delivered context and rejects events after an owner correction`.

Extraction and view publication use durable work and fenced leases
(`continuation cursors and queue repair survive lost delivery and an obsolete
lease holder`). pg-boss runs on the fixture database (`pg-boss uses the embedded
database`). Automatic prepared-context reuse and procedure promotion are
**not claimed**; procedure transfer is **written, not run** in conformance.

## Verify

Run from the repository root after dependency installation:

```bash
bun test apps/melete/test/integration/memory.test.ts
bun run conformance:memory
```

The integration fixture uses disposable Postgres and scripted HTTP extraction.
The standalone runner uses ten scenarios across seven executed families and a
withheld-memory arm; procedure transfer is **written, not run**. See the
[memory conformance README](../conformance/memory/README.md) for exact scope,
and the documentation lane's pull request (#17) for command outcomes. Neither establishes model
reasoning quality, statistical superiority or production scale.
