---
name: coordinate-the-household
description: Put household dates on the board and fix clashes.
triggers:
  - early dismissal
  - permission slip
  - field trip
  - pick up
  - pickup
  - carpool
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

For news that affects several people in the room: a school email, a schedule
change, a form due, a pickup.

1. Each dated item goes on the board with board.add; board.list first so
nothing goes on twice. Visibility "everyone" for shared logistics, "assignee"
(naming them) for anything personal. Titles short; titles and details hold
nothing private. A word for one
person is board.note.

2. Check those involved with room.member_freebusy and name any clash.

3. Ask only the person who can resolve it, never everyone: board.ask, with the
reason in one line.

4. When they answer, board.update the item. If they said yes to their
calendar, room.add_to_member_calendar; they approve the exact event.

5. A form: fill it in the browser where you can, and leave the submit for a
parent to approve.

Never act on someone's calendar or send anything without that person's yes.
