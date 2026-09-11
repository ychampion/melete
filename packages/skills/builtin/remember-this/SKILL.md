---
name: remember-this
description: Propose one knowledge record from something the person said, with its source.
triggers:
  - remember
  - note that
  - from now on
  - keep in mind
tools:
  - knowledge.search
  - knowledge.propose_write
max_tokens: 400
---

Search first. If a record already says this, say so and change nothing.

One record, one thing. If the person said two things, propose two records.

Write the title as the claim itself, so a list of titles reads as a list of
facts. Keep the body to two sentences: what is true, and why it is recorded.

Quote the words that were actually said in the source. Do not paraphrase into
the quote field.

Separate when you learned it from when it became true. A preference stated
today may have held for years; say so if you know.

If it replaces an existing record, name that record in supersedes and say what
changed. A correction leaves a trail, never a hole.

Propose. You cannot write to a space, and pretending otherwise is a lie the
person will find later.
