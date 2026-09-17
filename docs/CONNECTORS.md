# Connectors

Connectors are trusted service-side code selected by persisted connection IDs.
The manifest declares tool schemas, scopes, effect classes and verification
support. `ConnectorRegistry` validates manifests and refuses duplicate entries
(`registry refuses ambiguous tools and invalid manifests`;
`registry rejects duplicate connections and returns a stable connection order`).

This describes the tree at the head of `integration`.
The tests use temporary files, fake destinations and local protocol servers.
General compatibility with live mail/calendar accounts is **not claimed**.

## Contract and policy

Implement `Connector` from
[`types.ts`](../apps/melete/src/connectors/types.ts): a manifest,
`execute(action, ctx)`, `verify(action, ctx)`, and `health()`.
The trusted context carries job/space identity, constraints, cancellation signal
and an idempotency key equal to the admitted action ID. Request payloads do not
select arbitrary code or credentials.

| Effect class | Default broker rule |
| --- | --- |
| `read` | Eligible for admission within scope and budget |
| `write_reversible` | Eligible for admission within scope and budget; manifest approval requirements still apply |
| `write_external` | Requires payload-bound approval in the configured default boundary |
| `spend` | Requires approval and a budget reservation |

The default boundary has no configured reusable send authorization; such a
product feature is **not claimed**. Broker tests use injected policy seams and
must not be described as shipped owner configuration.
Evidence for the default effect gate is conformance 4, `An approval cannot be
spent on different content`. Schema declarations alone do not prove admission.

A timeout after dispatch becomes `unknown`. Verification inspects destination
evidence without repeating the effect. If verification cannot decide, uncertainty
remains visible. Conformance 3 tests `the action is never dispatched a second
time, including after broker restart` and `verify resolves the action to
succeeded and the job continues`.

## Implementations and evidence

| Connector | Implemented surface | Named test |
| --- | --- | --- |
| Files | List/read/write/move in configured work and space-artifact roots; content-hash verification | `files manifests parse and workspace/artifact writes can be read and verified` |
| Web | HTTP(S) fetch with address, redirect and trusted-compartment checks | `redirects repeat compartment and DNS checks, with no request to the denied destination` |
| Email | IMAP search/read, local draft, SMTP send; Message-ID verification in Sent | `accepted send with lost acknowledgement is unknown, then verified without resending` |
| Calendar | Read-only ICS import; CalDAV list/create/update with UID and content verification | `CalDAV create uses action UID and conditional PUT; list and verify use real HTTP locally` |
| Test destination | Durable acceptance with optional lost acknowledgement | `destination drops its acknowledgement only after acceptance and verify resolves it` |
| Exec | `exec.run` and `exec.python` carried out inside the cell against a broker-reserved action, with the finished record settled afterwards | `the exec manifest parses and declares in-cell execution with a record schema`; `execution-admission.test.ts` |
| Artifacts | Declared writes become artifact records with deterministic checks; publishing to the space or by email is an approved external effect | `artifacts.test.ts` |
| Generation (speech) | `audio.synthesize` as a `spend` capability with approval, reservation, receipt and an authenticated artifact endpoint | `is a real RIFF/WAVE file, not a placeholder string`; `speech-broker.test.ts` |
| MCP | Operator-configured HTTP servers behind the broker with operator-chosen effect classes, scopes and audience | `MCP config is strict, operator scoped, and defaults unclassified tools to external writes`; `MCP worker and server claims cannot make an ungranted tool callable` |
| Browser | Semantic observe, open, fill, click, select, read and an approved `browser.submit`, carried out by a worker process outside the cell with epoch-fenced takeover | `approval binds the exact browser intent and repeated proposals dispatch one effect`; `an unapproved submit has no external effects and its warning identifies the observed destination`; see [the browser worker](browser-worker.md) |

The code paths are in [the connector directory](../apps/melete/src/connectors).
`configuredConnectors` reads active connections and owner-controlled endpoint
configuration; email/CalDAV need matching configuration and sealed credentials.
End-to-end connection onboarding is **not claimed**.

### Files

Traversal, absolute paths, alternate streams, device names and links are
rejected in the tested paths:
`file boundary rejects parent traversal, absolute paths, alternate streams and
device names` and `file boundary rejects directory junctions and final
symlinks without touching outside content`. These are connector checks, not
proof of container filesystem isolation; that boundary was probed live in
scenario 6 on a Linux Docker host, where a sibling job's canary was unreadable
from the cell while its own workspace was writable.

### Web

Public research is still subject to SSRF restrictions; it cannot fetch
arbitrary private or metadata addresses. Private-context requests require the
trusted exact-host allowlist. Tests include `web validates every DNS answer,
so a mixed public/private answer never reaches transport` and `checked DNS
answer is passed unchanged to transport and DNS is not repeated`.
No claim of arbitrary-data exfiltration prevention follows from a domain
allowlist; comprehensive containment is **not claimed**.

### Email

