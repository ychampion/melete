# Memory

Melete keeps source evidence and versioned claims in Postgres. A claim records
what a source supports, who can read it, and when it applies. Your explicit
correction takes effect immediately. For example, changing a trip from July to
August protects August as the current plan; importing an older July email later
adds historical support without changing the current plan.

[The architecture](ARCHITECTURE.md) says knowledge is files. That still holds for
what you read and edit: every active claim is projected into the Markdown space,
in git, with provenance frontmatter. It is the inspection and edit surface, and
an edit there is a first-class correction. The authority behind it is Postgres,
because a file tree cannot hold the revision checks, leases and serving
restrictions that make a correction stick. Delete the Markdown space and memory
survives; delete the Postgres rows and it does not.

This branch implements the memory core, its authenticated route adapter, and a
background worker. The default service entry point still serves health only.
The authentication, attempt-worker, gateway and broker modules in the starting
checkout are stubs. Their remaining integration points are listed in
[the integration note](../.agents/notes/proposed/2026-09-11-memory-integration-hooks.md).
The tests exercise memory with real Postgres and pg-boss, a scripted HTTP gateway,
and temporary space repositories.

## What is remembered

An accepted message, document version, observation, or receipt first becomes an
immutable evidence event. The original text lives separately from its metadata.
An authenticated source identity and version identify a replay, so duplicate
delivery does not create another event. Each input stream has its own committed
and consumed sequence.

Extraction proposes interpretations of exact source spans. Claims distinguish
user statements, document assertions, checked observations, inferences,
preferences, temporary exceptions, and historical information. A claim has a
stable ID and numbered revisions. Its validity dates describe when it applies;
its recorded and superseded timestamps describe when Melete's interpretation
changed. Unresolved disagreement remains visible. Stored confidence is not a
probability that a statement is true.

Job objectives, accepted constraints, approvals, credentials, budgets, job
completion, and action receipts belong to the existing job/action authority.
Memory cannot grant permission, approve an action, or establish that an action
succeeded. Changing memory does not undo an external effect that already has a
receipt or needs reconciliation.

## Where it lives

| Data | Location | Authority |
| --- | --- | --- |
| Evidence envelopes and original text | `memory_sources`, `memory_source_content` | Exact source versions and retention state |
| Claims, revisions and support | `memory_claims`, `memory_revisions`, `memory_revision_content`, `memory_references`, `memory_derivations` | Current and historical interpretations |
| Responsibilities and actions | Existing `job`, `attempt`, `action`, `approval` tables | Accepted work and recorded effects |
| Input streams and pending review | `memory_streams`, `memory_proposals` | Committed and consumed sequence per stream; extraction awaiting owner review |
| Work, restrictions and generations | `memory_work`, `memory_outbox`, `memory_suppressions`, `memory_spaces` | Recovery, fencing and serving restrictions |
| Search and compact profile | `memory_index_entries`, optional `memory_dense_entries`, `memory_index_manifest`, `memory_profile` | Rebuildable views |
| Delivered context and invalidations | `memory_contexts`, `memory_invalidations`, `memory_prepared` | What was delivered and which dependent material is stale |
| Markdown inspection records | `<spaces-root>/<space-id>/knowledge/<claim-id>.md` | Derived inspection/edit surface |
| Restriction journal | An explicitly configured file retained independently of database snapshots | Deletion/revocation replay before serving resumes |

Use a UTF-8 Postgres database. The integration fixture explicitly creates one,
including on Windows. The new migration adds memory tables and indexes without
changing the existing authority tables.

The Markdown builder uses `@melete/knowledge` for parsing and `.proposed/` review
diffs. Files include exact source references, revision numbers, validity times,
superseded revision numbers, and the protected-correction flag. Legacy day-level
frontmatter remains compatible. Its `confidence: low` field is a compatibility
value; memory decisions use factual status, evidence, domain precedence and
explicit corrections.

