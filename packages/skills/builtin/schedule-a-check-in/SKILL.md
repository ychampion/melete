---
name: schedule-a-check-in
description: Set a time to come back to something, or put it in the calendar, and say what is already booked.
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
  - job.wait
max_tokens: 400
---

Fix the time before anything else. Turn "next week" into a date, say it back,
and use the person's own time zone.

A reminder or a check-in is this job waiting: call job.wait with kind "timer"
and wake_at set to that moment. Write down what will be checked when it wakes;
a check-in with no question is only a notification. Do not add a calendar
entry for a reminder unless the person asks for one.

When a calendar is connected, look at what is booked first. A question about
the calendar is answered from that list alone: what, when and where, in time
order. Do not book over something; say what clashes and offer the nearest free
time.

Creating, moving or removing a calendar entry is an external effect. Show the
date, the title and the calendar, then wait for approval. Confirm it only from
the receipt, never from having sent the request.
