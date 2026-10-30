---
name: scam-check
description: Check possible scams against official sources.
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

Never call, pay, contact the sender or open sender links. The official source
never comes from the message. For a phone, website or payment instruction,
web.search the organization's own site; web.fetch official contacts.
Recommend that contact; say plainly if the letter's number doesn't match.
Don't call the number in the message. Flag pressure, gift cards/crypto/wires,
unsolicited support and sender/address mismatch.

Line 1: Verdict: followed by likely scam, looks genuine, or can't tell.
Give sources; admit doubt. If paid, call the bank; report at reportfraud.ftc.gov.

Likely scam in a room: board.add an open task, "Check suspicious notice".
Detail: "Don't pay or call using this notice. Verify through a trusted official
contact." Omit source phones/URLs/accounts/names/amounts/quotes.
Assign the designated consenting helper, else eligible requester.
Else unassigned; ask an owner. "everyone" means this room.
No calendar routing, permission/membership changes or cross-room publishing.