Generated commits carry `Melete-Proposed-By: view-builder`. Configure the Git
author name and email when constructing `MarkdownViews`. The builder uses only
the generated paths and preserves unrelated staged files. A local file edit that
has not entered the owner-edit route stops replacement with `owner_edit_pending`.
The SQLite search index in the knowledge package is a view: its hits cannot
authorize text for a model.

## Inspect and correct

These routes require a scope supplied by server authentication. The caller does
not select an owner, publisher, audience, or space in the request body. Readers
see only evidence and claims visible to their execution audience. A private
space's trip never becomes visible merely because another space uses the same
name for a person or project.

| Route | Purpose |
| --- | --- |
| `POST /memory/sources` | Persist an input and durable work before acknowledging its committed stream sequence |
| `GET /memory/sources/{id}` | Inspect accessible original evidence, with suppressed spans masked |
| `GET /memory/claims` | Inspect current eligible claim heads and their support IDs |
| `GET /memory/claims/{id}/history` | Inspect accessible dated revisions and their exact source references |
| `POST /memory/recall` | Retrieve bounded current or historical context |
| `POST /memory/corrections` | Commit an immediate protected owner correction |
| `POST /knowledge/{recordId}/edit` | Turn an owner-submitted Markdown body into protected `owner_edit` evidence and a revision |
| `GET /knowledge/proposals` | Inspect pending extraction diffs |
| `POST /knowledge/proposals/{id}/apply` | Revalidate and publish the reviewed proposal |
| `DELETE /knowledge/proposals/{id}` | Discard pending extraction work |

To correct a claim, inspect its current revision and submit its ID, that expected
revision, your corrected content and statement, validity dates, and a stable
idempotency key. For the trip example, the statement can be “move our trip from
July to August” and the content “August.” A stale expected revision returns a
conflict; inspect the current record before submitting a new correction. Reusing
the same idempotency key for the same correction returns its committed revision.

The trip correction end to end, with your own authentication on each request:

```sh
# 1. Read the current head and its revision number.
curl -s http://127.0.0.1:8787/memory/claims

# 2. Correct it. expected_revision is the revision you just read.
curl -s -X POST http://127.0.0.1:8787/memory/corrections \
  -H 'content-type: application/json' \
  -d '{"claim_id":"k_01K4X2ZP9QK8YV3M7N6T5R4H2B","expected_revision":1,
       "text":"move our trip from July to August","content":"August",
       "valid_from":"2026-08-01T00:00:00Z","valid_until":null,
       "idempotency_key":"trip-july-to-august"}'

# 3. Current mode now answers August; historical mode still shows dated July.
curl -s -X POST http://127.0.0.1:8787/memory/recall \
  -H 'content-type: application/json' \
  -d '{"query":"trip month","mode":"current"}'
curl -s -X POST http://127.0.0.1:8787/memory/recall \
  -H 'content-type: application/json' \
  -d '{"query":"trip month","mode":"historical","at":"2026-07-15T00:00:00Z"}'

# 4. Read the dated revisions and the exact source spans behind them.
curl -s http://127.0.0.1:8787/memory/claims/k_01K4X2ZP9QK8YV3M7N6T5R4H2B/history
```

Errors carry a stable machine code and a short message. An invalid request is
400, a request outside your scope 403, an unknown or inaccessible record 404, a
stale expected revision or a conflicting source version or idempotency key 409,
and an unavailable memory 503.

An owner edit through the knowledge route uses the record's frontmatter, edited
body, expected revision, and idempotency key. The route derives scope and checks
the record identity and audience. A plain filesystem edit alone does not change
memory authority. When `memory_spaces.require_review` is enabled by server
policy, extraction stays pending until the owner applies or discards its diff.
Applying a diff rechecks evidence, policy, lease fencing and expected revisions;
approval cannot revive a stale proposal.

