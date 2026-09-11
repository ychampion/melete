# MCP provider addition and remaining process isolation

Status: provider addition authorized; production stdio launch refused
Date: 2026-09-12

The owner's additive-contract steering supersedes the initial provider stop.
`ConnectionProvider` now includes `mcp`, with regenerated OpenAPI and client
schemas recorded in `2026-09-12-w10c-contract-additions.md`. The database uses a
text provider column and requires no enum migration. No existing provider is
relabelled. Configured HTTP installations register against a persisted MCP
connection and space through the ordinary broker.

Operator configuration fixes exposed names, scopes, owner audience and effect
classes; the default is `write_external`. Server annotations do not grant
permissions. The service checks owner audience at discovery, proposal and
dispatch, and the adapter rereads persisted scopes before calling the transport.
Receipts carry external-content provenance and action evidence handles.
Unacknowledged calls remain unknown and are never replayed automatically.

## Remaining OS boundary

Filtering environment variables and setting a temporary working directory do
not stop a same-account subprocess from reading service-accessible files,
inspecting allowed processes, or using host network routes. Production stdio
configuration therefore fails before spawning. The raw stdio transport also
requires `NODE_ENV=test`; the production configuration adapter refuses stdio
even in that environment. There is no boolean configuration escape hatch.

A future launcher needs a dedicated OS identity or a verified sandbox denying
vault/database files and credentials, process inspection, and unauthorized
network access. Until then, only trusted test fixtures exercise stdio. The
stdio fixture proves broker approval, intent, audience, scope and provenance
gates; it does not claim OS isolation.

HTTP servers are independently installed by the operator. Melete sends only
protocol messages and admitted arguments, with no service keys or client roots,
sampling or other client capabilities. The remote host controls the server's
filesystem and network access. Redirects and automatic call replay are refused,
responses and deadlines are bounded, and shutdown disposes the session. Server
authentication configuration, session resumption, tasks and output-schema
validation are not implemented.

## Protocol references and verification

The transport follows the official MCP
[2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
specifications. MCP's default JSON Schema dialect is made explicit as 2020-12;
draft-07 schemas may declare their dialect. Async validators and unresolved
external references fail closed in broker validation.

Run `bun test --max-concurrency=2 apps/melete/src/connectors/mcp.test.ts
apps/melete/test/integration/mcp.test.ts`. `REPORT.md` records current results.
The fixture includes a read tool and a write tool that dishonestly claims
`readOnlyHint`; no write reaches the server before canonical-payload approval.
Further cases exercise grant and audience revocation, HTTP registration,
2020-12 tuple constraints, missing acknowledgements and production launch refusal.
