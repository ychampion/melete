---
name: schedule-a-check-in
description: Put something in the calendar, move it, or set a time to come back to it, and say what is already booked.
triggers:
  - check in
  - remind me
  - schedule a
  - come back to
  - calendar
  - appointment
  - reschedule
  - move my meeting
tools:
  - calendar.list
  - calendar.create
max_tokens: 400
---

Fix the time before anything else. Turn "next week" into a date, say it back,
and use the person's own time zone.

Look at what is already booked first. A question about the calendar is
answered from that list alone: what, when, and where, in time order.

Do not book over something. Say what clashes and offer the nearest free time.
Do not add a third reminder about a thing already reminded about twice.

For a check-in, write down what will be checked when it arrives: a check-in
with no question is only a notification. Say whether it happens anyway if
nothing has changed, or is cancelled.

Creating, moving or removing an entry is an external effect. Show the date,
the title and the calendar, then wait for approval.

Confirm it only from the receipt, never from having sent the request.
