# Capabilities

This matrix describes the tree at the head of `integration`. The engine pin is
Hermes `v2026.9.7`, commit `2237be355906fbe6065ce1815711eee52b2d646e`, with the
hash-checked observer patch (`hermes@v2026.9.7+melete-observers.2`) applied by the image and
process supervisor. An upstream interface becomes a
Melete capability only after it is connected to Melete's authority and tested.

- **implemented-and-tested**: the named behavior has an executed Melete test on
  this tree.
- **implemented-but-unverified**: code exists, but the required proof has not
  passed on this tree.
- **missing**: an implementation or a necessary connection is absent.

## Requested capability matrix

| Capability | Status | Test or reason |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | implemented-and-tested | The real capability test's `dynamic discovery and broker receipt` stage passes search, load, continuation, one MCP call and a durable receipt. MCP HTTP exchanges use dedicated connections to avoid the pinned Windows Bun pool stalling a request while Hermes streams. |
| MCP connect after session start | implemented-and-tested | The real proof installs through authenticated `POST /connections` during a running attempt, then searches, loads and calls in that attempt. `an operator installs an HTTP MCP connection into the live registry` in [runtime-mcp.test.ts](../apps/melete/test/integration/runtime-mcp.test.ts) covers authenticated setup. [runtime-mcp-revocation.test.ts](../apps/melete/test/integration/runtime-mcp-revocation.test.ts) pauses initialization, revokes through the lifecycle route, and proves both successful and failed handshakes preserve revocation, dispose any opened worker and deny fresh-attempt calls. Service-side stdio launch remains disabled. |
| MCP disconnect recovery | implemented-and-tested | The real Hermes proof terminates an HTTP session, then observes broker-managed reconnect, a fresh initialization, one call and a durable receipt. `a terminated HTTP MCP session reconnects through repair before one receipted call` in [mcp-repair.test.ts](../apps/melete/test/integration/mcp-repair.test.ts) covers the same boundary. HTTP and stdio fixtures bound repeated termination to three attempts. A lost acknowledgement stays unknown without replay. |
| Connection auth refresh and reconnect | implemented-and-tested | The real Hermes proof refreshes an expired credential once through the sealed store and receives one action receipt. Revocation makes no call, leaves an open question and commits waiting for input. The expired, revoked and revoked-during-refresh cases in [mcp-repair.test.ts](../apps/melete/test/integration/mcp-repair.test.ts) cover both HTTP and stdio, token rotation and bounded repeated expiry. |
| Lifecycle hooks persisted with dedup and replay | implemented-and-tested for session and tool hooks | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` in `hooks.test.ts` and the real capability proof exercise session start/end and pre/post tool events, including distinct continuation capture IDs. Python fixtures prove observer failure isolation. Real transcript compaction remains unclaimed. |
| Automatic skill selection in a job | implemented-and-tested | The real capability test's `teammate audience isolation and revocation` stage selects exactly `alpha`, `beta`, `gamma` despite a matching private skill. Actual provider requests exclude the private canary. `principals.test.ts` also tests membership and audience filtering. |
| Correction → candidate → evaluation → promotion → rollback | implemented-and-tested | The real capability test performs correction, bounded proposal, validation and sealed evaluation, private owner canary reuse, explicit activation and rollback. Both evaluation phases require held-out improvement without regression; the scripted provider responds to the actual HTTP prompt. |
| Teammate reuse of an evaluated shared skill | implemented-and-tested | `correction, evaluation, private canary and evaluated teammate reuse` proves A's evaluated procedure reaches B's materially different task only after explicit space promotion. [shared-procedure.test.ts](../apps/melete/test/integration/shared-procedure.test.ts) proves private defaults, principal-bound source access, compiled-body-only delivery, other-space/public refusal, and no delivery or dispatch after revoking B. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The real capability test proves queued work cancellation, refused reads and admission, an old capability's refusal, and personal context without shared skills. `principals.test.ts` additionally covers delivered-context invalidation, gateway fencing and stale capabilities after regrant. |

## Other capabilities with named evidence

| Capability | Status | Evidence and limit |
|---|---|---|
| Brokered MCP over HTTP | implemented-and-tested | `MCP HTTP transport supports JSON and SSE while pinning session and rejecting redirects`, `MCP readOnlyHint cannot bypass approval, and repeated intent dispatches once`, `MCP owner-only tools disappear and reject direct calls in a public compartment`. Configured servers receive protocol messages and admitted arguments only. |
| Browser worker with takeover | implemented-and-tested | `approval binds the exact browser intent and repeated proposals dispatch one effect`, `an unapproved submit has no external effects and its warning identifies the observed destination`, `configured browser connections require an isolated endpoint in production` in `browser-broker.test.ts`; the controller fixtures inject a takeover between locator wait and dispatch and require zero submissions. Local Chromium fixtures; the Linux image and combined Compose stack were not run on the development host. See [the browser worker](browser-worker.md). |
| In-cell execution with artifact validation | implemented-and-tested | `admission reserves once, claims once, and accepts only its matching late result` and `two concurrent execution settlements produce one durable result` in `execution-admission.test.ts`; artifact checks in `artifacts.test.ts`. The launcher selects an available Python executable on each supported development host. |
| Read composition (`compose`) | implemented-and-tested, not exposed by default | `HTTP composition is discovered, loaded and produces only a compact join with broker evidence` and `a join has separate actions, settled reservations and real receipt handles` in `compose.test.ts` run with the test executor. The default service injects no cell executor, so `HTTP composition is unavailable without the service-owned cell executor` describes the shipped entry point. |
| One pinned engine per attempt | implemented-and-tested | `pins the image, mounts only the job subpath, and isolates its sole broker peer` and `concurrent jobs never share a network or writable Hermes home` in `runtime/docker.test.ts` (Docker CLI faked); the live boundary was probed on a Linux host as scenario 6. The scripted HTTP proof through a real local engine is `wired-assistant.test.ts` (skips itself without `.hermes-venv`). |
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite; `a parked action turns a completion into waiting_for_approval` in the adapter suite. |
| An approved action is carried out by id | implemented-and-tested | `resume_action` sends no payload; the broker replays the stored canonical bytes through ordinary admission. `an approved action is carried out by id, with the stored bytes and the new attempt authority` and `an unknown outcome is never replayed through resume` in `resume-action.test.ts`; `test_resume_sends_only_the_action_id_and_returns_the_receipt` in the plugin suite. Whether a real model calls it is not claimed. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` now upgrades through production `migrateDatabase`. `production migration upgrades the integration schema with MCP setup and procedure promotion` starts with a real ledger through 0032, verifies all three new columns, and checks a second startup is idempotent. Migrations 0033/0034 have increasing timestamps after 0032. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter and client suites, with recorded HTTP responses. |
| Whole end-to-end capability proof against the real engine | implemented-and-tested | `real Hermes capability chain: discovery, hooks, learning, teammate context and revocation` passes all five stages with 85 assertions. It runs pinned Hermes with a scripted HTTP provider and verifies actual provider requests, broker receipts, learning, member context and revocation. It does not evaluate real-model answer quality. |

