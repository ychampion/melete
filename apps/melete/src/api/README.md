# HTTP surface

The Hono adapters in this directory mount through `createApp` in
`../index.ts`. Jobs, replies, operations, policy, attention, questions,
triggers, approvals and events require injected service dependencies.
Authentication tests include `all other routes require a valid cookie while
health stays public`; event tests include `Last-Event-ID overrides the URL
cursor and unknown jobs fail before streaming`.

The internal action-read adapter uses a separate service credential and
injected space authorization. Its existence does not prove the public entry
point exposes every action route. Complete default routing of every OpenAPI
operation is **not claimed**.

The memory router is mounted by every Postgres-backed bootstrap with scope
derived from the authenticated principal's membership. The knowledge module
selects its file-view space from a header or query parameter after session
authentication and then asks the service whether the principal may use it;
that check is separate from the memory routes' scope.

See [CLIENT](../../../../docs/CLIENT.md) for client behavior and
[ARCHITECTURE](../../../../docs/ARCHITECTURE.md) for wiring and test references.
