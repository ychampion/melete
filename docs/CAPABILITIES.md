# Capabilities

This matrix describes the tree at the head of `integration`. The engine pin is
Hermes `v2026.9.7`, commit `2237be355906fbe6065ce1815711eee52b2d646e`, with the
reviewed observer patch applied at image build. An upstream interface becomes a
Melete capability only after it is connected to Melete's authority and tested.

- **implemented-and-tested**: the named behavior has an executed Melete test on
  this tree.
- **implemented-but-unverified**: code exists, but the required proof has not
  passed on this tree.
- **missing**: an implementation or a necessary connection is absent.

## Requested capability matrix

| Capability | Status | Test or reason |
|---|---|---|
| Dynamic tool discovery through `search_tools` / `load_tool` | implemented-but-unverified | With scripted runtimes the whole path is tested: `scripted job discovers, loads and calls a tool absent from initial context through the broker`, `loaded schema persists across service restart without leaking to another attempt`, and `discovery and invocation recheck persisted scopes, space, revision and expiry` in `apps/melete/test/integration/catalog.test.ts`. The real-engine proof (search, load, a continuation with the loaded schema, then one brokered call with a receipt) has not passed on this tree; it is pending in a separate pass. |
| MCP connect after session start | missing | MCP servers are read from the owner-controlled connections file at service startup and registered against persisted connections; there is no route that installs a server while a job is running. Service-side stdio launch is refused (`production stdio cannot launch under the service OS identity`). |
| MCP disconnect recovery | missing | The MCP connector raises typed faults and a lost acknowledgement stays `unknown` (`MCP acknowledgement loss stays unknown across repeated intent and never replays`), but it offers no reconnect callback to the repair policy, so a dropped session resolves through reconciliation rather than by reconnecting and continuing the job. |
| Connection auth refresh and reconnect | missing | The repair policy refreshes an expired credential once when a connector implements `refreshCredential`; the MCP connector does not, and it configures no server authentication. |
| Lifecycle hooks persisted with dedup and replay | implemented-but-unverified | `adapter capture persists in order, deduplicates delivery and replays from the stored cursor` passes in `apps/melete/test/integration/hooks.test.ts`, and the Python plugin suite proves observer failure isolation. The real-engine run (`hooks-real.test.ts`, opt-in with `MELETE_HERMES_E2E=1`) reaches the real hooks but its final broker-action assertion has not passed on this tree; real compaction observation is unproven. |
| Automatic skill selection in a job | implemented-and-tested | `member bundles select at most three shared skills; revocation fences work, replay, knowledge and old capabilities` in `apps/melete/test/integration/principals.test.ts` exercises the actual bundle path, capped at three and filtered by membership and audience; `at most three load, however many match` and `the same inputs always give the same bundle` in `packages/skills/src/skills.test.ts` prove determinism. |
| Correction → candidate → evaluation → promotion → rollback | implemented-and-tested | `completed job, owner correction, then a different job succeeds with fewer interventions and no private details` in `learning-three-act.test.ts`; `validation selects before final; one-space canary and one-call rollback fence delivery`, `selected validation cannot enable canary without passing final evidence bound to and after selection` and `an altered candidate definition cannot enter canary` in `learning-evaluation.test.ts`. Scoped to one procedure family with scripted providers; see [learning](LEARNING.md). |
| Teammate reuse of an evaluated shared skill | missing | Evaluated procedures are delivered only for `role: owner`, `audience: private`; a qualified shared promotion is rejected, and the principal tests prove a member cannot obtain that private procedure by requesting an owner scope. Published shared Markdown skills are a separate, tested path. |
| Revocation prevents subsequent shared-space use | implemented-and-tested | The principal integration test above proves refused reads, refused new-job admission, stale broker and gateway capabilities, cancelled queued work, invalidated delivered memory and a fresh personal bundle without shared context; a regrant leaves old capabilities stale. |

## Other capabilities with named evidence

