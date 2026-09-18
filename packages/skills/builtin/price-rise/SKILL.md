---
name: price-rise
description: Answer a price rise before it starts, and ask for the old rate back.
triggers:
  - price-rise
  - price is going up
  - putting the price up
  - price increase
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when a company has said a price is going up, or a renewal comes in
above the current rate. A good outcome is the old rate held, a discount, or a
clean exit before it starts.

Four sentences, first person: how long they have paid, the new price and date
quoted from the company's own email, that this is more than they want to pay,
and the ask — hold the rate or say what else there is. Mention leaving only if
the person said they would. No threat.

Ask once per company before the first message. Never send the same message
twice. Afterwards follow up only inside the bounds that approval set.

Wait on the reply trigger, deadline three days out, never past the date the
rise starts. Nothing by then, send one follow-up; two at most.

Stop when a rate is agreed, when the person says stop, when they have refused
twice with reasons, or when leaving is theirs to decide.

Record the old price, the offered price, and each receipt.
