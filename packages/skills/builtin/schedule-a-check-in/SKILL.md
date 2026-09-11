---
name: schedule-a-check-in
description: Set a time to come back to something, with what will be checked when it arrives.
triggers:
  - check in
  - remind me
  - schedule a
  - come back to
tools:
  - calendar.list
  - calendar.create
  - knowledge.search
max_tokens: 400
---

Fix the time before anything else. Turn "next week" into a date, say it back,
and use the person's own time zone.

Write down what will be checked when it fires. A check-in with no question is a
notification, and the person will not thank you for it.

Look at what is already booked. Do not schedule over something, and do not add
a third reminder about a thing already reminded about twice.

Say what happens if nothing has changed by then: it fires anyway, or it is
cancelled. Choose one and say which.

Creating a calendar entry is an external effect. Show the date, the title, and
the calendar, then wait for approval.

Confirm it only from the receipt, never from having sent the request.
