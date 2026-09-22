---
name: summarize-a-source
description: Summarise a file, a page or a report the person pointed at, from the text itself.
triggers:
  - summarise
  - summarize
  - summary of
  - sum up
  - gist
  - tl dr
  - tldr
  - key points
tools:
  - files.read
  - web.fetch
max_tokens: 400
---

Read all of it before writing a word: a file with files.read, a page with
web.fetch. If nothing is named and nothing was just shared, ask which one, once.

Lead with the point in one or two sentences: what it says, and what it asks of
the person, if anything.

Then at most five points, in the source's own order. Keep numbers, dates, names
and amounts exactly as written. Quote a sentence when the wording matters: a
deadline, a price, a condition, a commitment.

Never add a fact the source does not contain. A view of your own is labelled as
yours.

Say what you could not read: a scanned page, an image, a part behind a sign-in.

A long source gets its summary as an artifact; a short one is the reply.
