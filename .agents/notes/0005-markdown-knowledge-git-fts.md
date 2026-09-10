# 0005 - Knowledge is Markdown in git with a per-space FTS5 index

Status: accepted
Date: 2026-09-11

## Problem

Memory is the part of an assistant a person most needs to trust and most needs to
be able to correct. Every managed option makes the database the source of truth,
which means the person cannot read their own memory in an editor, cannot diff it,
and cannot really delete from it.

## Decision

A knowledge record is a Markdown file with provenance frontmatter. One space is
one git repository and one SQLite FTS5 index file. The index is derived and
disposable; deleting it costs the time to rebuild it.

The frontmatter is the product decision, not the retrieval engine. Four fields
carry their weight: a stable id separate from the filename, so retitling never
breaks a supersedes chain; the split between `observed_at`, when Melete learned
it, and `valid_from`/`valid_until`, when it was true in the world; a status plus a
`superseded_by` pointer, so a correction leaves a trail instead of a hole; and an
audience, so one directory can later be shared safely.

Isolation is structural. A process gets a handle to exactly one space's index, so
cross-space search is impossible rather than disallowed, and a record whose
`space` field disagrees with its directory fails lint.

Retraction keeps the text and the reason. Hard deletion removes the file and the
index row in one operation.

## Alternatives

- **Tencent WeKnora.** Excellent document RAG. Five services minimum, and the
  database is the source of truth, which inverts the property we care about.
  Worth revisiting later as a document-ingestion tier.
- **gbrain.** Agrees that Markdown in git is the system of record, which is why it
  is the natural semantic tier later. Wiring our memory core to a 100-command
  surface in week one would couple our release to theirs, and its git deletes
  become database soft-deletes, which is not deletion.
- **A vector store as the primary index.** Embeddings send content to a third
  party, which a self-hostable assistant cannot make mandatory. Lexical search has
  no such problem, so it ships first.

## Evidence

The lint rules are functions with tests: space-equals-directory catches a record
written into the wrong space, including with Windows separators; a dangling
supersedes is an error and a dangling link is a warning; a retracted record can
never become active again. The index test builds three real records in a
temporary directory and shows that a retracted record is absent from the index
rather than filtered out of results, before and after reopening the file.