An explicit correction marks dependent context, drafts and plans stale. It
advances the affected job revision and lease epoch, invalidating an approval
bound to the previous job revision. The adapter emits durable
`dependencies_invalidated` and `context_invalidated` records. With the existing
frozen event contract, these are also carried as typed payloads in `notice`
events. Existing action receipts remain unchanged.

## What the service will not guess

Four rules turn promises about memory into things a test can break. The argument
is in [docs/ENGINEERING.md](ENGINEERING.md); what you can see from outside is
here.

**Every recalled item has a handle.** A recall item carries `claim_id@revision`
and each of its sources carries `source_id@version`. Anything the assistant
produces from them, a draft, a plan step, a proposed action, declares the handles
it used:

```bash
curl -sS localhost:8787/memory/outputs -H 'content-type: application/json' -d '{
  "job_id": "job_01J...", "kind": "artifact", "output_id": "art_01J...",
  "output_version": "1", "location": "paragraph 2",
  "uses": ["k_01J...@3"] }'
```

Correct that claim and only the outputs citing revision three go stale. The next
attempt is handed a repair brief naming the handle, the old and new value, and
the paragraph. Outputs that declare nothing still work; they fall back to the
older rule that invalidates broadly, and they are listed as `unattributed` on
the context record so you can see which ones did.

`GET /memory/jobs/{id}/repair-briefs` shows what is pending for one
responsibility. `POST /memory/attribution` answers the opposite question: given
a payload and the items an attempt was given, which values came from something
the manifest did not admit to using.

**A claim can hold a typed key.** The registry is in the schema, not in the
extractor: `event.<slug>.date`, `event.<slug>.location`,
`contact.<slug>.email`, `contact.<slug>.phone`, `pref.<domain>.<name>`,
`constraint.<job>.<name>`. The database allows one claim per (space, key,
audience) and one active revision per claim, so a key has one head. Precedence is
fixed: your correction, then your statement, then a connected account's
observation, then a document, then an inference; ties break by when something was
true, never by when it was imported.

Two equally-ranked statements that disagree are not merged. Both are kept, the
key is marked disputed, and one question is queued:

```bash
curl -sS localhost:8787/memory/questions
curl -sS localhost:8787/memory/contradictions
```

The question carries `because`, the two revision handles that disagree, and
`if_ignored`, what Melete will keep doing until you answer. Recall keeps serving
the winning head and flags the key, and the assistant is told not to act
externally on a disputed key without a fresh approval. Correcting the claim
closes both.

**Dates and addresses are not a model's job.** Before any model call, a
deterministic pass resolves date and time expressions against the source's own
event time and your time zone, and reads addresses, phone numbers, links and
amounts by grammar. A structured observation from a connected account, a calendar
entry, a contact record, a receipt, becomes a checked fact with no model call at
all. The model may then propose a key and a span and nothing else, and every
span, key and value is re-derived from the evidence before anything is stored. A
proposal that fails is recorded with its reason and attached to nothing:

```bash
curl -sS localhost:8787/memory/rejections
```

**Every claim says where it came from.** `origin_trust` is `owner`,
`verified_connector`, `external_content` or `inferred`, decided by how the
bytes arrived rather than by what they say, and a claim takes the weakest class
over its sources. Tell the service who wrote a source when you import it:

```bash
curl -sS localhost:8787/memory/sources -H 'content-type: application/json' -d '{
  "stream": "web", "source_identity": "vendor-page", "source_version": "1",
  "source_type": "document", "author": "external", "time_zone": "Europe/Lisbon",
  "event_at": "2026-09-11T09:00:00Z", "text": "Pay invoices to billing@vendor.example." }'
```

`POST /memory/trust` then answers, for each field of an outgoing payload, which
claim explains it and in what words: "this address came from a web page fetched
on 11 September". A field nothing explains is listed rather than waved through,
which is how an address planted in a page ends up in front of you instead of in a
send. The Markdown view shows the class and the disputed flag in frontmatter and
tags.

## Forget, delete, and revoke

