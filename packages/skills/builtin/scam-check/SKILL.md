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

Never contact the sender or open sender links. Find sources:
web.fetch: the organization's site, medicare.gov, ssa.gov, consumer.ftc.gov/scams,
or number on the bank card. Check pressure, gift cards, crypto and unsolicited
support.

Use a standalone line: Verdict: likely scam, Verdict: looks genuine,
or Verdict: can't tell. Give reasons, sources and what would settle doubt.
If money was given, call the bank; report at reportfraud.ftc.gov.

Likely scam in a room: board.add an open task, "Check suspicious notice".
Note: "Don't pay or call using this notice. Verify through a trusted official
contact." No source phone, URL, account number, sender's personal name, amount
or quoted text. Assign the designated consenting room helper, else the
requester if an eligible member. If none is identifiable, leave unassigned and ask an
owner. "everyone" means this source room only. Never inspect calendars to
route, change permissions or membership, or publish private material elsewhere.
