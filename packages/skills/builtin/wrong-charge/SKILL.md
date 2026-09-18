---
name: wrong-charge
description: Query a charge the person did not agree to, quoting what the company billed.
triggers:
  - wrong-charge
  - charged me twice
  - charged the wrong
  - a charge i did not
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when a company took an amount the person did not agree to: a double
charge, an old rate, a fee never mentioned. A good outcome is the amount back
or the difference credited.

Four sentences, first person: the date and amount as their own email states it,
that sentence quoted from the evidence, what was expected instead, and the
correction wanted. Treat it as their error, not fraud. No legal claim.

Ask once per company before the first message. Never send the same message
twice. Afterwards follow up only inside the bounds that approval set.

Wait on the reply trigger, deadline five days out. Nothing by then, send one
follow-up; two at most. Then the complaints address, and the card issuer only
if the person says to.

Stop when it is corrected, when the person says stop, when they have refused
twice with reasons, or when the charge turns out to be right.

Record each receipt, and what they said the charge was for.