| Capability | Status | Evidence and limit |
|---|---|---|
| Brokered MCP over HTTP | implemented-and-tested | `MCP HTTP transport supports JSON and SSE while pinning session and rejecting redirects`, `MCP readOnlyHint cannot bypass approval, and repeated intent dispatches once`, `MCP owner-only tools disappear and reject direct calls in a public compartment`. Configured servers receive protocol messages and admitted arguments only. |
| Browser worker with takeover | implemented-and-tested | `approval binds the exact browser intent and repeated proposals dispatch one effect`, `an unapproved submit has no external effects and its warning identifies the observed destination`, `configured browser connections require an isolated endpoint in production` in `browser-broker.test.ts`; the controller fixtures inject a takeover between locator wait and dispatch and require zero submissions. Local Chromium fixtures; the Linux image and combined Compose stack were not run on the development host. See [the browser worker](browser-worker.md). |
| In-cell execution with artifact validation | implemented-and-tested | `admission reserves once, claims once, and accepts only its matching late result` and `two concurrent execution settlements produce one durable result` in `execution-admission.test.ts`; artifact checks in `artifacts.test.ts`. Two of these cases call `python` and fail on a Linux host that only has `python3`; that portability fix is assigned separately. |
| Read composition (`compose`) | implemented-and-tested, not exposed by default | `HTTP composition is discovered, loaded and produces only a compact join with broker evidence` and `a join has separate actions, settled reservations and real receipt handles` in `compose.test.ts` run with the test executor. The default service injects no cell executor, so `HTTP composition is unavailable without the service-owned cell executor` describes the shipped entry point. |
| One pinned engine per attempt | implemented-and-tested | `pins the image, mounts only the job subpath, and isolates its sole broker peer` and `concurrent jobs never share a network or writable Hermes home` in `runtime/docker.test.ts` (Docker CLI faked); the live boundary was probed on a Linux host as scenario 6. The scripted HTTP proof through a real local engine is `wired-assistant.test.ts` (skips itself without `.hermes-venv`). |
| Broker plugin registration and forwarding | implemented-and-tested | `test_registers_one_tool_per_catalog_entry`, `test_a_dispatched_call_returns_the_receipt`, `test_a_broker_refusal_keeps_the_brokers_own_code` in `packages/runtime-hermes/tests/test_plugin.py`, using a test broker. |
| Approval results tell the runtime to park | implemented-and-tested | `test_a_parked_action_tells_the_model_to_stop` and `test_an_unknown_dispatch_is_never_presented_as_either_outcome` in the Python plugin suite; `a parked action turns a completion into waiting_for_approval` in the adapter suite. |
| Audience-qualified skills | implemented-and-tested | `preserves a qualified audience and refuses a different container` in `packages/contracts/src/principals.test.ts`; the integration test excludes private and incorrectly qualified files. |
| Existing account upgrade | implemented-and-tested | `additive migration preserves the setup guard, login and an issued personal-space capability` applies the earlier journal, seeds real account, session and work rows, upgrades through every later migration, and verifies login and both attempt fences. |
| Adapter sequencing and prompt assembly | implemented-and-tested | `every event carries the one dedup key format` and `the instructions are identity, then skills, then knowledge` in the runtime adapter and client suites, with recorded HTTP responses. |
| Whole end-to-end capability proof against the real engine | pending | A single opt-in test that combines discovery, hooks, learning, member context and revocation through a real local Hermes exists in a separate pass and has not landed; nothing on this tree claims it. |

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

Published shared skills use `audience: space:<space-id>`; plain `space` remains
valid within its checked container. Missing skill audiences are private. The
bundle reads only the job's authorized space and at most three selected skills.
It also includes bounded, active published Markdown knowledge with matching
container and audience. Derived memory Markdown is excluded: its authoritative
recall path supplies the current claim revision. Evaluated procedures remain
private to the space owner. An invitation interface is outside v0.1.

## Verification

```sh
bun test apps/melete/test/integration/principals.test.ts packages/contracts/src/principals.test.ts --max-concurrency=2
bun test apps/melete/test/integration/hooks.test.ts packages/runtime-hermes/src --max-concurrency=2
bun test apps/melete/test/integration/catalog.test.ts apps/melete/test/integration/mcp.test.ts --max-concurrency=2
bun test apps/melete/test/integration/learning-three-act.test.ts apps/melete/test/integration/learning-evaluation.test.ts --max-concurrency=1
bun run test:plugin
bun run lint
bun run typecheck
bun run compose:check
```

The optional real-engine hook check is
`MELETE_HERMES_E2E=1 bun test apps/melete/test/integration/hooks-real.test.ts --max-concurrency=2`;
prepare `.hermes-src` and `.hermes-venv` as the README describes. It uses ports
3160 and 3162 and a scripted fake provider. Skipping it during ordinary checks
is not end-to-end proof. Tests use disposable PostgreSQL 17 and pg-boss when
`DATABASE_URL` is unset; a skipped database test is not a pass. The accepted
contract additions are recorded in the
[contract note](../.agents/notes/proposed/2026-09-12-w14-contract-additions.md).
