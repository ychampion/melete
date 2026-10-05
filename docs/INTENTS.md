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
conversation. Only the lines they wrote count: a quoted line, a forwarded email,
a reply chain or pasted email headers inside their message are someone else's
words, and a message that opens with one counts as none of theirs. Text pasted
with no such marker reads as theirs.

Each detail is marked as theirs only when their own lines say it, as something
they want: a name or a phrase as itself, and never right after "not", "no" or
"without"; a number on its own, never as part of a time or a longer amount
("6:30" says neither 6 nor 30); an amount as an amount ("$4,800" is 4800); a
day or a time as a date parser reads it. Everything else is Melete's guess
(`what a forwarded email or a quoted line says is never the person’s, so the
card keeps its warning`).

Melete reads its understanding back in one line, with every guess marked, and
gets going:

> On it: Book a table for the family birthday. Haidilao, for 6, Fri 9 Oct,
> 7:00 PM (my guess), by Fri 9 Oct, up to $300 (my guess).

Nothing waits on that line. The person corrects any detail from Home, and what
they type becomes theirs (`a value the person never said shows as inferred`).
An approval still waiting on the old details is withdrawn, and the work asks
again with the new ones if it still needs to (`a change to the details
withdraws an approval still asked about the old ones`).

Intents appear on Home under **What I'm on**, each with where it stands, what
happens next and when it is due. They outlive the conversation they came from:
deleting the chat leaves the intent and its work in place
(`an intent survives its chat`). The same request kept twice is one intent
(`the same request kept twice is one intent`).

A commitment the person takes up with **Handle it**, or a reply they ask
Melete to chase, becomes an intent too, once, worked by the job it already has.
A commitment's deadline stays the commitment's own: moving it from Home moves
the commitment's due date and its own look before it, and taking it away lets
that look go. A reply being chased follows the reply's own timing and has no
deadline to move (`a commitment taken up becomes one intent, and its deadline
stays the commitment’s own`; `a reply put to chasing becomes one intent, and
follows the reply’s own timing`).

## Only the person's details count as theirs

What Melete may do without asking is decided by the person's approval rules,
as for any action. When work for an intent sends something, a value in it that
equals a detail the person said, of the same kind, counts as theirs: an address
they named for a recipient, an amount they named for an amount
(`a detail the person said vouches only for a field of its own kind`). A detail
Melete guessed, or one that came from a quote or a forward, vouches for
nothing: the approval card shows where the value could not be accounted for
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
(`a cancelled intent stops its run`). Something taken up from Companies or
Waiting on goes back there, as Stop does, and can be taken up again
(`cancelling a commitment taken up hands it back and lets its clock go`).

Cancel then takes back what the work had changed outside Melete, newest first,
each step the way the person's own Undo would (see [Undo](UNDO.md)), and says
on the intent what stays as it is, in Undo's words
(`cancelling takes back what the work changed, newest first, and lists what it kept`).
A cancel that stops partway says so on the intent and is finished on the next
pass (`a cancel that stops partway is finished later, and says so meanwhile`).

## For developers

- `intent.capture` is offered to conversations. It takes a title, a kind
  (`meeting`, `booking`, `purchase`, `reply`, `deliver`, `remind_check`,
  `watch`, `other`), typed details and a deadline (a moment, or a day; a day is
  due at the end of the working day where the person is). It returns the
  read-back line and the guesses.
- `GET /intents` lists the person's open intents and those that ended in the
  last day. `PATCH /intents/{id}` corrects details by path, against the version
  read. `POST /intents/{id}/cancel` stops one.
- Each intent is carried out by a piece of long work (see [Long work](RUNS.md)),
  and counts toward the space's limit on long work running at once. Past it,
  capture is refused and the person is told to cancel something under
  **What I'm on** first (`past the space’s limit on background work, capture says
  so plainly`).
- Reading the list changes nothing. Where an intent stands is worked out from
  its work and its source when it is read, and the rows are caught up on the
  clock sweep (`reading what Melete is on writes nothing; the sweep catches the
  rows up`).

## Evidence

`apps/melete/test/integration/intents.test.ts` covers each behaviour above by
the test names quoted. `apps/melete/src/intents/origins.test.ts` covers how a
detail is marked as the person's or Melete's guess, and when a deadline is
looked at.