## Authority and observer behavior

Hooks observe; the broker enforces tools, approvals, budgets and generations.
The plugin registers lifecycle observers and the adapter stores their events in
its ordinary sequence before fan-out. Identical captures are deduplicated;
conflicting reuse of a capture ID fails the stream. Records contain bounded
names, attempt and tool identity, capture time, outcome and a digest of an
argument shape with all values erased. Full payloads, credentials and exception
text are never copied into hook records.

Hermes has 37 hook names at the audited pin. The hash-checked observer patch
adds a real `on_compaction` dispatch after committed compaction progress and a
per-run HTTP queue bridge. `on_session_end` still means turn finalization. The
source audit, MCP retry analysis and reuse, patch or replace decisions are in
[note 0021](../.agents/notes/0021-hermes-capability-audit.md).

The installation keeps its singleton setup owner. Additional accounts live in
`principal`; a session, job and new capability name the authenticated
principal. Personal spaces are private. Shared-space membership has a retained,
monotonic generation. Revocation advances the space policy generation, clears
cached delivered memory, invalidates prepared outputs, fences active attempts
and cancels the revoked member's queued and waiting work. A regrant gets a new
generation. Checks occur at API reads, bundle construction, broker admission
and model-budget reservation.

Jobs and their timelines remain private to the principal who owns the job,
including inside a shared space. Membership shares published skills and
knowledge; it does not expose another principal's private attempt context.

