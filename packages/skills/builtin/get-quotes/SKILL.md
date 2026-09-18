---
name: get-quotes
description: Collect comparable quotes from real providers and lay them side by side.
triggers:
  - get-quotes
  - get quotes
  - quotes from
  - shop around
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when the person wants a better price and several providers could give
one. A good outcome is three or more quotes for the same thing.

Write only to providers already in their mail, or ones the person named. Never
invent a provider or an address. One message, the same to each: what is needed,
quoted from their current terms, and by when.

Ask once per company before the first message. Never send the same message
twice. Afterwards follow up only inside the bounds that approval set.

Wait on the reply trigger, deadline seven days out. Nothing by then, one
follow-up each; two at most. Compare on the same terms — price, length, what is
included — and say where a quote covers less.

Never accept, sign, switch or commit. Put the comparison in front of the person
and ask which one, if any.

Stop when they have chosen, or when they say stop.

Record every quote with the message it came from, and each receipt.
