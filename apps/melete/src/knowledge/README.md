# Markdown records, git, FTS

Wraps `@melete/knowledge` for the service: reads and writes the per-space git
repository, keeps the `knowledge_record` catalog in step with the files, and
rebuilds the SQLite FTS5 index a space is searched through.

Retrieval is scoped by the handle the caller holds, not by a filter argument the
model supplies. A retracted record leaves the index in the same operation that
retracts it, and stays gone after a restart.

Owned by workstream W4.
