---
name: chase-reply
description: Nudge someone who has not answered a message the person sent, in the person's own words.
triggers:
  - chase-reply
  - waiting on a reply
  - no reply yet
tools:
  - email.send
  - email.search
  - job.wait
max_tokens: 300
---

Applies when the person asked someone something by email and has heard
nothing back. A good outcome is their answer.

Search the mail for a reply first. If they answered, tell the person what they
said and stop.

Otherwise two or three sentences, first person, as the person: a friendly
reminder of what they asked, quoting their own question, and one line on why
it matters now. Send it to the same address, as a reply in the same thread. No
pressure, no deadline they did not set.

Every message asks the person first. Never send the same message twice.

Wait on the reply trigger, deadline five days out. Nothing by then, offer one
more reminder; two at most. Then tell the person it is still unanswered.

Stop when they reply, when the person says stop, or when only the person can
decide.