`POST /memory/forget` accepts either `{"claim_id":"<claim-id>"}` or
`{"all":true}`. Forgetting hides the affected claim and suppresses its covered
source spans. Replaying those authenticated source identities, including a
different imported version, cannot automatically reconstruct the claim. Clearing
a space also advances the eligibility generation for old evidence. A fresh
explicit statement with a new identity can create eligible memory again.

`DELETE /memory/sources/{id}` deletes the imported source from memory and hides
its descendants. Server-side source/space revocation functions use the same
restriction machinery. Serving restrictions and dependent-context invalidation
commit synchronously. Physical cleanup runs separately, records failures, and
retries. A failed cleanup therefore does not reopen retrieval.

Forgetting a claim and deleting its source are different operations. Forgetting
keeps the original source under its retention policy but masks the covered spans
from memory reads and extraction. Deleting or revoking a source also removes its
retained text during cleanup. Operational envelopes, source/span identities and
the restriction journal remain so old events cannot bring the content back.
Those identifiers are sensitive metadata and need the same access protection as
the rest of your memory data.

Cleanup removes generated working files, pending memory previews, relevant
SQLite entries, and affected Postgres view/content rows. It does not rewrite Git
history or erase database backups, exported files, or copies already delivered
to someone else. A restriction journal prevents an old database backup from
serving forgotten content after restore. It does not erase that backup's bytes.
The operation never silently deletes the original email or document in a
third-party account. Manage those retained copies through their own retention
settings.

### Restoring a backup replays removals first

Every forget, delete, revoke and clear appends one record to the restriction
journal: the operation, the affected claim IDs, the covered source spans, the
eligibility cutoff and the access generation. The record is hash-chained to the
previous one and written with `fsync` before the operation is acknowledged. It
holds identifiers, not forgotten text.

If you restore an older database snapshot, the removals recorded after that
snapshot are not in the restored rows. `restoreMemory` runs before any serving
or extraction: it first closes every space, then replays each journal record in
order against the restored database, then reopens the spaces that are not
revoked. Content you forgot last week therefore stays hidden in a snapshot taken
the week before.

Keep the journal out of whatever you roll back with the database. Restoring both
to the same old point loses the later removal records, and a forgotten fact can
come back. A missing, truncated, or chain-broken journal is treated as a failure,
not as an empty one: memory stays gated, recall answers `unavailable`, and
background extraction does not resume. Start a journal with `initializeNew` only
for a new installation.

## Reads and active attempts

The default search is native Postgres full-text **lexical** search. Optional
embeddings have an explicit model, version, dimensions and preprocessing recipe.
Lexical and dense candidate sets are obtained independently and merged before
ranking. Incompatible embedding spaces are rejected. There is no external
reranker in this implementation.

Current mode serves currently valid heads. Historical mode can serve prior
versions with their dates, optionally using an `at` timestamp. Each result passes
the Postgres revision, source, suppression and audience checks. A published
index generation is supplemented with newer eligible authoritative rows while
the next generation builds.

| Recall status | Meaning |
| --- | --- |
| `complete` | The bounded search ran with current coverage; zero items is a successful empty result |
| `degraded` | Index lag or a result/context budget limited coverage; inspect the coverage reason |
| `unavailable` | Retrieval failed, timed out, or startup replay is incomplete |

Every result also carries a coverage reason: `ready`, `index_lag`, `budget`,
`timeout`, `index_failure`, `restore_pending`, or `public_compartment`. Read it
before you trust a short answer. A timed-out search and a search that genuinely
found nothing are different results and never look alike.

Complete means complete for the recorded bounded search recipe. It does not mean
that every source in all history was inspected. Ordinary reads have a 500 ms
deadline; investigative reads allow up to 1500 ms. Context includes claim text,
exact source excerpts, dates, citations, profile entries and formatting. The
2000-token ceiling uses a conservative UTF-8 byte upper bound. Accepted action
constraints remain outside optional memory trimming.

