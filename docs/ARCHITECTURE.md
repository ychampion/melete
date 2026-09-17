# Architecture

This is the implementation and evidence map for the tree at the head of
`integration`. A schema, a configuration check and a running deployment are
different evidence. Deployment behavior is **not claimed** unless a named test
below exercises it, and the Linux deployment evidence is what it says: one
tested Docker host configuration, recorded in
[note 0020](../.agents/notes/0020-deployment-evidence.md).

## 1. Authority and process boundaries

Postgres holds jobs, attempts, actions, approvals, events and authoritative
memory. Attempts are replaceable; an action with an unknown outcome is not
blindly sent again. These are tested fixture properties in conformance 1–5,
listed in [the conformance README](../conformance/README.md).

Memory uses Postgres evidence, revisions and restrictions; Markdown/git and
SQLite are views and file-tool infrastructure. The test `Markdown round trips
support, preserves local edits, and owner edits become protected revisions`
covers that distinction. See [MEMORY](MEMORY.md).

## 2. Declared topology

`deploy/docker-compose.yml` declares three networks and five kinds of
container:

| Service | Networks | Relevant configuration |
| --- | --- | --- |
| Postgres | `database` (`internal: true`) | Unpublished port, persistent database volume |
| Melete | `edge`, `database`, `internal` | Owner API bound only to its `edge` address (port 8787); broker and model gateway on port 8788 for the runtime network; holds the Docker socket to supervise attempts |
| Warm runtime cell | `internal` (`internal: true`, isolated bridge gateway) | Non-root UID 10001, read-only root, dropped capabilities, no-new-privileges, process and memory limits, only the `_probe` work subpath; no valid job capability |
| Per-attempt runtime cells | `internal` | Started and retired by the service; each mounts only its job's `work/<job>` subpath, a named Hermes home and a size-limited `/tmp` |
| Web | `edge` | Serves the web app and proxies `/api` to Melete on the browser's own origin |

The browser worker, when the `docker-compose.browser.yml` override is added,
joins its own `browser-control` and `browser-egress` networks and none of the
above; see [the browser worker](browser-worker.md).

The static checker `checkCompose` in `deploy/scripts/compose-check.ts` reads
this YAML (26 checks, `passes every boundary check` and its mutation tests);
`bun run compose:check` adds two checks that each installing Dockerfile copies
every workspace manifest, and one that the runtime Dockerfile's
`MELETE_PLUGIN_SHA` still describes the plugin directory the image hashes at
build time, 29 in all. It does not open sockets inside a
container. Live behavior was established by
scenario 6 on a Linux Docker host: from a claimed cell and the warm cell, the
internet, the host metadata address, a live host listener, Postgres (by DNS and
by container IP), the web service and the owner control plane were unreachable,
and the broker with its gateway was the only reachable peer. The
[threat model](THREAT-MODEL.md) records that evidence and what would falsify it.

## 3. Service startup and entities

`apps/melete/src/index.ts` mounts authentication, artifacts, principals and
spaces, and health; with Postgres and a job service it also mounts jobs,
learning episodes, proposals and procedures, replies, operations, policy,
attention, reactions, questions, repairs, triggers, approvals, the experience
routes, events, the memory routes and, when a browser worker is configured, the
browser session controls. The knowledge file-view routes are mounted with a
space catalog confined to the spaces directory.

With Postgres, `bootstrap` migrates, starts pg-boss, starts memory behind the
restriction-journal restore gate (the `docker` adapter starts the deployment
memory the same way), and then chooses the runtime. With the default
`MELETE_RUNTIME_ADAPTER=hermes` it starts the effect boundary and a supervisor
that launches one pinned Hermes engine per attempt (`MELETE_RUNTIME_SUPERVISOR=process`
for local development with the current user's OS access, `docker` for a
container per attempt). `MELETE_RUNTIME_ADAPTER=docker` is the Compose path
verified on a Linux host: the service supervises one container per attempt
through the Docker socket (`pins the image, mounts only the job subpath, and
isolates its sole broker peer`). `stub` is an explicit scripted choice and
`external` expects an injected `RuntimeAdapter`. The scripted HTTP proof
`wired-assistant.test.ts` creates a job, corrects a claim and checks the
requests delivered through a real local Hermes to a scripted provider.

Memory routes and the memory worker start with every Postgres-backed bootstrap;
an injected runtime receives context recording only when the caller supplies
the `memory` dependency. The effect boundary installs
`createMemoryTrustResolver`, so the broker-memory origin seam is wired (`an
address read off a page is refused as untrusted_recipient_origin` in
`broker-seam-tests.ts`).

Schema existence is checked by `every entity in the contract has a table`.
Authentication tests include `racing setup requests atomically create one owner,
space, and session`, `a second service instance recognizes the persisted
session`, and `all other routes require a valid cookie while health stays public`.

