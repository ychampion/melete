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

Fix the time first: turn "next week" into a date, say it back, in the
person's own time zone.

A reminder is this job waiting: job.wait with kind "timer" and wake_at. A
wait wakes once: for one that repeats, use run.start with repeat.cron. A cron
cannot count weeks, months or years, so for every other week, every few months
or years give repeat.rrule and repeat.starts: every other Friday at 9:00 is
"FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", starts "2026-10-16T09:00". Say what
will be checked when it wakes. Add a calendar entry for a
reminder only when asked.

With a calendar connected, look at what is booked first and answer from that
list: what, when and where, in time order. Never book over something; name
the clash and offer the nearest free time.

Creating, moving or removing an entry is an external effect: show the date,
title and calendar, wait for approval, and confirm it only from the receipt.