A session speaks for one space, and that space is derived from the authenticated
principal on every request: the principal's own personal space, or a space the
session stored that the principal is still a member of under the membership
generation it was stored with. A revocation ends a stored selection and a later
regrant does not revive it; whatever fails falls back to the principal's own
personal space, never to another account's. An account without a personal space
receives exactly one on first use. Conversations, plans, routines, permissions,
drafts, receipts, undo, search, the event stream, artifacts, reactions and
browser takeover or handback are additionally checked against the job's
principal. The profile, tasks, saved rules, agents and connection reads belong
to the space, so a shared space offers them to its owner only. Saved details are
stored under the setup owner's memory catalog; another account's personal space
reports them as not connected. No route selects a shared space for a session
yet. [principal-scope.test.ts](../apps/melete/test/integration/principal-scope.test.ts)
exercises each of these surfaces from a second account and from the owner.

Published shared skills use `audience: space:<space-id>`; plain `space` remains
valid within its checked container. Missing skill audiences are private. The
bundle reads only the job's authorized space and at most three selected skills.
It also includes bounded, active published Markdown knowledge with matching
container and audience. Derived memory Markdown is excluded: its authoritative
recall path supplies the current claim revision. The service preserves the
actual reader principal and membership generation in memory scopes. Catalog
enrichment preserves the already authorized selection and evaluated procedures;
it can remove skills whose tools are unavailable. An invitation interface is
outside v0.1.

Evaluated procedure activation accepts `scope: private | space`, defaulting to
`private`. Its promotion record also stores the authenticated principal; callers
cannot nominate another principal. Canary delivery stays private. Explicit
space activation requires the source space's owner, a shared space, the sealed
evaluation gate and a completed private canary. Task applicability remains a
separate evaluated object and grants no access by itself. A current member can
receive only the verified compiled procedure body for a matching task, model and
runtime in that space. Episodes, corrections, evaluations and job timelines stay
private. Selection rechecks membership under the existing revocation lock;
revocation cancels queued reuse and fences already delivered context. Rollback
removes subsequent procedure delivery.

## Verification

```sh
bun test apps/melete/test/integration/principals.test.ts apps/melete/test/integration/principal-scope.test.ts apps/melete/test/integration/shared-procedure.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2
bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2
bun test apps/melete/test/integration/catalog.test.ts apps/melete/test/integration/mcp.test.ts apps/melete/test/integration/runtime-mcp.test.ts apps/melete/test/integration/runtime-mcp-revocation.test.ts apps/melete/test/integration/mcp-repair.test.ts --max-concurrency=2
bun test apps/melete/test/integration/learning-three-act.test.ts apps/melete/test/integration/learning-evaluation.test.ts --max-concurrency=1
bun run test:plugin
bun run lint
bun run typecheck
bun run compose:check
```

The combined real-engine proof runs with the pinned local engine prepared as
the root README describes:

```sh
MELETE_CAPABILITY_PROOF=1 bun test apps/melete/test/integration/capability-proof.test.ts --max-concurrency=1
```

It uses ports 3160 and 3162, a local HTTP MCP fixture, PostgreSQL, pg-boss and a
scripted provider. Validation and sealed evaluation use separate held-out
tasks and memory regression checks; promotion requires improvement without
regression and a completed private
canary. Skipping the opt-in test is not end-to-end proof. The separate Windows
hook fixture is `MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`.

The two unclaimed engine capabilities are **real transcript compaction** and
**production stdio launch**. The observer patch has a compaction dispatch, but
the executed proof does not force committed compaction. Stdio recovery and
refresh are tested with explicit fixtures; the service refuses to launch an
MCP child under its own OS identity until an isolated launcher exists.

Tests use disposable PostgreSQL 17 and pg-boss; on Linux set `DATABASE_URL` to
a server where the test account can create disposable databases, as described
in the root README. A skipped database test is not a pass. The accepted contract
additions are recorded in the
[contract note](../.agents/notes/proposed/2026-09-12-w14-contract-additions.md).
