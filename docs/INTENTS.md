# Saying it once

A person tells Melete what they want once. Melete keeps hold of it until it is
done, and says plainly when time is running out.

## What Melete keeps

"Family birthday, book a suitable Haidilao on the 9th for 6 of us" becomes an
**intent**: the person's words exactly as they said them, Melete's one-line
reading of them, the details it took from them (a place, a party size, a time,
a budget, the people involved), how it will know it is done, and when it has to
be done by.

The person's words are read by Melete from their own message in the
conversation. Each detail is marked as theirs only when those words say it: a
name or a phrase as itself, a number as a number or a number word, an amount as
an amount, a day or a time as a date parser reads it from the words. Everything
else is Melete's guess.

Melete reads its understanding back in one line, with every guess marked, and
gets going:

> On it: Book a table for the family birthday. Haidilao, for 6, Fri 9 Oct,
> 7:00 PM (my guess), by Fri 9 Oct, up to $300 (my guess).

Nothing waits on that line. The person corrects any detail from Home, and what
they type becomes theirs (`a value the person never said shows as inferred`).

Intents appear on Home under **What I'm on**, each with where it stands, what
happens next and when it is due. They outlive the conversation they came from:
deleting the chat leaves the intent and its work in place
(`an intent survives its chat`). The same request kept twice is one intent
(`the same request kept twice is one intent`).

A commitment the person takes up with **Handle it**, or a reply they ask
Melete to chase, becomes an intent too, worked by the job it already has and
watched by the deadline it already has.

## Only the person's details count as theirs

What Melete may do without asking is decided by the person's approval rules,
as for any action. When work for an intent sends something, a value in it that
equals a detail the person said counts as theirs. A detail Melete guessed, or
read somewhere, counts for nothing: the action is treated as carrying a value
nobody can vouch for, and the approval card says so
(`an inferred value never raises broker trust`).

## Before the deadline

Every intent with a deadline gets a look ahead of it: a day before a booking,
a purchase or a meeting, two hours before a reply or a delivery, fifteen
minutes before a reminder, and never more than half the time left. If the
intent is not done by then, Melete raises one notice while there is still time
to act, and the work on it is woken with it
(`an unfinished intent raises one at-risk situation at T − lead`). An intent
already done raises nothing (`an intent that is done before its deadline raises
nothing`).

A deadline the person said can reach them at any hour, like any deadline they
set. One Melete chose is kept the same way but never reaches them in their
quiet hours (`a deadline the person never said is kept, but never as theirs`).
At the deadline an intent still open ends as out of time, its work stops, and
the person is told. See [Noticing what changes](SITUATIONAL-AWARENESS.md).

## Cancelling

**Cancel** on Home stops the intent's work and lets go of its deadline
(`a cancelled intent stops its run`). It then takes back what the work had
already changed outside Melete, newest first, each step the way the person's
own Undo would (see [Undo](UNDO.md)), and lists anything that stays as it is
(`cancelling takes back what the work changed, newest first, and lists what it kept`).

## For developers

- `intent.capture` is offered to conversations. It takes a title, a kind
  (`meeting`, `booking`, `purchase`, `reply`, `deliver`, `remind_check`,
  `watch`, `other`), typed details and a deadline (a moment, or a day; a day is
  due at the end of the working day where the person is). It returns the
  read-back line and the guesses.
- `GET /intents` lists the person's open intents and those that ended in the
  last day. `PATCH /intents/{id}` corrects details by path, against the version
  read. `POST /intents/{id}/cancel` stops one.
- Each intent is carried out by a piece of long work (see [Long work](RUNS.md)).

## Evidence

`apps/melete/test/integration/intents.test.ts` covers each behaviour above by
the test names quoted. `apps/melete/src/intents/origins.test.ts` covers how a
detail is marked as the person's or Melete's guess, and when a deadline is
looked at.
