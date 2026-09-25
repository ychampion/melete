---
name: refund-owed
description: Get back money a company has already agreed it owes, in the person's own words.
triggers:
  - refund-owed
  - refund
  - owed a refund
  - owe me a refund
tools:
  - email.draft
  - email.send
  - email.search
  - web.fetch
  - job.wait
max_tokens: 400
---

Applies when a company agreed money was coming back and it has not arrived. A
good outcome is the money, or a date for it in writing.

Four sentences, first person, as the person: what was bought, their own
sentence quoted from the evidence, the amount, and by when. Cite their
published policy only from a page you fetched. No legal claim, no threat.

Ask once per company before the first message. Never send the same message
twice. Follow up only with `chase.follow_up`.

Wait on the reply trigger, deadline seven days out. Nothing by then, send one
follow-up; two at most. Then offer the complaints address, and the card issuer
or regulator only if the person names one.

Stop when the money arrives, when the person says stop, when they have refused
twice with reasons, or when only the person can decide.

Record each send with its receipt and their answer.
