# Architecture

Melete is an open-source, self-hosted, model-agnostic personal assistant. This
document describes how v0.1 is built and why. It is the contract the code is
written against, not a wish list.

## 1. Principles

1. **Thin harness, thick boundary.** Frontier models plan and write; Melete
   enforces. The model sees short things: a short identity prompt, a compact tool
   catalog, short skills, bounded retrieved knowledge. Everything the model does
   passes through a typed, durable, auditable gate.
2. **A responsibility outlives any process.** Jobs, waits, approvals, actions, and
   receipts live in Postgres. A runtime attempt is disposable. The client can
   close, the runtime can die, the job remains.
3. **Effects have identity.** Every external action is a record before it is a
   request. Approval binds to the canonical payload hash. Retries reuse the same
   action id. An unknown outcome stays unknown; it is never replayed blindly.
4. **Knowledge is files.** Memory and knowledge are Markdown with provenance
   frontmatter, per space, versioned in git, mediated by the broker. A person can
   read, edit, diff, and delete them with ordinary tools.
5. **Honest labels.** Every boundary is described exactly as strong as it is.
   v0.1 isolation is a container on a network with no route out, not a virtual
   machine, and the documentation says so.
6. **Verifiable, not claimed.** A conformance suite anyone can run proves the
   boundary and durability properties.

## 2. Topology

```
networks:
  edge      the web client and the API, reachable from the host
  internal  internal: true, no default route; the runtime lives only here

services:
  postgres   [internal]        authoritative state
  melete     [edge, internal]  API, jobs, broker, gateway, connectors
  runtime    [internal]        the thin agent loop; talks only to the broker
  web        [edge]            the client

volumes:
  pgdata, spaces, artifacts
```

The enforcement is below the process. The `runtime` container is attached only to
`internal`, which is declared `internal: true`, so the kernel has no route out and
the broker is the only reachable peer. `curl https://example.com` from inside the
runtime fails, and the conformance suite asserts it. The runtime runs as a
non-root user with a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, process and memory limits, and `/work` as its only mount.

Documented but not shipped: the runtime in a Firecracker microVM on a KVM host,
the broker in its own process with its own database role, gVisor as an
intermediate step.

## 3. Entities

| Table | Key fields | Notes |
|---|---|---|
| `owner` | id, email, password_hash or passkey | One row in v0.1. |
| `space` | id, name, kind, audience, git_path | `audience` reserved for shared spaces. |
| `connection` | id, space_id, provider, label, secret_ref, scopes, status, health | Secrets sealed with the master key. The runtime never sees `secret_ref`. |
| `job` | id, space_id, title, objective, constraints, state, revision, lease_epoch, next_wake_at, wait, budget | See section 4. |
| `attempt` | id, job_id, epoch, runtime_version, provider, model, model_actual, usage, outcome | One bounded execution. |
| `action` | id, job_id, attempt_id, connection_id, kind, canonical_payload, payload_hash, status, authorization_ref, idempotency_key, receipt, reconciliation | See section 6. |
| `approval` | id, action_id, job_revision, payload_hash, decision, expires_at | Per action, per payload hash. |
| `event` | seq, job_id, attempt_id, type, payload, dedup_key | Persisted stream; SSE replays by `seq`. |
| `artifact` | id, space_id, job_id, path, content_hash, mime, size | Files under the space's artifacts directory. |
| `knowledge_record` | id, space_id, path, frontmatter, content_hash, status | A catalog. The file is the record. |
| `trigger` | id, job_id, kind, spec, cursor, enabled | Schedules by cron, connector events by poll cursor. |
| `budget_ledger` | id, job_id, attempt_id, action_id, kind, reserved, settled | Reserve before, settle after. |
| `skill` | id, space_id, name, path, frontmatter, enabled | Built-ins have no space. |

## 4. The job state machine

```
queued -> running -> completed | failed | cancelled
             \-> waiting_for_input          (an answer from the owner)
             \-> waiting_for_approval       (a decision on an action)
             \-> waiting_for_event_or_time  (a trigger, a cursor, a timer)
             \-> needs_reconciliation       (an action is unknown)

any wait + an authorized input, approval, event, or timer -> queued
```

Rules, all enforced in the service and all covered by tests:

