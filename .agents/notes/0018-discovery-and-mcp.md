# Discovery over a small core, with MCP and composition behind the broker

The broker previously returned every granted connector schema at the start of
an attempt. Discovery now separates knowing that a tool exists from paying for
its schema in the model context. It changes context selection, never authority.

## Catalog and attempt context

`apps/melete/src/broker/catalog.ts` builds manifests only after checking the
current job, attempt, space, active connection, persisted scopes and capability
scopes. A compact manifest has a name, one-line description, input-schema
fingerprint, at most two examples, effect class, required scopes, source and
health. Sources are trusted connector metadata, provider capabilities, scoped
skills and operator-installed MCP servers.

The default core allowance is 750 estimated serialized-schema tokens including
`search_tools` and `load_tool`. Selection prioritizes registered files,
knowledge and react tools, then successful-use counts on granted connections,
with stable name ordering. This revision contains no knowledge/react connector
or W9 capability producer; discovery exposes a seam without inventing them.

Postgres `tsvector` ranks the already scoped remaining catalog by name,
description and examples. Search targets 1,000 tokens but always returns its
highest-ranked match; a long valid scope list cannot hide a capability. A load saves
the schema in `attempt_tool_context` and records its fingerprint in the event
ledger. The same attempt can recover it after a service restart. A replacement
attempt starts its own context. Names already shown remain bound to their
connection even when another account is granted or revoked; a new account cannot
reuse a vacated name in that attempt.

Each serialized input schema is limited to 3,000 UTF-8 bytes, at most 750 tokens
under the existing characters/4 estimator, matching the core allowance. MCP
workers omit oversized tools while retaining the server and report the omitted
names in degraded health notes. `load_tool` independently checks the same cap
before persistence, including tools from other connector sources. This is a
per-schema limit; the initial core still enforces its separate aggregate budget.

Invalid native entries, duplicate skill names and connector collisions with
broker-owned names raise a `BrokerFault` inside entry admission. Discovery drops
that entry and records a deduplicated `catalog_rejected` notice; unrelated tools
remain available. Valid same-name tools on different connections retain their
account aliases.

Every call rechecks authority. Async or unresolved schemas fail before an action
is created, and independent schemas do not share an Ajv `$id` registry. A
changed schema, effect class or approval policy cannot silently replace the
loaded tool's execution policy. Skills resolve through the same filesystem
space identifiers as the knowledge API; their frontmatter cannot grant scopes.

## Pinned Hermes continuation

Hermes v2026.9.7 (`2237be355906fbe6065ce1815711eee52b2d646e`) snapshots the
available tools when creating an agent. The plugin calls `ctx.register_tool`
after a broker load. The adapter independently reads the authenticated broker
catalog, explicitly stops the old run, consumes its terminal event and starts
a fresh HTTP run in the same attempt. Model text saying `tools_loaded` is not
evidence of a load. Approval parking takes precedence over continuation.

The continuation uses the same native session, a distinct durable idempotency
key, one shared wall/turn/output allowance and one continuous runtime event
sequence. There is one public attempt outcome. The first input includes the
broker's prior transcript. Subsequent runs use native session hydration because
the pinned API's explicit `conversation_history` parser drops tool-call fields.
After execution ends, a ledger lookup bounded by the broker client's timeout (30 seconds by default) preserves
pending approvals when the model's wall allowance is exhausted. It cannot start
new runtime work and aborts a stalled lookup. Timeout or unavailability emits
`unknown_check`, preserving uncertainty; the service holds the job for input
without scheduling an automatic retry. Configure `brokerParkedActions.timeoutMs`
to match a customized broker timeout.

