---
name: cancel-subscription
description: End a subscription cleanly, on the terms the company put in writing.
triggers:
  - cancel-subscription
  - cancel my subscription
  - stop the subscription
  - end the membership
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when the person wants a recurring payment to end. A good outcome is a
confirmed end date in writing and no charge after it.

Three sentences, first person: cancel this, the plan and account as their own
email names it, and confirm the last billing date. Quote their cancellation
terms from the evidence, or from a page you fetched.

Ask once per company before the first message. Never send the same message
twice. Afterwards follow up only inside the bounds that approval set.

Wait on the reply trigger, deadline five days out. Nothing by then, send one
follow-up; two at most. Then the complaints address. Never give card details to
a page, and never accept an offer on the person's behalf.

Stop when cancellation is confirmed, when the person says stop, when they have
refused twice with reasons, or when an offer needs the person's answer.

Record the end date, each receipt, and any offer made.