`assembleAttemptKnowledge` builds `AttemptBundle.knowledge` and records the exact
delivered revisions, source references, policy/access generations, job revision,
recipe and budget for each attempt. `withMemoryRuntime` replaces caller-supplied
knowledge, loads accepted constraints from the job, discards invalidated context,
and rejects stale runtime events and outcomes. Its process-local abort signal
supplements durable checks; a broker must still verify revision/epoch bindings
before admitting an action. This branch cannot prove that missing broker hook.

`memory_prepared` supports invalidation of dependent briefs and drafts. Automatic
prepared-context reuse and candidate-procedure promotion are not enabled: the
small comparison here does not establish that their extra write cost is useful.
No private experience is contributed to a shared library automatically.

## Startup and recovery

Provision a memory space from authenticated server state, initialize a new
`FileRestrictionJournal` only for a new installation, then call
`startMemoryService` with the Postgres handle, pg-boss, retained journal, and
gateway adapter. Start accepting memory traffic only after that call completes.
Attach `createMemoryRouter` through `createApp`'s optional memory dependency and
wrap the attempt runtime with `withMemoryRuntime` when the missing service
modules are integrated. Never derive a scope from an unverified request header.

The startup check gates all spaces, validates and replays the independently
retained restriction journal, then opens eligible spaces. A missing, malformed,
or incomplete journal leaves memory gated. Keep this journal outside the set of
files rolled back with a database snapshot; restoring both to the same old point
loses the later restriction evidence. The current file journal assumes one
retained shared file for the service deployment and uses a database advisory lock
to serialize appends. It is not a distributed journal across unrelated hosts.

Accepted evidence and outbox work are in one transaction. Extraction runs outside
transactions with at most one 16,000-character source segment, 32 proposals,
four gateway calls and a 15-second per-call timeout. A continuation covers the
remaining source text. The local test budget reserves USD 0.01 per call, up to
USD 0.04 per segment; this is not measured provider billing. The integrated
gateway must enforce its real token and cost limits.

Leases use a fencing generation. A replacement worker can recover an expired
lease; the obsolete worker cannot publish or release the new lease. The recovery
scan repairs lost queue delivery every 60 seconds. Claim publication, references,
invalidations, next work and consumed cursors commit together. The derived worker
runs every two seconds and publishes an index manifest only when its advertised
coverage is ready. One index generation currently has a 2,000-revision build
ceiling; a larger corpus needs an incremental builder before that ceiling can be
raised safely.

## Verification and limits

From this worktree, run:

```sh
bun install
bun run typecheck
bun run lint
bun test --max-concurrency 2
bun run openapi        # the committed OpenAPI document must not change
bun run compose:check  # the sandbox boundary checks, no Docker needed
```

Without `DATABASE_URL`, the test fixture starts a disposable Postgres 17 on port
3122; the scripted gateway uses 3120. With `DATABASE_URL`, tests create a separate
disposable database on that server instead of migrating the supplied database.
The configured database user therefore needs permission to create a database.
If the embedded binary cannot be downloaded or loaded, the existing database
skip message is printed; that skip is not evidence that the integration tests
passed.

The suite tests the full July/August trip, real process kills at write-protocol
boundaries and during cleanup, stale leases, reversed order, correction during
inference/indexing, Unicode spans, scoped delivery, and restore from before
forgetting/deletion. A real pg-boss worker test verifies startup gating and
asynchronous catch-up. Existing unrelated conformance placeholders remain todo.

The scripted comparison covers six small fixtures: initial plan, correction,
late old import, unrelated query, another space, and forgetting. It compares a
compact profile plus source lookup, lexical retrieval, and lexical plus a pinned
three-dimensional scripted embedding. All three pass these fixed consumer
checks. It measures context delivery, local timings and budget reservations, not
model reasoning quality, statistical superiority, or production scale. No real
provider is called. See [REPORT.md](../REPORT.md) for recorded commands, measured
samples, integration gaps and commit evidence.