Drafting stays local (`a draft is durable local output and never loads
credentials or calls SMTP`). Local IMAP/SMTP fixtures exercise the real
libraries (`real libraries authenticate, decode MIME for hygiene, send with
stable Message-ID and verify Sent`). Header injection and extra fields are
rejected (`context mismatch, header injection and unapproved extra fields never
reach SMTP`). Hygiene patterns do not detect every sensitive message.

Provider-specific OAuth onboarding and live-account acceptance are **not
claimed**. Tests use credentials belonging to local fixtures.

### Calendar

Imported ICS exposes only the read tool (`manifests conform and imported ICS
exposes only the read tool`). CalDAV updates preserve UID and check ETags
(`update preserves original UID, records its new action, and fails stale
ETags`); lost acknowledgements remain uncertain until verified
(`a dropped acknowledgement remains unknown until exact UID and content
verification`). Compatibility with every CalDAV implementation is **not claimed**.

### Knowledge and memory

The configured connector registry does not register a knowledge connector.
Knowledge routes, Markdown mediation and the Postgres memory service exist as
separate modules. A shipped broker catalog containing `knowledge.search` and
`knowledge.propose_write` is **not claimed**. File-view tests and authoritative
memory tests are described in [MEMORY](MEMORY.md); do not use SQLite search hits
as authority to disclose memory.

## Credentials and verification

Sealed secret storage is tested by `stores randomized sealed boxes and only
decrypts in the owning space` and `rejects a wrong master key, changed
ciphertext and cross-row swaps`. The service process and its master key remain
trusted; stronger host isolation is **not claimed**.

Run from the repository root:

```bash
bun test apps/melete/src/connectors
```

The broker's database scenarios also run under the full test command in
[README](../README.md).

## Watching a feed without spending on it

An `event` trigger wakes the job on every observation the connector delivers. On
a busy feed that means an attempt, a model call and a bill for every message,
most of which say nothing the person wanted to hear. A `watch` trigger is the
other thing: the service tests the observation itself, and wakes the job only if
a small deterministic predicate holds.

```ts
await client.api.POST('/jobs/{jobId}/triggers', {
  params: { path: { jobId } },
  body: {
    kind: 'watch',
    connection_id,
    event_name: 'mail.new',
    predicate: {
      all: [
        { field: 'from.address', op: 'eq', value: 'billing@example.test' },
        { field: 'subject', op: 'contains', value: 'overdue' },
        { field: 'amount', op: 'gt', value: 100 },
      ],
    },
  },
});
```

The language is deliberately too small to hide a decision in: dotted field paths
into the observation, at most five clauses, all of which must hold, and six
operators.

| Operator | Holds when |
|---|---|
| `eq` | the field is exactly the value |
| `contains` | the text contains the value, or the list has it as an item |
| `matches` | the text matches the regular expression; a pattern that does not compile is refused when the watch is made |
| `lt`, `gt` | both sides are numbers, or both are timestamps |
| `changed` | the field differs from the last observation this watch looked at |

There is no `or`. Two reasons to wake are two watches, which keeps every wake
traceable to one predicate a person can read.

Everything unclear is false: a missing field, a comparison between things that
are not comparable, a first sighting under `changed`. A watch that cannot tell
is a watch that does not wake.

When one does match, the job wakes with that observation as its evidence and the
consumed-event notice carries `because: ["event:<seq>"]`, so the wake can always
name the observation that caused it. Observations that do not match advance the
trigger's cursor and cost nothing else: no attempt, no model call, no row.

The attempt input lists the job's enabled triggers with their id, event name and
one plain sentence built from the spec. `job.wait` accepts either the trigger id
or the event name; the broker resolves a name under the job lock to the one
enabled trigger of this job that carries it, refuses a name no enabled trigger
carries, and asks for the id when two share it. An omitted deadline is no
deadline (`resolves the event name to the enabled trigger of this job,
broker-side`, `an unknown, disabled or ambiguous name is refused, and nothing is
recorded`).
## Discovering tools without loading every schema

The broker serves a small core plus `search_tools(query)` and `load_tool(name)`.
The core ranks candidates by lexical relevance to the job's objective and its
latest owner message, then granted files, knowledge and react tools, then the
most-used verbs on granted connections. `job.wait` leads when the job has an
enabled trigger, and `react` leads when the attempt answers a person directly.
A reversible verb is shown only together with an external-write sibling from
the same connection and namespace. MCP tools are candidates only when the job's
words match them. Selection budgets serialized schemas rather than counting
tools. The default core allowance is 750 estimated tokens of schemas, including
the two discovery tools, plus at most 250 estimated tokens for a names-only
index of every healthy tool left outside, carried on `load_tool`. The pinned
engine's scaffolding uses the rest of the 4,000-token tripwire.

`Connector.catalog` supplies trusted source metadata: `connector`, `capability`,
`skill` or `mcp`, up to two examples per verb, and optional core priorities.
Each compact entry carries its name, one-line description, schema fingerprint,
effect class, required scopes, connection and health. Capability producers such
as speech use this seam without changing discovery, and an unavailable
capability is left out of the catalog.

