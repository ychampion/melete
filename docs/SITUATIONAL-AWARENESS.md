# Noticing what changes

Melete keeps watch over the mail, calendar and Drive accounts a person connects. When
new mail arrives, a meeting moves or a file changes, the work that is waiting for it wakes, once,
with what changed in front of it. When a meeting moves close to its time, two
meetings overlap, a deadline comes near and is still unmet, or a message the
person sent has had no answer, Melete notices it on its own and tells the
person, as soon as it matters and no sooner. When nothing changes, nothing runs
and nothing is spent.

This page describes how changes in connected accounts become observations, and
how observations reach waiting work. Triggers and watch predicates themselves are
described in [CONNECTORS.md](CONNECTORS.md#watching-a-feed-without-spending-on-it),
and standing work in [RUNS.md](RUNS.md).

## From an account to an observation

The service reads each account's changes since it last looked, from the
account's own change feed:

| Account | What is read |
| --- | --- |
| Gmail | the mailbox history since the last history id |
| Outlook mail | the inbox delta from the time watching began, then from the delta link Microsoft Graph gave last time |
| IMAP mailbox | messages with a UID above the last one read, under the mailbox's UIDVALIDITY |
| Google Calendar | each occurrence in the next 14 days (`singleEvents`), cancelled ones included |
| Outlook calendar | each occurrence in the next 14 days (`calendarView`) |
| CalDAV collection | the events the server finds in the next 14 days (a `time-range` query), expanded into occurrences |
| Calendar feed, imported file | each occurrence in the next 14 days, expanded from the events' recurrence rules |
| Google Drive | the files that changed since the last page token, from Drive's own change feed, as metadata only |

Each account and stream (its mail, its calendar, its Drive) has one cursor in
`source_cursor`: where the feed was last read, when to read it next, and how the
last reads went. A first read starts the cursor at the account's present
state; what was already there is where watching begins, not news.

### Which accounts are watched

Every mailbox and calendar a person connects in their own space is watched,
with nothing to set up: its new mail and the changes to its meetings arrive as
observations whether or not any work is waiting for them yet (`a newly connected
mailbox produces mail.received with no trigger`). Each one has a switch in
Settings, under Connections: **Watch this account for changes**. On, a mailbox
says "Melete reads new mail's sender and subject to notice what needs you", and
a calendar "Melete reads each event's title, time and place to notice changes
and clashes". Off, it says "Off. Melete still reads this account for things you
asked it to watch": work that set its own trigger on the account still hears
it.

Turning it off stops those reads at once and removes, in the same step, what
they left: where the account was read to, what was kept about its calendar,
and every observation from it that nothing used (`switching it off stops reads
and clears its cursor`, `turning watching off removes what it read, and keeps
what work took in`). What a job woke on, or a situation cites, stays. A read
already under way when it is turned off keeps nothing it found (`a read in
flight when watching is turned off keeps nothing it found`). Turning it on again
starts watching afresh from then.

An observation that no job, situation or listening trigger holds is removed
after `MELETE_OBSERVATION_RETENTION_DAYS` days (14 by default), by one instance
at a time under the `observation-retention` lease (`observations nothing used go
after the retention period, on the leading instance only`). Mail an open wait on
an answer may still be checked against stays while the wait is open (`mail an
open wait on an answer may still need is kept while the wait is open`).

When an observation goes, its delivery key stays, with no word of what it said,
for `MELETE_OBSERVATION_TOMBSTONE_DAYS` days (180 by default), so a mailbox that
hands the same message back later is recognised (`a message read again after
its observation expired is not delivered twice`). Every read that starts again
after a provider lost its place (an Outlook delta link Graph no longer honours,
a Gmail history id it no longer keeps, an IMAP mailbox renumbered) goes back two
days at most (`a Graph delta it no longer honours is read again from two days
back, not from when watching began`).

A room's own accounts, such as a team mailbox, are watched only once the room's
owners turn the switch on (`a room account is not observed by default`). What
they report still reaches only the work the sharing rule gives them to.

A watched account is read every 5 minutes in its owner's day and every 30 at
night, by the day hours in their profile (`a watched account is read less often
in its owner's night`). A trigger that asks for more often
gets it (`poll_seconds`, never more often than once a minute). Melete's own
detectors listen too (see [What the detectors read](#what-the-detectors-read)):
a calendar a person connected for themselves while they have a device to reach
or a deadline on it, a mailbox while a message the person sent is waiting
on an answer. A Drive is read only for the files a deadline or a trigger
follows (see [Drive files](#drive-files)). An account nobody watches, and that no trigger or detector
listens to, is not read at all. Which accounts those are is decided from the
database alone. When an account stops being watched, its cursor and kept
fields go.

One service instance reads at a time, under the `signal-poller` lease, and opens
the connector of an account installed through another instance when that
account is first due. It reads a few accounts at once, claimed with `SKIP LOCKED`,
and each read has two minutes. An account that fails to answer is tried again
later: after the time it asked for when it sends `Retry-After`, otherwise less
often the longer it keeps failing. A request to slow down is about one account
and pauses that account alone (`a request to slow down from one account pauses
that account alone`). A timeout or a server error at three different accounts
of one provider in a row says the provider itself is in trouble: every account
read from it pauses, for five minutes and then longer if it keeps happening,
while accounts at other providers go on being read (`a provider in trouble
pauses its own accounts, and the others keep being read`). Its cursor stays where it was, so nothing it holds is skipped, and
`source_cursor.last_error` says in plain words why the
last read failed (`a provider asking for time is left alone that long; a stuck
or oversized read is skipped with a reason`, `a second instance without the
connector neither forgets the account nor misses its changes`). An account's
cursor row is written only when the account is read or its interval changes.

Every read goes through the connector's own read-only code. Mail is read by its
headers alone; bodies stay in the mailbox and are opened, when the work wants
them, with `email.read` and the `read_key` the observation carries. The inbox
hygiene the mail tools apply holds here too, and a stricter rule on the subject
line is added: a subject that names a code, a PIN, a passcode, a verification,
a sign-in or two-factor step, or that puts a 4 to 8 digit number beside such a
word, makes no observation (`a sign-in code message is never an observation`,
`every code-shaped subject is withheld, and ordinary mail is not`, `a code mail
is still dropped`). The rule
leans to withholding: a code mail missed costs little.

A read that changes hands mid-way is dropped. It remembers the connection's
generation when it starts, and nothing it found is delivered or kept once a
revocation or a switch of credential has moved that on (`what a read of an
older credential found is never delivered or kept`).

### Observations

Each change becomes an observation, delivered through the trigger service like
any other connector event:

```json
{
  "kind": "calendar.event.changed",
  "about": { "type": "calendar_occurrence", "key": "calendar:conn_…:abc@google.com:2026-10-07T16:00:00.000Z" },
  "occurred_at": "2026-10-04T18:20:11.000Z",
  "origin": "external_content",
  "title": "Design review",
  "start": "2026-10-07T18:00:00.000Z",
  "end": "2026-10-07T19:00:00.000Z",
  "location": "Room 2",
  "status": "confirmed",
  "attendees": 2,
  "changed": ["start", "end", "location"],
  "previous": { "start": "2026-10-07T16:00:00.000Z", "end": "…", "location": "Room 1" }
}
```

A `mail.received` observation carries the message's `message_id`, `read_key`,
`from`, `sender`, `sender_domain`, `subject`, `received_at`, `to_count`,
`in_reply_to` and `automated`. Both kinds are marked `external_content`: their
words were written by whoever sent the message or the invitation, and the work
that reads them is told so.

A `document.changed` observation carries the file's `file_id`, `name`,
`mime_type`, `modified_time`, `modified_by_me_time`, `last_modifier`,
`last_modifier_me`, `shared`, `trashed` and `removed`. A file's name and its
last editor's name are words people chose, so they are content, as a mail
subject is: the observation is marked `external_content`, it reaches only the
work the Drive serves, it goes with the account, and it is made only for a file
something follows. A file's contents are never
read; the scope Melete holds for Drive cannot read them.

Every observation carries a key made of what it is about and its state: a
message's Message-ID or provider id; an occurrence and a hash of its fields; a
file and a hash of its metadata. Ids
are hashed to a fixed length before they become keys, because an id is whatever
a provider or a sender chose, and the ids themselves travel clipped in the
observation. The trigger service keeps one event per key, so the same change
read twice, by two reads or after a cursor starts again, is one event
(`the same item from two polls is one event`). An item that cannot be delivered
is skipped and logged, and the rest of the read goes on (`an over-long id, or
one item that cannot be delivered, never stops an account`). A mailbox whose server renumbers
it (a new UIDVALIDITY) is read again for the last two days under the same keys
(`when the server renumbers the inbox, recent mail is read again under keys that
do not change`).

## Calendar occurrences

A calendar observation is about one occurrence: a weekly meeting is a separate
Tuesday each week, so moving one Tuesday changes only that one. An instance of a
series is named by the series and the start it was scheduled at, which stays
the same when the instance is moved.

For CalDAV collections, feeds and imported files, the service expands each
series itself: the rule (RRULE), extra dates (RDATE), removed dates (EXDATE), and
instances someone changed (a VEVENT with a RECURRENCE-ID), including one moved
into the window from a week the rule's own dates do not reach. Times written in a
named zone use the calendar's VTIMEZONE when it has one and the zone's IANA rules
when it does not, so 09:00 in New York lands on the right instant on either side
of a daylight-saving change (`a repeating event is its instances, with
exceptions, across a DST change`). A time inside the hour a spring-forward skips
is read with the offset before it, so 02:30 that morning is 03:30 daylight time,
and an hour that happens twice takes the first (`a time in the spring-forward
gap is read with the offset before the gap; a repeated hour takes the first`).
A series that began years ago is walked from just before the window, not from
its first instance (`a daily series that began decades ago still has its
instances in the window`). An all-day event keeps its date.

Expansion is held to one budget per read, across every series in it: 20,000
instances walked, 2,000 occurrences kept, two seconds, yielding to other work as
it goes. A feed or calendar that would go past it is skipped, with the reason in
`last_error`, and read again an hour later (`a feed of many minutely series is
refused within the budget, and other work keeps running meanwhile`). Google and
Microsoft Graph expand series themselves, and their instances are read the same
way (`instances of a series carry the series and their original start; a
cancelled one is placed at it`, `a series instance is named by the series and
its original start; a moved one keeps it`).

For each occurrence the service keeps a few fields in `subject_state`: title,
start, end, whether it is all day, place, status, guest count, and the event's
time zone. A read is compared with them:

| Kind | When |
| --- | --- |
| `calendar.event.created` | an occurrence appears that was not there before, inside the part of the window already watched |
| `calendar.event.changed` | a kept occurrence's fields differ; `changed` names them and `previous` holds what they were |
| `calendar.event.cancelled` | an occurrence is cancelled (`reason: cancelled`), or the provider says it no longer exists (`reason: removed`) |

When a read no longer lists an occurrence that has not ended, the service looks
it up again before saying anything: by its own id at Google and Microsoft Graph,
by its UID in a CalDAV collection or a feed. Gone is a cancellation; found
elsewhere, such as a meeting moved past the 14-day window, is a change; and when
the calendar says it cannot tell, nothing is said (`a meeting moved past the
window is a change, never a cancellation`, `an occurrence nobody can account
for leaves quietly`). A lookup that fails, or that did not fit in this read's 20
lookups, keeps the meeting and asks again on the next read, so a cancellation
still arrives (`a meeting whose lookup fails is asked about again, and its
cancellation arrives on the next read`). After three failed lookups, or once
the meeting's start has passed, it is let go with the reason in `last_error`.

An occurrence that only comes into view because the 14-day window moved on is
kept quietly, and one that has ended leaves quietly. A read that stopped before
the end of the window (too many occurrences to list) takes nothing past where
it stopped as removed (`a read that stopped early takes nothing past where it
stopped as removed`).

## Drive files

A Google Drive is connected through Google sign-in, on a step of its own the
first time a person keeps a deadline on a file (see
[mail-calendar.md](mail-calendar.md#signing-in-with-google)). A Drive is not
watched by default. It is read while a deadline is kept on one of its files, or
while that deadline's alert is open, and while a trigger listens to it. A
change to a file nothing follows is read past and dropped: no observation, no
name and no state is kept for it (`a Drive is not watched by default, and a file
nothing follows leaves no name or state`). A deadline follows its file; a
trigger follows the file its watch names in `about.key`, or every file when it
names none. Shared drives are read only while a deadline follows a file in one.

Its first read takes
Drive's current page token and lists nothing: watching starts then. Each later
read lists the files that changed since, up to 500 a read, a page at a time; a
read that reaches that number resumes from where it stopped, at the next tick
rather than after a full interval (`a read that stops at its limit is read
again at the next tick`). Drive lists a file
changed several times between two reads once, as it is now. A rate limit Drive
reports as a 403 is read as a request to wait, like a 429, and its
`Retry-After` is honoured (`a Drive asking for time is left alone that long`).
A page token Drive no longer honours starts the feed again from that moment.

The same change read twice is one event, and a later change to the same file is
another (`the same change from two polls is one event`).

For a file a deadline follows, `subject_state` keeps when it last changed,
when the person last changed it, whether the last change was theirs, and
whether it is shared or in the bin. It keeps no name and no editor. A removed or
binned file's state goes, and so does every file's once no deadline on it is in
force.

## Each connection's catalog

A trigger listens for one event name on one connection, and each kind of
connection lists the names it reports:

| Connection | Reports |
| --- | --- |
| A mailbox (IMAP, Gmail, Outlook) | `mail.received`, and `mail.new` for a reply to a chase |
| A calendar (CalDAV, a feed, Google, Outlook) | `calendar.event.created`, `calendar.event.changed`, `calendar.event.cancelled` |
| A Google Drive | `document.changed` |
| An agent's computer | `process.exited`, `process.output`, `process.listening` |
| A room | the hand-offs it settles |

A trigger on a name its connection never reports is refused when it is made,
with the names it does report, whether it comes from the API or from long work
setting what it stands on (`a watch on an event its connection never produces is
refused`).

## Who hears what

A connection's observations reach only the work the connection serves. In a
shared space, a connection marked for its owner serves only the owner's own
work, and one marked for the room serves only what people ask of the room. That
rule decides three times: a trigger on a connection that does not serve its job
is refused when it is made; an account is read only for triggers whose job it
serves; and each delivery checks the rule again for every waiting job, so a
trigger made before a connection stopped serving its job hears nothing more
(`a room member's job never receives the owner's mail observations`).

## Quiet costs nothing

An observation that matches no trigger, or fails every watch's test, wakes
nothing: no attempt, no model call, no notification
(`a hundred observations matching nothing make no situation and no model call`).
A watch can test the fields of a change directly, for example
`{ "field": "changed", "op": "contains", "value": "start" }` to wake only when a
meeting's time moves, so long work standing on a calendar wakes for the changes
it cares about and sleeps through the rest (`a standing run wakes on
calendar.event.changed`).

## Sorting what came in

New mail and calendar changes from accounts that serve their owner are sorted
for that one person into **needs you**, **for your information** or
**ignore**, each with a short reason, and Home's **Needs you** list shows the
ones that need them, most pressing first.

1. **Rules first.** Mail sent by a machine is settled as nothing to do, with
   no model call: a list, bulk or auto-submitted header; a no-reply sender in
   any spelling; an account, security, verify or alerts address; or a subject
   carrying a sign-in or verification code. Everything else is a maybe.
2. **A small model for the maybes.** Maybes are read in groups of up to
   twenty, one space and one person per call, with only what the observation
   carries: headers for mail (never a body), the kept fields for a meeting. The
   call asks for one JSON document and carries no tools. Each answer is read
   into one of the three labels and an urgency of `normal` or `soon`; an
   answer that is not one of those is not a label, and the item is asked about
   again later (`an unknown id, verdict or shape is not a label`). A group the
   privacy router keeps private is split and asked about in halves, so one
   sensitive item stays private and the rest are sorted (`one sensitive item
   stays private and the rest of its group is still sorted`).
3. **Once per version.** A label is kept for seven days per person, space,
   subject and a hash of the subject's words. The same message read again, or
   a meeting back in a state it was labelled in, takes that label with no call
   (`unchanged items are never sorted twice`).

Sorting only labels. It cannot make anything urgent (a deadline the person set
is the only way anything is), start work, send, notify or act: its code holds
a database handle and a model call that returns text, and imports nothing that
acts (`nothing in the sorting module imports what acts`); its urgency stops at
`soon` in the code and in the database (`the three that need the person come
first, with no action taken`).

Each call goes through the model gateway like any other: the privacy router
swaps details for placeholders, and a private space's items go to the
person's local model or nowhere (`a private space never reaches a cloud
model`). Each call is a background call on the `t1` step, charged to the
person whose items it reads, so their background limits apply. At a limit
nothing is sent and the items stay unsorted until it resets; nothing fails
(`at the background limit nothing is sent, nothing fails, and items wait`). An
installation without limits sorts without limits.

An item that could not be sorted (kept private, a limit, the model out of
reach or answering nonsense) stays unsorted: it is never filed as anything. It
is tried again after an hour, twice as long after each try that failed, at most
a day apart, and counted for its week on Home with the main reason
(`an outage or a nonsense answer leaves items unsorted, counted and retried,
never filed away`). Items and their copied headers are swept after a week, and
labels when they expire.

The model is `MELETE_MODEL_TRIAGE` when the operator names one (`off` turns
sorting off); otherwise the owner's secondary model when they moved scheduled
work to it; otherwise `MELETE_MODEL_FAST`; otherwise the model chosen in the
app. A model on the owner's own machine keeps the calls on it. One instance
sorts at a time, every `MELETE_TRIAGE_INTERVAL_SECONDS` (120 by default).

`GET /needs-you` lists, for the signed-in person, the items that need them and
what Melete noticed on its own, ranked urgent, then soon, then the rest; within
each, a deadline they set first, then what they have not seen, then the newest.
Each item has a plain sentence, the source it rests on (`because`, with the
observation's `event:<seq>` handle) and its urgency. `POST /needs-you/{id}/ack`
and `/dismiss` mark a sorted item seen or remove it. **Handle it** opens an
ordinary chat whose message names only the source (`Help me with this item from
my Home list (source event:<seq>).`). `POST /needs-you/{id}/source` writes the
source's headers or fields into a text file the message carries, so they reach
the agent fenced as untrusted data, never as the person's words (`an instruction
in a subject is attached as data, never said as the person`). Anything that
chat would do asks first.

Evidence: `apps/melete/test/integration/triage.test.ts` (a seeded inbox and
calendar of thirty-three changes, three of which need the person),
`apps/melete/test/integration/needs-you-source.test.ts` and
`apps/melete/src/triage/rules.test.ts`.

## Disconnecting

Revoking a connection removes, in the same step, its cursors, the fields kept
about its calendar, every observation it reported that no job took in, and the
situations and clocks that came from it with anything still waiting to be pushed
about them, and turns off the triggers that listened to it (`revoking an account
takes what was noticed in it and its clocks`) (`revoking a connection removes what
was read from it, in the same step`). Switching it to another credential
removes the cursors, the kept fields, its mail, calendar and Drive observations and
what was noticed in them the same way, and keeps the deadlines kept on it, which
read the account afresh as it now is (`switching an account’s credential keeps
the deadlines kept on it`). Removing a space removes all of these with the rest of the space. A
job's own record of what woke it stays with the job.

## Situations

A situation is something Melete noticed that may need the person. Four kinds
are built in, and each is decided by rules over the fields an account reported,
never by a model:

| Kind | When | How soon |
| --- | --- | --- |
| `meeting.changed` | one of the person's meetings with other people on it moved, changed place or was cancelled, and it starts, or was to start, within a day | soon |
| `meeting.conflict` | two of the person's confirmed, timed meetings overlap, and at least one has other people on it; the same event seen on two calendars is one meeting | soon within a day, otherwise on Home |
| `deadline.at_risk` | a deadline's time has come and a fresh look says it is still unmet, or it could not be checked in time | urgent, soon or on Home (below) |
| `reply.overdue` | a message the person sent asking for something, found by the waiting-on rules, has had no answer three days on | on Home |

A meeting is the person's when they organise it or accepted it. An invitation
they have not answered, said maybe to, or declined raises nothing, so someone
outside cannot fill their phone by sending invitations (`an invitation the
person has not accepted is not their meeting`). Google Calendar and Microsoft
Graph say how the account answered; for a feed or a CalDAV collection, which
cannot, what it lists is taken as the person's.

A situation is for one person: the owner of the account it came from, or
whoever set the deadline. A room's shared accounts raise none. Its title and
reason are Melete's own words, with times in the person's own zone ("It now
starts Tue 3:00 PM; it was Tue 2:00 PM."), and a due date given as a day alone
is said as that day ("Due Sat, Oct 10"; `a commitment due on a date is due
until that day ends where the person is, and named by its day`). What the
account said, such as a meeting's title or place, travels beside it as evidence
and never becomes Melete's words, so an invitation titled "URGENT: call this
number" says nothing in Melete's voice (`a meeting with others that moved within
a day is soon, in Melete’s own words`). Each carries the handles of what raised
it: the observation, or the clock.

There is one live situation per person, space, kind, subject and moment, so two
people keeping a deadline on the same document each have their own (`two people
keeping a deadline on the same subject each keep their own`). Each sighting has
a fingerprint of what makes it what it is: a meeting's times and place, both
meetings' times for an overlap, a due time. The same fingerprint again changes
nothing, so a calendar read every few minutes does not rewrite an overlap that
has not changed. A different one folds in, counted, with the newest evidence,
and is not told again unless it became more urgent (`a meeting that moves within
a day wakes the work watching it, once`). An overlap is named by its two
meetings in a fixed order, so it is one situation whichever side is read first,
and it ends when the meetings part (`a conflict between two meetings is one
situation, not two, and ends when they part`). A situation ends when what it was
about stops being true: the answer came, the commitment was settled, the
meetings no longer overlap. After its moment it expires.

The person can say they saw it (`POST /situations/{id}/ack`) or that it was not
useful (`POST /situations/{id}/dismiss`); either stops anything still waiting to
be pushed about it. A dismissed situation stays dismissed: it comes back only
when its fingerprint changes, such as one of two overlapping meetings moving,
and with no new push before then. `GET /situations` lists the live ones.

Mail that answers a message the person is waiting on ends its `reply.overdue`
at once, by the waiting-on rule: a reply in the thread, anything from the person
asked, or a colleague of theirs on the same subject; an automatic reply answers
nothing (`a wait on a reply is raised for Home, and settles when the answer
arrives`). Before a wait is raised, Melete looks again through the mail it has
already read since the message was sent, and it raises a wait only when it was
watching the mailbox from soon after the waiting-on list found it: silence from
a mailbox nobody was reading proves nothing (`a wait answered before its clock
was set, or found before Melete watched the mailbox, is not raised`). A space
with no mailbox connected lets its waits go, with the reason on the clock.

### Deadlines and clocks

A clock is a time Melete keeps to look at something again. A deadline has one:
at its due time less a lead, Melete reads the subject again, from its source
when the source can be read (a document's own state, a meeting looked up at the
calendar), and evaluates the deadline's test against what it read. Done, and
the clock settles quietly. Still unmet, and `deadline.at_risk` is raised
(`a deadline is checked against fresh state at its time, once`, `a deadline met
before its time says nothing`). A source that cannot be read is tried again a
minute later while there is time; one still unread by its due time is marked
missed, and when the deadline is the person's they are told that Melete
couldn't check it in time, never that it is undone (`a source that cannot be
read is tried again, and is never raised on stale state`).

A fresh read follows the same rules as a read work makes through the broker.
The account must be active and not part way through a revocation or a switch of
credential, in the deadline's space, serving the work the deadline belongs to
(or, with no work, owned by the person), and its tools must be open to that
work's compartment. Otherwise nothing is read. If the account's credential
changes while it is read, what was read is dropped and the clock waits for the
next look (`a fresh read is refused when the account is being revoked, is
elsewhere, or serves someone else`). A deadline cannot be set on an account or a
subject outside the person's space, or on an account that does not serve them.
What a fresh read returns is tested and dropped: it is not kept, handed to work,
or shown to a model, so the privacy router, which governs what models see, has
nothing to decide.

There is one live clock per person, deadline and subject. Setting a deadline
again moves its clock. A deadline that follows a meeting's time, such as "an
hour before the board meeting", moves when the meeting moves and is cleared when
the meeting is cancelled (`a meeting moved twice has one live clock, at its new
time`, `a cancelled meeting’s clocks are cleared`). The due time is taken again
from each fresh read too, so a meeting that moves while its deadline is being
checked leaves one clock, at the new time, and nothing raised for the old one
(`a meeting that moves while its deadline is being checked leaves one clock, at
the new time`). A clock fires once: it goes on to its next look, or to fired, in
the transaction that raises its situation, and only if it was not moved while it
was read, so two sweeps at once raise one situation. Clocks are swept every
minute, and a clock due within ten minutes is also timed in the service itself.
The watch language gains what clocks need: `before` and `after` (a time against
now plus seconds), `older_than` (an age in seconds), one `any` group, and, for
clocks alone, `absent` (nothing of a kind seen since).

Deadlines come from two places today. Work can keep one for the person
(`SituationService.setDeadline`). And a commitment the companies map found with
a due date has one. Until the person takes it up it is shown on Home and not
pushed. Once they press "Handle it" in Melete it is theirs: a due date with a
time is looked at a day before and again fifteen minutes before, and that last
look can reach them at once, at any hour (`pressed by the person, it reaches
them fifteen minutes before it is due, even in quiet hours`). Taken up by an
outside assistant over MCP instead, it stays one Melete found (`pressed by an
outside assistant, it stays one Melete found: on Home, never urgent`).

A due date with no time, which is how most dates in mail are written, is never
taken as a time. It is due at 17:00, the end of a working day, on that date
where the person is. It is looked at the day before and on the morning of the
day, at the start of the person's day, and at most it is `soon`: it never
breaks quiet hours, and a look that would fall in them waits for the morning
(`a commitment due on a date is due at the end of that working day, looked at
only inside the person’s day, and never urgent`, `a look at a date-only
commitment that would fall outside the person’s day waits for the morning`).
The same holds for a deadline work keeps with a date alone.

#### A deadline on a document

"The contract must be signed by 3 p.m." is a deadline on a Drive file.
`POST /situations/deadlines` keeps one for the signed-in person, on the Drive
of the space the session speaks for:

```json
{
  "file": "https://docs.google.com/document/d/1AbC…/edit",
  "title": "Get the contract signed",
  "due_at": "2026-10-05T15:00:00-07:00",
  "lead_seconds": 300,
  "by": "others"
}
```

`file` is the file id or a Docs, Sheets, Slides or Drive link to it, and the
file is looked up once when the deadline is set. Drive's metadata cannot say a
file was signed, so `by` names the change that ends the deadline:

- `me`: the person changed the file at or after `since`. Drive keeps this per
  person, so a collaborator's edit never counts.
- `others`: the file changed at or after `since`, and Drive names the last
  change as someone else's. A change by an editor Drive does not name, such as
  an anonymous link or an app, is unknown and leaves the deadline at risk
  (`a change by an editor Drive does not name stays at risk`).

`since` is the moment the deadline is set unless given, and is never later than
now (`a since later than now, or after the due time, is refused`).

Only the look at `due_at` less `lead_seconds` settles a deadline: Melete reads
the file as Drive has it then. Changed as asked, the deadline is met and nothing
is raised. A change read earlier settles nothing by itself (`a file edited before
the deadline is settled only by the look at its time`). Otherwise
`deadline.at_risk` is raised; set by the person and within fifteen minutes of
its time, it is urgent and can reach them at once (`a document deadline whose
file is untouched at T−lead raises at-risk, checked fresh at fire time`). When
the file changed since, but not in the way asked, the alert says so and asks
whether it is done, at `soon` rather than urgent (`an edit of another kind than
the one asked for never settles it, and makes the alert a question`). A file
removed or moved to the bin before the look is raised too, saying so (`a file
removed or moved to the bin before its look is raised, not let go`). An alert
that went out is resolved as soon as the file then changes as asked, so no later
reminder reaches the person about something done (`an alert that went out is
resolved when the file then changes as asked`).

With no Drive connected in the space, the answer is `409 documents_not_connected`
with the words the person is shown: Melete needs to see the Drive files' names,
change times and sharing, never their contents, and asks Google for that once
more (`with no Drive connected, a deadline on a file says what Google will be
asked for, and why`). The deadline is kept on the file's own subject key, so
work handling the file hears about it: naming `job_id`, such as the work
"Handle it" started, links that work to the file (`a deadline links the work
handling the file, and only on an account the person uses`). Set through an
outside assistant over MCP, it is shown and never urgent. While a deadline is
kept on one of its files, the Drive is read every five minutes, and every minute
in the hour before a look. Work can keep the same deadline with
`SituationService.setDocumentDeadline`.

Pressing "Handle it" again moves the deadline to the date the item has now; once
the person has pressed it, it stays theirs whoever presses after (`pressing
Handle it again moves the deadline to the date the item has now, and keeps it
the person’s`). A rescan that moves a commitment's date moves its deadline, and
one that takes the commitment off the list clears it (`a rescan that moves a
commitment moves its clock, and one that removes it clears it`).

### How soon the person hears

Only a deadline the person set or accepted can be urgent, and only when it is
within fifteen minutes; nothing a detector reads on its own can be, and the
database refuses an urgent situation, or an urgent push, that is not the
person's (`only a deadline the person set or accepted, and close, is urgent`).
Pushes are paced in three lanes, each with its own daily count:

| Urgency | Waits for company | A day, at most | Quiet hours |
| --- | --- | --- | --- |
| normal | the batching window (10 minutes by default) | the person's daily cap (4 by default) | held |
| soon | a minute | 6 | held |
| urgent | not at all | 3 | held, unless the deadline is one the person set or accepted |

An urgent push is sent the moment its situation is raised, not at the next
minute's pass. A push past its lane's count waits in the lane below, and counts
against the lane it goes out in, so no lane's cap can be stepped round: a whole
day of soon situations reaches the phone ten times at most (`a whole day of
pushes keeps every lane to its cap, whatever spills`, `urgency lanes`). A
situation kept for Home sends no push (`an urgent deadline the person set pushes
now, even in quiet hours; one they didn’t set waits`). A push about a situation
carries where to say it was seen, and tapping it tells Melete so. A push about a
situation that was resolved, dismissed or removed before it went out is not
sent.

### Reaching work

Work names the subjects it cares about: a watch on one subject (`about.key`
equal to its key) links its job to that subject, and work that sets a deadline
is linked to it. A new situation about a linked subject reaches that work, in
the same space, for the same person, and only work that every account it names
serves under the sharing rule: an overlap names both calendars (`a conflict
reaches linked work only when that work may read both calendars`). Work waiting
on a trigger wakes with the situation as an operation event
(`situation.<kind>`); one situation wakes one piece of work at most once in five
minutes, and anything else reads it at its next wake. The attempt it wakes
records the situation beside the trigger, and every model call that attempt
makes is counted against both in `model_usage`.

A detector runs inside the delivery of each observation, in a savepoint of its
own: one that fails is undone and reported, and the observation, and every wake
it made, still go through (`a detector that fails undoes only itself: the
observation is delivered and work still wakes`).

### What the detectors read

A calendar is read for the detectors only while there is someone to tell or
something to keep: while its owner has a device to reach, or while a deadline
is kept on it. It is read every five minutes in the person's day, every thirty
minutes outside it, and every minute while a deadline on it is due within the
hour (`a calendar is read for the detectors only while there is someone to tell,
and less at night`). A mailbox is read while a wait on a reply is watched in its
space or still open on Home. These reads are the poller's reads: they share its
budget, its backoff and a provider's Retry-After with every other read of the
account.

### Off

`MELETE_DETECTORS=false` turns the built-in detectors off for an installation.
Calendars are then read only when some work listens to them, and only deadlines
that work sets are kept.

## Evidence

- `apps/melete/test/integration/signals.test.ts`: reading, de-duplication, the
  catalog, the sharing rule, standing work woken by a calendar change, and
  nothing read for an account nobody listens to with watching off (`with
  watching off, nobody listening means nothing is read and nothing is kept`).
- `apps/melete/test/integration/default-observation.test.ts`: accounts watched
  by default, the switch, rooms, and code mail withheld on that path too.
- `apps/melete/src/signals/occurrences.test.ts`: recurrence expansion with
  EXDATE, RDATE, moved and cancelled instances, and time zones.
- `apps/melete/src/signals/observations.test.ts`: how a read becomes created,
  changed and cancelled observations, and what a mail observation carries.
- `apps/melete/src/connectors/signals-providers.test.ts`: Google Calendar,
  Graph `calendarView`, Gmail history, Graph mail delta and IMAP UIDs against
  recorded answers.
- `apps/melete/test/integration/situations.test.ts`: deadlines checked fresh
  and once, missed rather than stale, urgency and quiet hours, whole-day lane
  caps, fresh reads refused, deadlines per person, clocks that follow a meeting
  even mid-check, conflicts and dismissals, waking linked work, replies,
  detector faults, what the detectors read, revocation and switching.
- `apps/melete/test/integration/situations-commitments.test.ts`: "Handle it"
  by the person, and by an outside assistant, over the real route; date-only
  due dates; pressing again; rescans.
- `apps/melete/test/integration/documents.test.ts`: a Drive read through the
  Drive connector against a stand-in Drive: the consent answer, deadlines
  settled only by the look at their time, edits of another kind, unnamed
  editors, removed files, alerts resolved after a change, nothing kept for files
  nothing follows, capped reads, `since`, one event per change, Retry-After,
  linking work, and revocation clearing what was read.
- `apps/melete/test/integration/google-sign-in.test.ts`: the Drive step adds
  Drive beside an account's mail and calendar, which keep their ids.
- `apps/melete/src/connectors/google-drive.test.ts`: Drive's change feed, page
  limits, shared drives only on request, rate limits, the Drive sign-in step,
  the fresh look, the status tool, observation keys, and the `me` and `others`
  rules.
- `apps/melete/src/situations/detectors.test.ts` and
  `apps/melete/src/push/policy.test.ts`: the detectors' rules and the urgency
  lanes as plain functions.
- `packages/contracts/src/watch.test.ts`: `before`, `after`, `older_than`,
  `any` and `absent`.
- Conformance 12, [`12-deadline-fresh-check.test.ts`](../conformance/scenarios/12-deadline-fresh-check.test.ts):
  a deadline is checked against fresh state at its time, once.