The knowledge file-view routes select a space from the `x-melete-space` header
or a query parameter after session authentication, with a single-space
fallback, then ask the service whether the authenticated principal may use that
space; non-owners read only, and skills and records are filtered by audience.
The fixture test `asking for a different space than the session holds is
refused` supplies the header; `a space id that names nothing is a 404, not an
empty result` covers the catalog. The memory routes derive scope from the
principal's verified membership and never from the request body.

## 4. Durable jobs

The closed job states are queued, running, completed, failed, cancelled,
waiting for input, waiting for approval, waiting for event/time, and needing
reconciliation. `packages/contracts/src` defines the transitions; the service
uses Postgres transactions and pg-boss wakes.

| Property | Named evidence |
| --- | --- |
| Recover a lost wake without duplicate attempts | Conformance 1: `Due work survives a kill between the transition and the enqueue` |
| Fence a stale attempt and retain truthful late receipts | Conformance 2: `A stalled attempt cannot act after its lease expires` |
| Check completion against stored deliverables | `artifact completion requires a referenced record matching the declared glob`; `message-sent completion checks connection and the matching stored receipt` |
| Bound replay context without forgetting completed tool identity | `fails closed when completed tool identities exceed either context cap` |
| Recover from runtime death | Conformance 5: `A job survives the death of the process running it` |
| Recover across a whole-stack restart | The Linux vertical check restarted the stack under an active job and under a parked approval; each recovered with one succeeded action and one receipt (note 0020) |
| Repair a failing connector without changing the effect | `a transient failure before dispatch retries the same bytes`, `a rate limit parks the job and releases the worker`, `an expired credential is refreshed through the store, once`, `a revocation during backoff fences the retry before it is sent`, `schema drift is repaired through a candidate that passed its test` in `repair.test.ts` |

An action comes to rest at one repair disposition: `completed` is the only one
that means the effect happened; `parked_until_retry`, `needs_reconciliation`,
`needs_reconnect`, `needs_input` and `repair_exhausted` are safe stops, counted
apart (`completions and safe stops are counted apart, never summed`).
`GET /jobs/{id}/repairs` reports the trace, counters and candidates.

A correction to a claim a job relied on requeues that job even while it holds
an event or timer wait, and that wait has not fired. The next attempt's input
says so in one section (`a wait cancelled before it fired is named, with no
wait in force now`), and a notice row records the cancelled wait against that
attempt. If the attempt completes without choosing another wait, the service
restores the cancelled one once, and only while it can still fire: the trigger
is still enabled on this job or the timer is still ahead, and no action is
pending. A wait the attempt chose itself stands, a retryable failure hands the
cancelled wait to the retry, and an event delivered in between wakes the
restored wait at once (`the next attempt is told, and completing without a new
wait restores it`, `an event delivered between the correction and the
completion wakes the restored wait at once`, `a replaced wait, a disabled
trigger or a lapsed timer is not restored; a future timer is` in
`waits.test.ts`).

Host reboot recovery is **not claimed**; the restart evidence above is a
Compose restart on one Linux host.

## 5. Runtime and context

The adapter package pins Hermes `v2026.9.7` and uses its HTTP runs API.
Its client/adapter tests include `names the exact release the image is built
from`, `the start carries the attempt id as its idempotency key`, and
`refuses an engine whose run idempotency is not durable`.

Broker-tool approvals use Melete's park-and-resume protocol, not Hermes tool
approvals (`a parked action turns a completion into waiting_for_approval`).
The adapter denies unexpected shell approvals (`a shell-command approval is
denied, never allowed for the session`). An interrupted stream is not resumed
(`an interrupted run fails retryably and says history is missing`).

A run whose reply asks the owner for a go-ahead on an external effect it never
proposed is not a completion. `runtime-hermes/src/proposal.ts` decides this
without a model: the catalog must offer a `write_external` or `spend` tool the
attempt did not call, and a sentence must ask permission (a small documented
pattern) while naming that tool's verb or following a draft from the same
namespace. Such an attempt gets exactly one continuation telling it to call the
tool, since the broker asks the owner, or to say it cannot; if it still
proposes nothing it settles `waiting_for_input`, and a parked action still wins
(`a drafted reply that asks to send gets one continuation, and its proposal
parks`, `an ask that still proposes nothing settles waiting for input, never
completed`, `a finished send, a closing offer or a plain question completes in
one run`).

The attempt input renders the job's constraints as one short line each and
writes no default down: a declared deliverable says what done means, a domain
list says where web fetches may go, public research says so, notes appear as
written, and any other key is shown as `key: value`. A job whose constraints are
all defaults has no constraints section (`constraints read as short prose, and a
default is never written down`).

