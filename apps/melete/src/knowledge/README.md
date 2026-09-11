# Markdown records, git, FTS

Wraps `@melete/knowledge` and `@melete/skills` for the service: reads and writes
the per-space git repository, stages and applies agent writes, and answers a
search from the SQLite FTS5 index a space is searched through.

Retrieval is scoped by the handle the caller holds, not by a filter argument the
model supplies. A request is bound to one space before any handler runs, and a
handler given a different space id refuses rather than serving it. A retracted
record leaves the index in the same operation that retracts it, and stays gone
after a restart.

Authentication is not here. The placeholder middleware reads the space from the
`x-melete-space` header; the session will supply it, and every handler is
written as though it already does. Until the catalog rows exist, a space's
identifier is derived from its directory name, so it is the same on every
machine.

Every route served here is described by the OpenAPI document. A contract test
fails if one appears that is not, and the proposal and record-edit operations
are served by the memory module rather than this one.