`POST /tools/search` accepts `{ "query": "archived invoices" }`. Postgres ranks
the already scoped entries with `tsvector`, weighting names above descriptions
and examples; no model is involved. Any query term may match: terms are ORed
and ranked, stemmed under the `english` configuration and also kept whole under
`simple`, and a name is indexed by its segments, so "restarting services"
reaches a verb named `ops.restart` (`search matches any term, stems it, and
reads identifier segments`). Only letters and digits from the query reach the
query text. Results target a 1,000-token allowance while
always returning the highest-ranked match, so a long scope list cannot hide a
capability. Results omit full schemas and tools already
loaded in this attempt. A query that matches nothing returns `tools: []`
together with `index`, the name and eight-word gist of every healthy tool that
can still be loaded, and a one-line `hint` (`a search with no match names what
can be loaded instead of returning nothing`). `POST /tools/load` accepts the exact result name. Two
accounts exposing the same verb receive stable account aliases, which the
broker resolves back to the original verb before deriving the action's intent
key. An alias cannot select another account.

Loads are recorded in `attempt_tool_context` and the event ledger. They survive
a service restart for the same attempt, expire with that attempt's authority,
and do not carry into a replacement attempt. A changed schema is not silently
substituted. Every search, load and use rechecks the current job, space, epoch,
revision and scopes. Loading a schema never grants a scope or changes an effect
class; ordinary execution still uses `POST /actions`.

Installed skills enter discovery as `skills.<name>` read tools. Their content
is read through `POST /tools/call` after loading; their frontmatter tool list
cannot grant access. Space skills are withheld in the public compartment.
The existing deterministic initial skill selection remains available.

Hermes v2026.9.7 snapshots tools when an HTTP run starts. The plugin registers
the newly loaded schema, and the adapter verifies the broker's catalog change,
ends that run, then starts a continuation with the same attempt authority and
shared budgets. There is one public attempt outcome; model-written
`tools_loaded` text does not authorize a continuation.

## Operator-installed MCP servers

The worker in `apps/melete/src/connectors/mcp.ts` supports an
operator-owned JSON config with a stdio command/arguments or an HTTP URL,
allowed scopes, an `owner` audience, and an explicit list of exposed tools.
For each tool the operator chooses a local alias, required scopes and an effect
class. The default is `write_external`. Server annotations such as
`readOnlyHint` never determine policy, and unconfigured server tools are ignored.

The worker runs outside the runtime cell. Its stdio transport uses a filtered
environment and its own temporary working directory. It receives neither vault
credentials nor database, broker or provider keys. It offers the server no
roots, sampling or other client capabilities. HTTP redirects, automatic call
replay and unbounded responses are refused. Results retain external-content
provenance and action evidence handles. A lost acknowledgement remains unknown;
generic MCP verification cannot prove that an effect happened.

Create a connection with provider `mcp` and the exact granted tool scopes, then
add its transport and policy to the owner-controlled `MELETE_CONNECTIONS_FILE`:

```json
[
  {
    "kind": "mcp",
    "id": "conn_REPLACE_WITH_CONNECTION_ID",
    "server": {
      "id": "notes",
      "endpoint": { "transport": "http", "url": "http://127.0.0.1:8080/mcp" },
      "allowed_scopes": ["mcp_notes.search"],
      "audience": "owner",
      "tools": [
        { "name": "search", "alias": "search", "required_scopes": ["mcp_notes.search"], "effect_class": "read" }
      ]
    }
  }
]
```

Service startup registers configured HTTP servers against their persisted
connection and space. Owner-only tools disappear from public compartments, and
the audience and persisted scopes are checked again before dispatch. Server
schemas default to JSON Schema 2020-12; draft-07 schemas can declare their
dialect explicitly. Unsupported dialects or unresolved references fail validation.
Shutdown disposes HTTP sessions. This implementation does not configure server
authentication or resume disconnected sessions; it sends no service secrets.

**Production stdio launch is refused before spawning.** A filtered environment
does not isolate a same-account process from service-readable files or host
networking. A dedicated OS launcher remains required. The real stdio integration
fixture uses the same `mcp` provider and broker adapter, with process launch
limited to tests. The [boundary proposal](../.agents/notes/proposed/2026-09-12-mcp-provider.md)
records the remaining isolation work.

## Composing read results

`compose` accepts a list of named reads and a JavaScript function body operating
on their JSON results. It preflights the complete list, then performs each read
as an individual broker action with its own budget reservation and receipt.
The script receives only JSON data; it cannot call tools, select connections or
grant itself authority. The broker returns bounded JSON plus the underlying
action evidence handles, and derived output retains inferred provenance.

The broker offers `compose` only when a `ComposeExecutor` is injected, and the
default service entry point injects none, so the shipped catalog does not carry
it (`HTTP composition is unavailable without the service-owned cell executor`).
The in-process fallback is restricted to tests; `node:vm` is not a production
security boundary and does not provide a memory limit. Connecting the in-cell
executor to this seam and verifying its isolation remains open work.