- One transaction commits the job transition, its domain event, and the enqueue
  of the next wake. Due times and wait predicates live on the job row
  independently of queue retention. A recovery scan every 60 seconds re-enqueues
  jobs whose wake time passed with no live wake and fences attempts whose lease
  expired.
- Starting an attempt increments `lease_epoch`. The attempt's capability token
  carries job, attempt, epoch, revision, scopes, budget, and expiry, signed by the
  service. The broker rejects any action whose epoch is not current. A stale
  worker can still deliver a late receipt for something it already dispatched;
  that receipt is recorded and cannot restart work.
- Cancellation sets `cancelled`, bumps the epoch, then signals the runtime.
  Actions already admitted may still finish, and their disposition is recorded
  honestly. A cancelled job never hides an unknown action: it shows both.
- `completed` requires the attempt outcome to be `completed`, every action to be
  in a terminal state, and the deliverable predicate to hold.
- A final answer with no evidence becomes `waiting_for_input` with the answer
  attached, not `completed`, when the job declared a deliverable.
- Every wake runs one bounded attempt, limited by turns, tokens, and wall time
  from the job budget, and then commits an outcome. Waiting never holds a process.

## 5. The runtime contract

A runtime is a separate process implementing `RuntimeAdapter`:

```ts
interface RuntimeAdapter {
  capabilities(): Promise<{ streaming: boolean; tools: boolean; interrupt: boolean; version: string }>;
  start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal): Promise<AttemptOutcome>;
}
```

An `AttemptBundle` carries the attempt identity and capability token, the job
slice, what changed since the last attempt, a bounded canonical transcript, the
filtered tool catalog, the selected skills, the retrieved knowledge, the
workspace mount, the budget, and the model choice. An `AttemptOutcome` is one of
`completed`, `waiting_for_input`, `waiting_for_approval`,
`waiting_for_event_or_time`, `failed`, or `budget_exhausted`. There is no other
way for an attempt to end.

The v0.1 engine is a pinned, unmodified Hermes release configured thin. Thin
means memory and context files off, built-in toolsets disabled, one trusted
plugin registering the broker's tools and nothing else, command approvals
surfaced over HTTP, an identity under 250 tokens in place of a persona file, and
at most three skills per attempt. Melete consumes the run's event stream once and
persists events before fan-out. An interrupted run is a dead attempt and is never
resumed. A native TypeScript runtime is the documented exit if divergence grows.

The context assembly rule: system prompt = identity (250 tokens) + job slice +
selected skills (at most 3, at most 400 tokens each) + knowledge excerpts (at
most 2,000 tokens) + tool catalog (at most 15 tools). Stable prefix first for
prompt caching, volatile inputs last.

Events reaching the sink are `turn_started`, `text_delta`, `tool_call_proposed`,
`tool_result`, `action_requested`, and `attempt_outcome`, persisted with
`dedup_key = attempt_id:local_seq`. Text deltas are transient; everything else is
durable.

## 6. The broker and the action protocol

The runtime talks to the broker over HTTP on the internal network with its
attempt token. The tool catalog is generated from connector manifests filtered by
the job's scopes.

```
proposed -> (needs_approval -> approved | denied) -> admitted -> dispatched
   -> succeeded | failed | unknown -> (verify) -> succeeded | failed | unresolved
```

1. **Propose.** The runtime posts a kind, a connection, and a payload. The broker
   canonicalises the payload with sorted keys, trimmed strings, and normalised
   email recipients, computes the hash, persists the action, checks scope and
   epoch, and classifies the effect from the manifest as `read`,
   `write_reversible`, `write_external`, or `spend`.
2. **Authorize.** Reads and reversible writes inside the workspace auto-admit
   within budget. External writes and spends require an approval. v0.1 ships no
   standing grants for sends: every external send is approved once, per payload
   hash.
3. **Admit.** One transaction re-checks epoch, policy, and the approval hash,
   reserves budget, and sets `admitted`. It fails closed.
4. **Dispatch.** The connector is called with `idempotency_key = action.id`. A
   timeout or crash after dispatch produces `unknown`.
5. **Reconcile.** A connector-specific `verify` decides: a Message-ID in the Sent
   folder, a CalDAV GET by UID, a content hash, a test destination's ledger. If
   verify cannot decide, the action stays unknown and the job moves to
   `needs_reconciliation` with a question in plain words.
