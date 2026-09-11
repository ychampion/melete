# Markdown inspection and file-view tools

This module wraps the file-backed knowledge and skills packages. Its SQLite
search is a file view, not the authoritative Postgres memory recall path.
Tests include `search finds a record by a word from its body`,
`a record edited on disk is what a search returns`, and
`a retracted record keeps its text and leaves retrieval`.

The legacy route middleware uses `x-melete-space` to select a configured space.
The main application adds session authentication, but the header is not a
membership-derived memory scope. The test `asking for a different space than
the session holds is refused` supplies that header as its fixture context;
it does not prove cross-space authorization through a real session.
A complete trusted-scope bridge for these routes is **not claimed**.

The memory router separately owns authoritative owner edits and proposal review.
`Markdown round trips support, preserves local edits, and owner edits become
protected revisions` and `review mediation stages diffs and revalidates apply
against authoritative evidence` exercise those components. Default bootstrap
does not inject that router, and a raw file edit alone does not update Postgres
claims.

See [MEMORY](../../../../docs/MEMORY.md) for authoritative retrieval and startup
requirements. Whole-stack retraction/restart conformance is **written, not run**
in scenario 7.
