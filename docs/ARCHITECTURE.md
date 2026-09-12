# Architecture

This is the implementation and evidence map for code baseline
`9484023cabd32b786cb4d336dec818f441cd0cc1`. A schema, a configuration check and
a running deployment are different evidence. Deployment behavior is **not
claimed** unless a named test below exercises it.

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

`deploy/docker-compose.yml` declares these networks:

| Service | Network | Relevant configuration |
| --- | --- | --- |
| Postgres | internal | Unpublished port, persistent database volume |
| Melete | edge, internal | Public API and internal effect/gateway listener in one process |
| Runtime | internal | Non-root, read-only root, dropped capabilities, process/memory limits |
| Web | edge | Optional web profile |

The internal network declares `internal: true`, intended to remove external
routing. The runtime egress probes in scenario 6 are **written, not run**.
The static checker reads YAML; it does not open sockets inside a container.
Postgres and the runtime share this network, so a boundary allowing only broker
reachability is **not claimed**. The probe expecting Postgres DNS to fail is
inconsistent with that declaration.

The runtime has writable `/work` and `/var/lib/hermes` volumes and a `/tmp`
tmpfs. The Hermes home supports run-idempotency persistence; it is not correct
to describe `/work` as the only writable path. Container behavior is **written,
not run**; configuration is checked by `checkCompose` in
`deploy/scripts/compose-check.ts` and its tests.

## 3. Service startup and entities

`apps/melete/src/index.ts` mounts authentication, knowledge routes and health;
with dependencies it also mounts jobs, replies, operations, policy, questions,
attention, triggers, approvals and events. The executable entry point starts
the effect boundary when a database handle exists.

With Postgres, `bootstrap` migrates and starts pg-boss but requires a supplied
`RuntimeAdapter` or explicit `MELETE_RUNTIME_ADAPTER=stub`, plus a capability
key. It does not construct the Hermes adapter from the runtime URL. Default
Compose startup as a complete assistant is **not claimed**.

Memory routes require `createApp({ memory: ... })`; the default bootstrap does
not supply this dependency or start the memory worker. The effect boundary does
install `createMemoryTrustResolver`, so the broker-memory origin seam is no
longer a missing stub (`an address read off a page is refused as
untrusted_recipient_origin` in `broker-seam-tests.ts`).

Schema existence is checked by `every entity in the contract has a table`.
Authentication tests include `racing setup requests atomically create one owner,
space, and session`, `a second service instance recognizes the persisted
session`, and `all other routes require a valid cookie while health stays public`.

The legacy knowledge file-view routes still select a space using
`x-melete-space` after session authentication. Their fixture test `asking for a
different space than the session holds is refused` supplies that header; it does
not prove a membership-derived scope. A complete trusted-scope bridge for those
routes is **not claimed**. The optional memory router has separate scope checks.

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

These tests use scripted runtimes; host reboot and installed Hermes recovery
are **not claimed**.

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

The contract has context-budget constants, including 15 tools, but
`Broker.catalog` returns all eligible tools without that truncation. A universal
15-tool cap is **not claimed**. Transcript bounds are implemented as 100 messages
and 32,000 serialized characters in `jobs/bundle.ts`, tested by `bounds escaped
serialized content and marks abbreviation without mutating history`.
The memory adapter separately bounds recall; end-to-end model token accounting
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

The gateway tests use fake transports/providers, including local TLS fixtures.
Real-provider compatibility, automatic fallback correctness and an exportable
tamper-evident action ledger are **not claimed**.

## 7. Connectors

Files, web, email, calendar and the test destination have implementations and
fixture tests; [CONNECTORS](CONNECTORS.md) maps each to evidence. They run as
trusted code in the service process. General live-account compatibility is
**not claimed**. Knowledge routes and memory services are separate from the
configured connector registry.

A connector that fails says what kind of failure it was: a typed
`ConnectorFault` with a class, a `may_have_committed` flag, and an optional
`retry_after`. The broker repairs the cause rather than retrying blindly. It
retries what did not leave, parks what was rate-limited, refreshes a stale token
once, stops dead on a revoked grant, re-discovers a drifted schema and proposes
a mapping with a test, takes one equivalent authorized route for the same
operation, and reconciles an uncertain outcome through `verify`. A repair may
change a selector, a route or a field's name; it may never change a recipient,
an amount, a resource, or what the person asked for, and the action's payload
hash and approval are the same on every attempt. `completed` is the only
disposition that means the effect happened; every other one is a safe stop,
counted apart and never summed with a completion. Connectors may also offer
`describe`, `refreshCredential` and `routes`; one that offers none simply stops.
See `.agents/notes/0015-typed-repair.md`.

## 8. Memory and skills

Postgres is memory authority. Recall checks current revision, audience, source
and suppression state; the Markdown tree is an inspection/edit view.
`recall supplements a lagging lexical index and dates historical revisions`
and `source and space revocation invalidate delivered context and block stale
serving` test the authority path.

Skills use deterministic trigger matching, with at most three selected and a
400-token frontmatter cap (`returns nothing when nothing matches`,
`respects a lower maximum`, and `refuses a skill that is longer than the
contract allows` in `packages/contracts/src/skills.test.ts`). These are
selection/schema properties; malicious-skill harmlessness is **not claimed**.

## 9. Security limits

The [threat model](THREAT-MODEL.md) separates broker rejection tests from
container probes that are **written, not run**. A shared kernel, trusted
connectors and a broker/API process holding secrets remain trust boundaries.
Virtual-machine isolation and resistance to a compromised host are **not claimed**.

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
in a filtered stream. See [CLIENT](CLIENT.md).

## 11. Conformance

Scenarios 1–5 execute on isolated Postgres with scripted runtimes and test
effects. Scenario 6 (container egress), 7 (whole-stack retraction/restart), and 8
(two-provider policy equivalence) are **written, not run**: 14 todo assertions.
Memory has a separate runner with ten executable scenarios and one procedure
transfer todo, **written, not run**. Neither runner proves real-model quality.

## 12. Verification

Run from the repository root:

```bash
bun run compose:check
bun test --max-concurrency=2 --timeout=15000 conformance/scenarios
```

The first command checks configuration only; the second executes fixture
scenarios and prints the todos. See the documentation lane's pull request (#17) for run outcomes.