6. **Receipt.** Persisted before the runtime learns the result. A late receipt
   from a fenced attempt is accepted and marked late.

Approval binding: the approval's payload hash and job revision must both still
match at admission. Editing a draft creates a new action.

Budgets: a reservation before every model call and every spend action, settled
afterwards. Concurrent attempts cannot double-spend, because the reservation is a
row-level transaction against the job's remaining allowance.

The model gateway sits under the runtime and is its only route out. It allow-lists
provider hosts, replaces surrogate keys with real ones, records provider, model
requested, model actually served, usage read from response bodies, and latency
per attempt, and enforces per-attempt request and token caps. Fallback happens
only when the job allows it, and the change is recorded.

## 7. Connectors

Each connector ships a manifest of tools with JSON Schema arguments, an effect
class, required scopes, and whether `verify` can decide; plus `execute`, `verify`,
`health`, and its credential requirements. They run inside the Melete process as
trusted code in v0.1. See [CONNECTORS.md](CONNECTORS.md).

## 8. Knowledge and skills

One space is one git repository and one SQLite full-text index:

```
spaces/<space>/
  SCHEMA.md          the taxonomy and lint rules, read before any write
  index.md           a generated catalog, one line per record
  log.md             an append-only chronicle
  knowledge/<slug>.md
  raw/               immutable captured sources
  artifacts/
  skills/            skills added for this space
  .index/fts.sqlite  derived, rebuildable, not committed
  .proposed/         where an agent's writes wait for a person
```

A record's frontmatter carries a stable ULID separate from the filename, the
title, the space, the audience, the type, the status, a confidence, who asserted
it, a source with kind, reference, quote, and hash, the observed time, the
validity window, supersedes and superseded-by pointers, timestamps, tags, links,
and a schema version.

Lint rules are functions with tests: a record's `space` must equal its directory;
every supersedes and superseded-by must resolve; status may only move along legal
edges, and a retracted record never becomes active again.

Retrieval is scoped by the index handle the caller holds, not by an argument the
model supplies. A retracted record leaves the index in the operation that
retracts it and stays gone after a restart.

Agent writes go to `.proposed/`, are validated, and become a diff the owner
applies or discards. Applying is a git commit, which is both the audit record and
the undo.

A skill is a short Markdown file with `name`, `description`, `triggers`, `tools`,
and a token cap of 400. Selection is a deterministic trigger match against the
objective and the latest user message, at most three per attempt. It never calls
a model.

## 9. Security boundary

Enforced and tested: no route out of the runtime, no database credentials or
provider keys in it, non-root and read-only with `/work` as its only mount; every
external effect through the broker with approval bound to the payload hash, epoch
fencing, and reserved budgets; secrets encrypted at rest; approval screens
rendered from records rather than model text; a public-web compartment that
carries no private knowledge; best-effort inbox hygiene.

Documented as weaker than the target: the container shares a kernel with the
host, the broker runs in the same process as the API, connectors are trusted
in-process code, and there is no confidential compute.
[THREAT-MODEL.md](THREAT-MODEL.md) names four attackers and says which are
contained in v0.1 and which are not.

## 10. Events and replay

`GET /jobs/:id/events?after=<seq>` streams Server-Sent Events from the persisted
event table, honouring `Last-Event-ID`. A global `GET /events?after=` drives the
inbox. Clients reconnect and resume. A gap in text deltas is shown as an ellipsis
and never as missing history.

## 11. The conformance suite

Eight scenarios run against a compose stack with the test connector and a
scripted model, so they are deterministic and free:

1. Durable wakes survive a kill between the transition and the enqueue.
2. A stalled attempt cannot act after its lease expires.
3. An unacknowledged send stays unknown and is never re-sent.
4. An approval cannot be spent on different content.
5. A job survives the death of the process running it.
6. The runtime container has no route to anything but the broker.
7. A retracted record leaves retrieval at once and stays gone.
8. The same job produces the same policy outcomes on two providers.

`bun run conformance` lists them and what each asserts.

## 12. Toolchain

Bun workspaces, TypeScript in strict mode, Drizzle with postgres.js, pg-boss,
Hono, Zod schemas shared between the API and every client, Biome for linting and
formatting.