`packages/runtime-hermes/scripts/discovery-e2e.ts` checks the relevant pinned
source hashes, starts the actual local server on 3140 with the broker on 3142,
and scripts search, load, execution and receipt reporting through the model
gateway. It measures the actual first request's system prompt and tool schemas,
checks native history prefixes and saves local evidence. The estimator is
`ceil((system prompt characters + serialized schema characters) / 4)`; fake
provider usage fields are not used as a scaffolding measurement. The first
request measured 7,426 system characters plus 2,774 schema characters, or 2,550
estimated tokens. The seven-tool core was 694 estimated tokens. Four scripted
provider requests across two runs produced one broker receipt and one completed
attempt outcome, with append-only history. `REPORT.md` records the command.

## MCP registration and the remaining launch boundary

Owner steering permits additive contracts. The `mcp` provider value and regenerated
OpenAPI/client types are documented in the
[contract additions note](proposed/2026-09-12-w10c-contract-additions.md).
Configured HTTP servers register against a persisted MCP connection and space.
Existing provider values and connection data remain unchanged.

The standalone worker accepts an operator-owned command/arguments or HTTP URL,
scope allowlist, owner audience and explicit tool mappings. Operator effect
classes default to `write_external`; remote `readOnlyHint` cannot lower them.
The stdio integration server demonstrates a brokered read and an external write
that cannot run until approval. It also verifies intent deduplication, trust
warnings, denied scopes and honest unknown outcomes after acknowledgement loss.
It uses the same `mcp` provider and broker adapter as configured HTTP servers.
An owner-only installation is hidden from public compartments and is checked
again at dispatch after any approval. JSON Schema 2020-12 is preserved explicitly
for MCP's default dialect; draft-07 tools remain supported. Neither dialect can
use an async validator or resolve an unregistered external schema.

Workers belong outside the runtime cell. The transport filters inherited keys,
uses an owned temporary directory, denies client roots/sampling, limits messages
and deadlines, and refuses redirects or automatic replay. This does not isolate
a same-identity process from host files, process inspection or networking. A
dedicated OS identity or sandbox denying vault/database access remains necessary
before service startup can launch local untrusted installations. Production
stdio is refused before spawning; the raw transport also refuses outside tests.
HTTP workers run wherever the operator installed them and retain their host's
filesystem/network access. Melete sends no service credentials and disposes
the protocol session on shutdown. Authentication configuration and session
resumption are outside this bounded implementation.

## Composition seam

`ComposeService` accepts at most eight predeclared reads and a JavaScript function
body. Each read is an individual broker action with a reservation and durable
receipt. The broker checks the entire plan, then rechecks scope, schema and read
classification at admission and checks authority again before releasing output.
The executor receives JSON without a broker client or credentials. The caller
receives compact JSON and receipt-backed action handles with inferred provenance.

Limits are 8 KiB of script, 16 KiB of read arguments, 1 MiB of input, 32 KiB of
response and five seconds, including broker work. Service policy may lower them.
The `ComposeExecutor` interface is for W10a's cell execution. Without an injected
executor `compose` is unavailable. The in-process `node:vm` fallback is limited
to tests and provides no production security or heap boundary. Cell wiring and
its isolation verification land when W10a merges.

## Verification

Acquire `C:/Users/gamin/.melete-test.lock` with the owner's atomic mkdir loop
before a full `bun test --max-concurrency=2` run, and release it on success or
failure. Focused runs need no lock. Run `bun run typecheck`, `bun run lint`,
`bun run test:plugin`, `bun run compose:check`, and the discovery e2e script.
The e2e needs an ignored `.hermes-src` at the pinned revision and an isolated
`.hermes-venv` with that source installed; it uses no real inference credentials.
Postgres 17 runs locally when `DATABASE_URL` is unset, with real pg-boss and
default WAL/fsync. Each fixture has its own database. Identical knowledge seeds
are copied into separate real Git repositories rather than recreated per case.
`REPORT.md` records check outcomes, timing limits and the production stop.

The final run with a preserved owner marker passed 982 tests, with 14 existing
TODOs and no failures, in 211.91 seconds. The three-minute whole-suite target
remains unmet after the brief's two fixture-performance fix cycles. The earlier
reply/submission timeouts did not reproduce in this run; no fault-injection
assertion or timeout was relaxed to obtain the pass.
