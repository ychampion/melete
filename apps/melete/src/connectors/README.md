# Files, web, email, calendar, knowledge, test

Each connector ships a manifest (tools with JSON Schema, effect class,
required scopes, whether `verify` can decide), `execute`, `verify`, `health`,
and its credential requirements. They run as trusted in-process code in v0.1;
`docs/THREAT-MODEL.md` says so, and moving them out of process is the documented
next step.

See `docs/CONNECTORS.md` for the tool tables.

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

`createTestConnector(sql)` uses its own durable `test_destination_ledger` table;
call `initializeTestLedger(sql)` once when preparing the database. Accepting the
same action id never inserts a second destination row. `drop_ack: true` throws
only after that acceptance, and `verify` looks up the action id and hash without
sending anything. `{ verify: false }` makes verification unsupported. The
`memoryTestLedger()` implementation is for unit tests; conformance and the
running service use Postgres.

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