The identity file (`packages/skills/builtin/identity.md`, 250 estimated tokens
at most) states the reply rules as text: a social message gets one short
sentence or a reaction, no note that nothing is pending, no closing offer, a
source cited only when asked or disputed, and a later wake reporting only what
changed (`keeps a social reply short, drops disclaimers and offers, and reports
only what changed` in `conformance/style`). The knowledge section shows each
record's path and provenance and tells the model to name a path only when asked
or disputed. These are instructions; whether a given model follows them is
**not claimed** here.

The broker serves a token-budgeted core catalog (750 estimated tokens of
schemas, `core uses a serialized token budget, never a count cap, with stable
ordering`) plus `search_tools` and `load_tool`; the contract's 15-tool constant
is not an enforced cap, and a universal cap is **not claimed**. The core is
chosen per attempt from durable rows, with no model call: candidates are ranked
by lexical overlap between the job's objective plus its latest owner message and
each tool's name segments, description and examples, then by the local core
flag, usage and name (`relevance to the objective and the latest owner message
outranks usage`). `job.wait` leads when the job has an enabled trigger and
`react` leads when the attempt answers a person directly: a chat, a first
attempt, or a wake carrying a new owner message (`the lifecycle wait and the
reaction are pinned when the turn needs them`). `react` asks for the glyph
alone: its message target is optional, because no attempt input shows an event
seq, and without one the broker reacts to the owner's latest message on the
attempt's own job (`a reaction with no target lands on the owner's latest
message, and only this job's`). A reversible tool is offered
only beside an external-write sibling from the same connection and namespace,
or not at all (`a reversible draft is never shown without its external-write
sibling`). An MCP tool enters the core only when the job's words match it (`an
MCP tool enters the core by relevance and never by default`). Every healthy
tool left outside is named on `load_tool` with a gist of at most eight words,
inside a separate 250-token allowance (`every unloaded tool is named in a
bounded index on load_tool`). Whether this ranking improves a real model's tool
choice is **not claimed** here; it is measured by the evaluation campaign. A schema loaded on demand
is persisted for the attempt (`loaded schema persists across service restart
without leaking to another attempt`); because the pinned engine snapshots its
toolset when a run starts, the adapter ends the run and starts a continuation
with the same attempt authority. Transcript bounds are 100 messages and 32,000
serialized characters in `jobs/bundle.ts`, tested by `bounds escaped serialized
content and marks abbreviation without mutating history`. The memory adapter
separately bounds recall. `budget.max_output_tokens` remains the cumulative
output ceiling (8,000 by default); the optional `max_input_tokens` bounds each
request's context and defaults to the pinned model's context window minus the
output ceiling. An oversized assembled prompt is refused with
`input_context_exceeded` before the engine launches, and the gateway checks the
final request again before provider admission. Provider-side token accounting
for every prompt component is **not claimed**.

## 6. Broker and gateway

The broker canonicalizes payloads, records actions, rechecks scope/epoch/revision
and approval, reserves budget, dispatches, and records receipts or uncertainty.

| Boundary | Named evidence |
| --- | --- |
| Approval binds content | Conformance 4: `An approval cannot be spent on different content` |
| Unknown dispatch is not repeated | `the action is never dispatched a second time, including after broker restart` |
| Logical effect identity crosses attempts | `the database itself refuses a second action for one intent key` |
| Memory origin reaches admission | `an address read off a page is refused as untrusted_recipient_origin` |
| Gateway meters before forwarding | `reserves before injecting credentials and strips capability and caller headers` |
| Reject stale/budget-exhausted calls | `stale epoch and concurrent budget exhaustion stop requests before transport` |
| Provider-specific request handling | `Astra requires Responses and Anthropic drops sampling controls without rewriting history` |
| A cell capability cannot approve | Scenario 8 on the Linux stack: a valid cell capability read the catalog (200) but could not approve (401); an altered owner approval hash was refused (409) |
| An approved action is resumed by id, never retyped | `an approved action is carried out by id, with the stored bytes and the new attempt authority`, `resume refuses whatever the owner has not approved for this job and revision`, `an unknown outcome is never replayed through resume` in `resume-action.test.ts` |

After an approval, the next attempt's input names the approved tool and its
stored canonical payload, and the catalog offers `resume_action{action_id}`
first while an unexpired approval for the current revision waits. The call
carries no payload: the broker admits and dispatches the stored bytes through
the same admission a byte-identical proposal reaches, under the new attempt's
capability, so the payload-hash and revision binding, the budget reservation
and the epoch fence are unchanged. Any other status reads back its durable
disposition, which is why an unknown outcome is not sent again. A byte-identical
re-proposal still dispatches (`a byte-identical proposal after approval still
dispatches without resume`); an in-cell intent is not replayed this way.

The gateway tests use fake transports/providers, including local TLS fixtures.
Real-provider compatibility, automatic fallback correctness and an exportable
tamper-evident action ledger are **not claimed**.

## 7. Connectors

Files, web, email, calendar, the test destination, in-cell execution,
artifacts, speech generation, operator-configured MCP servers over HTTP and the
browser worker have implementations and fixture tests; [CONNECTORS](CONNECTORS.md)
maps each to evidence. They run as trusted code in the service process, except
the browser worker, which is a separate process outside the runtime cell.
General live-account compatibility is **not claimed**. Knowledge routes and
memory services are separate from the configured connector registry.

A connector that fails says what kind of failure it was: a typed
`ConnectorFault` with a class, a `may_have_committed` flag, and an optional
`retry_after`. The broker repairs the cause rather than retrying blindly. It
retries what did not leave, parks what was rate-limited, refreshes a stale token
once, stops dead on a revoked grant, re-discovers a drifted schema and proposes
a mapping with a test, takes one equivalent authorized route for the same
operation, and reconciles an uncertain outcome through `verify`. A repair may
change a selector, a route or a field's name; it may never change a recipient,
an amount, a resource, or what the person asked for, and the action's payload
hash and approval are the same on every attempt. Connectors may also offer
`describe`, `refreshCredential` and `routes`; one that offers none simply stops.
See `.agents/notes/0015-typed-repair.md`.

## 8. Memory and skills

Postgres is memory authority. Recall checks current revision, audience, source
and suppression state; the Markdown tree is an inspection/edit view.
`recall supplements a lagging lexical index and dates historical revisions`
and `source and space revocation invalidate delivered context and block stale
serving` test the authority path.

Initial skill selection is deterministic, with at most three selected, a
400-token frontmatter cap, and membership and audience filtering (`returns
nothing when nothing matches`, `respects a lower maximum`, `refuses a skill
that is longer than the contract allows` in `packages/contracts/src/skills.test.ts`;
`member bundles select at most three shared skills; revocation fences work,
replay, knowledge and old capabilities` in `principals.test.ts`). On-demand
discovery can load a skill the model asks for, filtered by the job's scopes.
An evaluated procedure from the [learning loop](LEARNING.md) joins the bundle
first, private to the space owner. These are selection and schema properties;
malicious-skill harmlessness is **not claimed**.

## 9. Security limits

The [threat model](THREAT-MODEL.md) separates broker rejection tests from
the container probes that ran on a Linux Docker host. A shared kernel, trusted
connectors and a broker/API process holding secrets remain trust boundaries,
and the service holds the Docker socket, which is host-root equivalent.
Virtual-machine isolation and resistance to a compromised host are
**not claimed**.

## 10. Events and client replay

The service exposes persisted JSON/SSE event reads with cursor validation and
Last-Event-ID precedence. Tests include `Last-Event-ID overrides the URL cursor
and unknown jobs fail before streaming`, `duplicate event delivery emits one
stored row and no duplicate frame`, and `a gap marker names its persisted
notice and rollback holes never invent gaps`.

The current attempt runner persists incoming text deltas along with other
events, despite the contract helper's non-durable label. Conformance 5 checks
those stored rows under `the gap in the event stream is recorded, and history
is never shown as missing`. Text never received before a process dies cannot
be recovered from that store.

The client helper still reports a sequence skip as a gap (`reports a skipped
sequence as a gap with both ends`); that is not proof of missing durable rows
in a filtered stream. The experience routes project the same events into the
items the web app draws. See [CLIENT](CLIENT.md).

## 11. Conformance

Scenarios 1–5 execute on isolated Postgres with scripted runtimes and test
effects. Scenarios 6 (container egress and control-plane isolation), 7
(whole-stack retraction and restart) and 8 (policy equivalence across
providers) run against the Compose stack when `MELETE_CONFORMANCE_COMPOSE=1`
is set and are reported as deferred otherwise. On the Linux Docker host the
whole suite passed 44 tests and skipped one: the second-provider comparison,
which needs a credential. Memory has a separate runner with ten executable
scenarios across seven families and one recorded todo (procedure transfer,
whose promotion path is exercised by the learning tests instead). Neither
runner proves real-model quality.

## 12. Verification

Run from the repository root:

```bash
bun run compose:check
bun run conformance
```

The first command checks configuration only; the second lists the scenarios,
runs 1–5 on disposable Postgres, and says which are deferred. The README
describes the Compose opt-in for 6–8.

## 13. Further maps

[CAPABILITIES](CAPABILITIES.md) is the capability matrix against the pinned
engine; [LEARNING](LEARNING.md) the correction-to-procedure loop;
[the browser worker](browser-worker.md) the out-of-cell browser;
[DEPLOYMENT](DEPLOYMENT.md) operations on the Linux stack;
[ENGINEERING](ENGINEERING.md) the seven provable properties.
