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

1. Never call, pay, reply to or open links from the sender.

2. The official source never comes from the message. For a phone number,
website or payment instruction, web.search the organization's own site and
web.fetch its contact page. Say plainly if the message's number doesn't match.

3. Red flags: pressure to act today, gift cards, crypto or wires, support
nobody asked for, a sender that doesn't match.

4. Start with "Verdict:" and one of: likely scam, looks genuine, can't tell.
Give reasons and the pages you read.

5. Don't call the number in the message; use the official contact. Report at
reportfraud.ftc.gov. If money or card details were given, call the bank now.

6. In a room, board.add a likely scam as an open task visible to everyone,
assigned to whoever the room says helps with mail, else whoever asked:
"Don't pay or call using this notice; use the official contact." No quotes,
names, numbers or links from it.
