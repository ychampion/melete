# Capabilities

This matrix maps each capability to the test that establishes it. The engine pin
is Hermes `v2026.9.7`, commit `2237be355906fbe6065ce1815711eee52b2d646e`, with
the hash-checked observer patch (`hermes@v2026.9.7+melete-observers.3`) applied
by the image and process supervisor. An upstream interface becomes a
Melete capability only after it is connected to Melete's authority and tested.

**implemented-and-tested** means the named behaviour has an executed Melete
test in this repository. A row whose scope is narrower — local protocol
fixtures, or a capability the default service does not expose — says so in its
own words.

## Requested capability matrix

| Capability | Status | Evidence |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | implemented-and-tested | The real capability test's `dynamic discovery and broker receipt` stage passes search, load, continuation, one MCP call and a durable receipt. MCP HTTP exchanges use dedicated connections to avoid the pinned Windows Bun pool stalling a request while Hermes streams. |
| MCP connect after session start | implemented-and-tested | The real proof installs through authenticated `POST /connections` during a running attempt, then searches, loads and calls in that attempt. `an operator installs an HTTP MCP connection into the live registry` in [runtime-mcp.test.ts](../apps/melete/test/integration/runtime-mcp.test.ts) covers authenticated setup. [runtime-mcp-revocation.test.ts](../apps/melete/test/integration/runtime-mcp-revocation.test.ts) pauses initialisation, revokes through the lifecycle route, and proves both successful and failed handshakes preserve revocation, dispose any opened worker and deny fresh-attempt calls. Stdio servers run in containers of their own, described in the row for plugins below. |
| MCP disconnect recovery | implemented-and-tested | The real Hermes proof terminates an HTTP session, then observes broker-managed reconnect, a fresh initialisation, one call and a durable receipt. `a terminated HTTP MCP session reconnects through repair before one receipted call` in [mcp-repair.test.ts](../apps/melete/test/integration/mcp-repair.test.ts) covers the same boundary. HTTP and stdio fixtures bound repeated termination to three attempts. A lost acknowledgement stays unknown without replay. |
| Connection auth refresh and reconnect | implemented-and-tested | The real Hermes proof refreshes an expired credential once through the sealed store and receives one action receipt. Revocation makes no call, leaves an open question and commits waiting for input. The expired, revoked and revoked-during-refresh cases in [mcp-repair.test.ts](../apps/melete/test/integration/mcp-repair.test.ts) cover both HTTP and stdio, token rotation and bounded repeated expiry. |
| Lifecycle hooks persisted with dedup and replay | implemented-and-tested | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` in `hooks.test.ts` and the real capability proof exercise session start/end and pre/post tool events, including distinct continuation capture IDs. Python fixtures prove observer failure isolation. Compaction is covered by the row below. |
| Long conversations compacted inside an attempt | implemented-and-tested | `real Hermes compacts inside an attempt through the gateway and records on_compaction` in [compaction-real.test.ts](../apps/melete/test/integration/compaction-real.test.ts) drives the pinned engine past its trigger, and proves the summary call is metered through the model gateway under the attempt, that the next request carries the summary and is smaller, that nothing was refused for size, and that the compaction is a durable observation carrying its own count. Run it with `MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/compaction-real.test.ts --max-concurrency=1 --timeout=180000`. A summary is lossy by nature; every durable fact stays on the ledger. |
| Automatic skill selection in a job | implemented-and-tested | The real capability test's `teammate audience isolation and revocation` stage selects exactly `alpha`, `beta`, `gamma` despite a matching private skill. Actual provider requests exclude the private canary. `principals.test.ts` also tests membership and audience filtering. |
| Correction → candidate → evaluation → promotion → rollback | implemented-and-tested | The real capability test performs correction, bounded proposal, validation and sealed evaluation, private owner canary reuse, explicit activation and rollback. Both evaluation phases require held-out improvement without regression; the scripted provider responds to the actual HTTP prompt. |
| Teammate reuse of an evaluated shared skill | implemented-and-tested | `correction, evaluation, private canary and evaluated teammate reuse` proves A's evaluated procedure reaches B's materially different task only after explicit space promotion. [shared-procedure.test.ts](../apps/melete/test/integration/shared-procedure.test.ts) proves private defaults, principal-bound source access, compiled-body-only delivery, other-space/public refusal, and no delivery or dispatch after revoking B. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The real capability test proves queued work cancellation, refused reads and admission, an old capability's refusal, and personal context without shared skills. `principals.test.ts` additionally covers delivered-context invalidation, gateway fencing and stale capabilities after regrant. |

## Other capabilities with named evidence

| Capability | Status | Evidence and limit |
|---|---|---|
| Brokered MCP over HTTP | implemented-and-tested | `MCP HTTP transport supports JSON and SSE while pinning session and rejecting redirects`, `MCP readOnlyHint cannot bypass approval, and repeated intent dispatches once`, `MCP owner-only tools disappear and reject direct calls in a public compartment`. Configured servers receive protocol messages and admitted arguments only. |
| Default tools on a fresh or upgraded installation | implemented-and-tested | `a fresh installation offers a useful catalog without any hand-made connection` boots the service entry point on an empty database, sets up an owner over HTTP, and finds files, web fetch and artifact publishing in a new attempt's bundle and in the broker's catalog, with a workspace write admitted and publication still `write_external`; the same rows reach Settings marked as kept by the service. `an existing installation gains the default tools once, and a removal stays removed` starts on rows an earlier release left, keeps a hand-made grant undoubled, skips procedure-evaluation spaces, adds speech when a speech-capable provider is configured, and shows a revoked default is not recreated at the next start. `in-cell execution and speech are defaults only where the deployment supports them` in `builtin.test.ts` covers the container and provider conditions. The integration tests are in [default-connections.test.ts](../apps/melete/test/integration/default-connections.test.ts). |
| Installing mail, CalDAV, calendar feed and HTTP MCP connections through the API | implemented-and-tested against local protocol fixtures | [connection-kinds.test.ts](../apps/melete/test/integration/connection-kinds.test.ts) covers each kind: per-kind validation errors, the sealed secret, no secret in any response or in the stored configuration, the typed test result, the connector's tools in a new attempt's bundle and broker catalog, and their absence after revocation. It also covers a failed first test that a later test repairs, a restart that needs no connections file, the connections file as an override, owner and audience authorisation, refusal in a public compartment, a service without a master key, and a calendar feed refused for plain HTTP or a private or loopback destination before anything is stored. `ics-feed.test.ts` covers the feed's address checks on every read, the pinned request and the refused redirect. `a form drawn only from the served descriptors installs every kind` runs the web form's logic against the contract, and `the form draws exactly what a served descriptor carries` renders the Settings form from a descriptor the application has never seen. Mail and CalDAV sign in with an account name and a password or app password. |
| Plugins and stdio MCP servers | implemented-and-tested; the container on a real engine in CI | `GET /plugins` lists a pinned starter catalog (files, fetch, time, GitHub) and `POST /plugins/{id}` adds one with only the values it asks for; the owner's advanced path is an `mcp_stdio` block on `POST /connections`. [mcp-stdio.test.ts](../apps/melete/test/integration/mcp-stdio.test.ts) covers, through the API, broker and registry with a fake launcher: sealed variables that reach only the server, broker admission and approval, a restart that starts nothing until a call, a crash loop that stops restarting until the owner tests, one-tap plugins with plain-word refusals, the move to a release's pinned version, and revocation that stops the server and removes its volume. `mcp-stdio-docker.test.ts` holds the container's restrictions against a recording engine, and `mcp-egress.test.ts` the proxy's grants. Conformance 9 observes uid, capabilities, seccomp, the read-only root, the single volume, no network or only the named destination, and container removal from inside real containers, and fetches a real npm package. Stdio servers run where attempts run in containers (`MELETE_RUNTIME_ADAPTER=docker`), and images are pulled without registry credentials. |
| Browser worker with takeover | implemented-and-tested | `approval binds the exact browser intent and repeated proposals dispatch one effect`, `an unapproved submit has no external effects and its warning identifies the observed destination`, `configured browser connections require an isolated endpoint in production` in `browser-broker.test.ts`; the controller fixtures inject a takeover between locator wait and dispatch and require zero submissions. Local Chromium fixtures establish the controller, and the configuration checks cover the browser image and the combined Compose stack, which no scenario starts. See [the browser worker](browser-worker.md). |
| Signing in to a site through the live view | implemented-and-tested against local Chromium fixtures | `human mode allows the identity-provider redirect and refuses an off-scope host` and `a top-level navigation to an off-scope site is still refused` in `browser-live-worker.test.ts`; `another principal in the same space cannot open, read or drive the live view`, `the live view refuses a request from another address`, `no persisted event contains the typed secret or the identity-provider host` and `a handed-back page is looked at without its contents until automation leaves it` in `browser-live.test.ts` and `browser-live-worker.test.ts`; `a page cannot walk the person to new sites without them acting` in `live-protocol.test.ts`; `a takeover that ends signed in records the site` and `forgetting a site removes its cookies and the profile row` in `browser-sites.test.ts`. The renderer sandbox is `every renderer is under a seccomp filter, in its own user namespace` in `browser-sandbox.test.ts`, which runs in the `browser-sandbox` CI job on a Linux Docker host. |
| In-cell execution with artifact validation | implemented-and-tested | `admission reserves once, claims once, and accepts only its matching late result` and `two concurrent execution settlements produce one durable result` in `execution-admission.test.ts`; artifact checks in `artifacts.test.ts`. The launcher selects an available Python executable on each supported development host. |
| Read composition (`compose`) | implemented-and-tested, not exposed by default | `HTTP composition is discovered, loaded and produces only a compact join with broker evidence` and `a join has separate actions, settled reservations and real receipt handles` in `compose.test.ts` run with the test executor. The default service injects no cell executor, so `HTTP composition is unavailable without the service-owned cell executor` describes the shipped entry point. |
| One pinned engine per attempt | implemented-and-tested | `pins the image, mounts only the job subpath, and isolates its sole broker peer` and `concurrent jobs never share a network or writable Hermes home` in `runtime/docker.test.ts` (Docker CLI faked); the live boundary was probed on a Linux host as scenario 6. The scripted HTTP proof through a real local engine is `wired-assistant.test.ts` (skips itself without `.hermes-venv`). |
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite; `a parked action turns a completion into waiting_for_approval` in the adapter suite. |
| An approved action is carried out by id | implemented-and-tested | `resume_action` sends no payload; the broker replays the stored canonical bytes through ordinary admission. `an approved action is carried out by id, with the stored bytes and the new attempt authority` and `an unknown outcome is never replayed through resume` in `resume-action.test.ts`; `test_resume_sends_only_the_action_id_and_returns_the_receipt` in the plugin suite. The broker behaves this way for whichever caller uses it. |
| Built-in skills reach the attempt that needs them | implemented-and-tested | `a first attempt reads the skill its words call for, and a skill it cannot use takes no place` in [default-connections.test.ts](../apps/melete/test/integration/default-connections.test.ts) boots the service, claims an attempt and finds the research skill in its instructions, a skill that waits on a trigger offered because the wait is the broker's own tool, and three better-matching skills that need an unconnected mailbox leaving the place to the one that can run. `are all tools a connector, a capability or the broker provides` in `skill-tools.test.ts` holds every built-in to tools that exist. The same test records the `tool_trace` notice that names the skills followed. |
| Skill choice on a first-week request set | implemented-and-tested | [selection-eval.ts](../packages/skills/src/selection-eval.ts) holds 59 requests a person makes in their first week, each with the skill that should reach the model or none. Over the tools of an installation with mail, a CalDAV calendar and speech, the built-ins deliver precision 0.98 (48 of 49 picks) and recall 1.00 (48 of 48); `is delivered with high precision and recall` in `selection-eval.test.ts` holds that line. The triggers were written against this set. A second set of 32 requests, written afterwards and never used to change a trigger, measures wording the triggers were not written for: 1 of its 28 expected skills is delivered, and 1 of 3 picks is right. Trigger phrases reach the wording they list; an attempt can still find any skill through `search_tools`, which reads skill descriptions and triggers. Triggers match whole words, so "chase" is not found in "purchase" (`a trigger matches whole words, never the inside of another word`). |
| Core catalog chosen from the job's own words | implemented-and-tested | `the core is chosen from the objective, the latest owner message and the registered trigger`, `relevance to the objective and the latest owner message outranks usage` and `the lifecycle wait and the reaction are pinned when the turn needs them` in `catalog.test.ts`. The ranking is deterministic and involves no model call; these tests measure the ranking itself. |
| Tool search matches any term and explains an empty result | implemented-and-tested | `search matches any term, stems it, and reads identifier segments` and `a search with no match names what can be loaded instead of returning nothing` in `catalog.test.ts`. |
| An ask that proposes nothing is not a completion | implemented-and-tested | The adapter gives one continuation, then settles `waiting_for_input`: `a drafted reply that asks to send gets one continuation, and its proposal parks` and `an ask that still proposes nothing settles waiting for input, never completed` in the adapter suite. After a refusal in the same wake there is no continuation, only the question: `an effect the owner refused in this wake is not asked for again`. The detection is a documented pattern, not a model. |
| A wait names its trigger by id or event name | implemented-and-tested | The attempt input lists the job's enabled triggers (`the job's enabled triggers arrive with their event name and a plain description`); `resolves the event name to the enabled trigger of this job, broker-side` and `an unknown, disabled or ambiguous name is refused, and nothing is recorded` in `runtime-wait.test.ts`. |
| A wait cancelled by a correction is named and restored | implemented-and-tested | `the next attempt is told, and completing without a new wait restores it`, `an event delivered between the correction and the completion wakes the restored wait at once`, `a retryable failure hands the cancelled wait to the retry, and only once it is restored does it stop` and `a replaced wait, a disabled trigger or a lapsed timer is not restored; a future timer is` in `waits.test.ts`. The service restores the wait whether or not the model asks for it again. |
| Constraints rendered as prose, defaults omitted | implemented-and-tested | `constraints read as short prose, and a default is never written down` in the runtime client suite. |
| `react` without a message target | implemented-and-tested | `a reaction with no target lands on the owner's latest message, and only this job's` in `broker.test.ts`, which covers the targeting rule with a fixture reaction. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` now upgrades through production `migrateDatabase`. `production migration upgrades the integration schema with MCP setup and procedure promotion` starts with a real ledger through 0032, verifies all three new columns, and checks a second startup is idempotent. Migrations 0033/0034 have increasing timestamps after 0032. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter and client suites, with recorded HTTP responses. |
| Whole end-to-end capability proof against the real engine | implemented-and-tested | `real Hermes capability chain: discovery, hooks, learning, teammate context and revocation` passes all five stages. It runs pinned Hermes with a scripted HTTP provider and verifies actual provider requests, broker receipts, learning, member context and revocation, so it establishes the chain rather than a model's answers. |

## Authority and observer behaviour

Hooks observe; the broker enforces tools, approvals, budgets and generations.
The plugin registers lifecycle observers and the adapter stores their events in
its ordinary sequence before fan-out. Identical captures are deduplicated;
conflicting reuse of a capture ID fails the stream. Records contain bounded
names, attempt and tool identity, capture time, outcome and a digest of an
argument shape with all values erased. Full payloads, credentials and exception
text are never copied into hook records.

Hermes has 37 hook names at the audited pin. The hash-checked observer patch
adds a real `on_compaction` dispatch after committed compaction progress and a
per-run HTTP queue bridge. The dispatch carries the compaction count, whether
the session id survived it and whether a fallback wrote the summary, and it
also fires when the middle was dropped deterministically instead of summarised,
which it reports as observed rather than as a success. `on_session_end` still
means turn finalisation. The
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
reports them as not connected. A session's space follows its principal, and no
route selects a shared space for it.
[principal-scope.test.ts](../apps/melete/test/integration/principal-scope.test.ts)
exercises each of these surfaces from a second account and from the owner.

Published shared skills use `audience: space:<space-id>`; plain `space` remains
valid within its checked container. Missing skill audiences are private. The
bundle reads only the job's authorised space and at most three selected skills.
It also includes bounded, active published Markdown knowledge with matching
container and audience. Derived memory Markdown is excluded: its authoritative
recall path supplies the current claim revision. The service preserves the
actual reader principal and membership generation in memory scopes. Catalog
enrichment preserves the already authorised selection and evaluated procedures;
it can remove skills whose tools are unavailable. Membership is granted through
the API; there is no invitation interface.

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
canary. The chain is established by running it; the suites above cover each part
separately. The separate Windows
hook fixture is `MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`.

Compaction is proved against the real engine by
`MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/compaction-real.test.ts --max-concurrency=1 --timeout=180000`.

Stdio MCP servers are proved in two parts: the service's side of them, with a
fake launcher, by `mcp-stdio.test.ts`, and the container itself on a real
Docker engine by conformance 9, which CI runs on every pull request:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/repo -w /repo   -e MELETE_CONFORMANCE_DOCKER=1 oven/bun:$(cat .bun-version)   bun test conformance/scenarios/09-stdio-mcp.test.ts --timeout=300000
```

Stdio recovery and credential refresh are tested with explicit fixtures (see
[CONNECTORS](CONNECTORS.md#plugins-and-stdio-mcp-servers)).

Tests use disposable PostgreSQL 17 and pg-boss; on Linux set `DATABASE_URL` to
a server where the test account can create disposable databases, as described
in the root README. A database test that cannot start is reported as skipped,
and `bun run doctor` names the missing prerequisite.
