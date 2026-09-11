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

The optional memory router is not supplied by default bootstrap. The legacy
knowledge module still selects its file-view space from a header after public
session authentication; that is not authoritative memory scope validation.

See [CLIENT](../../../../docs/CLIENT.md) for client behavior and
[ARCHITECTURE](../../../../docs/ARCHITECTURE.md) for wiring and test references.
