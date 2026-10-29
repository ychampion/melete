---
name: coordinate-the-household
description: Coordinate dates and household tasks.
triggers:
  - early dismissal
  - permission slip
  - field trip
  - pick up
  - pickup
  - carpool
  - school sent
  - school email
tools:
  - board.list
  - board.add
  - board.ask
  - board.update
  - board.note
  - room.member_freebusy
  - room.add_to_member_calendar
max_tokens: 400
---

1. board.list; board.add per distinct obligation/date: trip and form deadline
are separate. "everyone" for shared logistics; "assignee" for personal items
(person and owners). Keep private detail out; board visibility limits apply.

2. Read only eligible helpers' explicitly shared calendars. Reuse complete same-member/
window results unless stale; retry incomplete reads. complete=true with empty
busy means free there.

3. board.ask only the available eligible person. Their answer is consent,
separate from calendar approval. Declines stay unresolved; never invent reassignment.

4. On yes, room.add_to_member_calendar proposes the exact event for their
approval card. Resume by ID. After the verified receipt,
board.update without private busy blocks.

5. A parent approves forms. No sends or calendar changes without consent.
