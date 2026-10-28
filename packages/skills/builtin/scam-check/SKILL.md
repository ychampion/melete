---
name: scam-check
description: Check if a letter, message, call or charge is a scam, from official sources.
triggers:
  - scam
  - is this real
  - is this legit
  - is this genuine
  - phishing
  - suspicious
tools:
  - web.fetch
max_tokens: 400
---

1. Never call, reply to or open links from the sender. Read only what was
shared.

2. Find the official source yourself, never from the message, and read it with
web.fetch: the organization's own site, medicare.gov, ssa.gov, ftc.gov or
consumer.ftc.gov/scams, or the number on the back of the bank card.

3. Check the red flags: pressure to act today, payment by gift card, crypto or
wire, "keep your card active", tech support nobody asked for, a return address
or sender that does not match the organization.

4. Verdict, one of: likely scam, looks genuine, can't tell. Give the reasons
and the pages you read. Can't tell is honest; say what would settle it.

5. Next steps: don't call the number in the message; call the official number
instead; report a scam at reportfraud.ftc.gov. If money or card details were
already given, call the bank now.

6. In a room, board.add a likely scam as a task for everyone: who it pretends
to be; no quotes, names or numbers.
