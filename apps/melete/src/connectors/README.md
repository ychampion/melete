# Files, web, email, calendar, knowledge, test

Each connector ships a manifest (tools with JSON Schema, effect class,
required scopes, whether `verify` can decide), `execute`, `verify`, `health`,
and its credential requirements. They run as trusted in-process code in v0.1;
`docs/THREAT-MODEL.md` says so, and moving them out of process is the documented
next step.

See `docs/CONNECTORS.md` for the tool tables.

## Typed faults

A connector that fails on purpose throws `ConnectorFaultError` with a kind from
`CONNECTOR_FAULT_KINDS`, a `may_have_committed` flag, an optional `retry_after`
in seconds, and plain-words detail. The broker's repair policy reads the class;
see `.agents/notes/0015-typed-repair.md` for what each class does.

`may_have_committed` is the field with teeth. True means no retry of any shape
until `verify` has spoken, whatever the kind says, and a connector that is
unsure must say true. Anything thrown that is not a `ConnectorFaultError` reads
as `unclassified` with `may_have_committed: true`, so an untyped throw behaves
exactly as it did before typed faults existed: the action rests at `unknown` and
reconciliation stays a separate step.

Three optional methods let a connector be repaired rather than only retried.
`describe()` answers with the fields the destination requires now, so a
`schema_drift` fault can produce a mapping candidate. `refreshCredential()`
refreshes through the credential store and answers false when the grant is gone;
it never substitutes another identity. `routes()` offers equivalent authorized
routes for the same operation, used only after a route said definitively that it
did not execute. A connector that implements none of them simply stops instead,
which is the correct outcome rather than a missing feature.

Which connectors classify what, in v0.1:

| Connector | Classes it raises |
|---|---|
| `test` | every class, on demand, for the falsifiers |
| `calendar` | `rate_limited` (with the server's `Retry-After`), `expired_credential` on 401, `revoked_credential` on 403. Every other refusal stays a plain failure |
| `files` | `bad_output` when a move's source is not the content the action recorded, and when a write does not read back as what was written |
| `web`, `email` | none yet. A web fetch reports the destination's status in its receipt rather than failing on it, and mail transport errors are not yet distinguishable enough to classify honestly |

A connector that classifies nothing behaves exactly as it did before typed
faults existed. Adding a class is a per-connector change with its own falsifier,
and guessing one would be the same guess the policy exists to refuse.

## Core connectors

`ConnectorRegistry` registers trusted connector instances by connection id and
returns connections in deterministic order. The broker applies capability and
connection scopes to each manifest before returning a tool catalog.

`createFilesConnector({ workRoot, spacesRoot })` confines relative payload paths
to `workRoot/<job_id>` or `spacesRoot/<space_id>/artifacts`. The service supplies
both identities in `ConnectorContext`; payloads cannot select another job or
space. `area` is `work` (the default) or `artifacts`; `files.move` also accepts
`to_area`. List a root with `path: "."`. Absolute paths, parent segments, Windows
streams/device names, and existing symbolic links or junctions are rejected.
The configured roots must already exist and their directory structure must be
controlled by the service. Portable Node filesystem checks do not provide a
kernel-enforced boundary against a separate process racing directory replacement.
Reads and writes default to a 2 MiB limit. A write is verified by its expected
content hash. A move needs `content_hash` in its recorded payload to decide an
unknown outcome; without that evidence verification remains undecided.

`createTestConnector(sql, { fault })` uses its own durable
`test_destination_ledger` table;
call `initializeTestLedger(sql)` once when preparing the database. Accepting the
same action id never inserts a second destination row. `drop_ack: true` throws
only after that acceptance, and `verify` looks up the action id and hash without
sending anything. `{ verify: false }` makes verification unsupported. The
`memoryTestLedger()` implementation is for unit tests; conformance and the
running service use Postgres. It also fails on purpose, once per fault class:
name a case from `TEST_FAULT_CASES` in the payload's `fault` field, or set
`MELETE_TEST_CONNECTOR_FAULT` for the whole connector, and the payload field
wins. Every case that did not commit raises before the ledger is touched, so a
repaired retry of one of them cannot leave a second delivery behind;
`lost_ack_verifiable` and `lost_ack_unverifiable` accept first and then lose the
acknowledgement, and only the first of those can be verified afterwards.

`createWebConnector()` accepts only HTTP(S) URLs without credentials. A trusted
`constraints.public_compartment: true` permits public addresses; otherwise the
hostname must exactly match `constraints.allowed_domains`. Every DNS answer must
be public, including IPv4-mapped IPv6, and each redirect repeats both checks.
The checked address is pinned through the HTTP transport's lookup callback, so
the transport cannot resolve the hostname again. The URL retains its full query
string in the action payload and receipt. Responses default to 2 MiB, a 15-second
request deadline, and five redirects. A web read has no durable outcome to verify.

Run the focused boundary tests with
`bun test --max-concurrency 2 apps/melete/src/connectors`.
