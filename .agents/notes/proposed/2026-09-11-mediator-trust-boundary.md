# What a review of the knowledge write path found

Status: **resolved 2026-09-12**. This is a record of a review, and every fix
it describes landed with the knowledge lane. It is kept because the reasoning
is the useful part: the staging directory is untrusted input, and a green
suite says the code does what the tests say rather than that the tests say
the right things.
Date: 2026-09-11

## Problem

The knowledge package shipped green: the store, the mediator, the index, the
lint and the routes all had tests and all passed. A second pass over the same
code, looking for what the tests were not asking, found five faults. Four of
them were in the parts the module exists to guarantee, which is the useful
thing to notice: a green suite says the code does what the tests say, not that
the tests say the right things.

Each fault below was confirmed by making the fix, then putting the old
behaviour back and watching the new tests fail. A test that passes against both
the old code and the new one proves nothing.

## Decision

**The staging directory is untrusted input.** `.proposed/` is the one place an
agent is allowed to write, which is the point of it, and that makes everything
read back out of it a claim rather than a fact. `applyProposal` used to commit
the staged bytes as they were. A proposal file that did not come from
`proposeWrite` could therefore name `SCHEMA.md` as its path and rewrite the
taxonomy the lint trusts, carry a secret, hold frontmatter that does not parse,
or claim a record type that the space auto-applies while holding a type that it
does not. Everything is now re-derived from the content and re-checked against
the space as it is at approval time, and the record's type was removed from the
staged metadata entirely, because a second copy of a fact is a second thing to
disagree with and it was the copy the policy read.

**Two writes to one space corrupted each other's attribution.** A git
repository has one index, and staging then committing is a read-modify-write
over it. Eight concurrent writes did not merely collide on the lock: one commit
swept up all eight staged files, so seven records landed inside another
request's commit, under its message and its `Melete-Proposed-By:` trailer,
while their callers were told the write had failed. Writes to a space are now
serialized per repository.

**`git log --follow` invented history.** Asked for the history of one record it
returned commits belonging to other records, because rename detection decides
what a rename is by similarity and knowledge records resemble each other.
History that attributes somebody else's write to this record is worse than
history that starts at a rename, so `--follow` is gone.

**A symlink walked out of the space.** Containment was decided by comparing the
text of two paths, and a symlink is a path that leads somewhere its name does
not admit to. A link committed into a shared space read another space's records
into this one's index and search results. Containment now asks the filesystem
where a path actually goes, and the walk skips symlinks.

**Retraction wrote a claim nobody made.** It set `valid_until` to the day of
the retraction. `status` is what Melete believes and `valid_until` is what was
true in the world; keeping those apart is one of the four things note 0005 says
the frontmatter exists for. A record retracted because it was wrong from the
start was never true, so the validity window is now left as the person left it.

## Alternatives

- **Trust `.proposed/` because the runtime cannot reach it today.** Rejected:
  the architecture describes that directory as the agent's write path, and a
  check that exists only in the caller is not a boundary.
- **Serialize every write across all spaces with one lock.** Rejected: spaces
  are independent repositories and one person's slow write should not hold up
  another space.
- **Keep `--follow` and filter its output.** Rejected: more machinery to make a
  wrong answer less wrong. The stable record id is the honest way to find a
  retitled record's earlier life.
- **Resolve symlinks only on write.** Rejected: the read path is where the
  cross-space leak actually happened.

## Evidence

Falsification runs, each restoring the old behaviour and re-running the suite:

| Old behaviour restored | Tests that failed |
|---|---|
| Apply without re-checking the staged proposal | 8 |
| Rebuild the index only when it is empty | 1 |
| Write to a space without the per-space lock | 2 |

Before the symlink fix, a space containing `knowledge/borrowed.md` as a link to
another space's record loaded that record as its own and returned it from a
search of the wrong space; afterwards the space loads no records and the search
returns nothing. Before the concurrency fix, eight concurrent writes reported
seven failures and produced two commits; afterwards they report none and
produce nine, and each record's history names its own caller.

## Anything this changes for other lanes

The staging lesson generalizes: anywhere an agent can write and the service
later reads, the read is a boundary. The concurrency one generalizes too, to
any handler that shells out to git.
