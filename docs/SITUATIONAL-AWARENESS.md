# Noticing what changes

Melete keeps watch over the mail and calendar accounts a person connects. When
new mail arrives or a meeting moves, the work that is waiting for it wakes, once,
with what changed in front of it. When nothing changes, nothing runs and nothing
is spent.

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

Each account and stream (its mail, its calendar) has one cursor in
`source_cursor`: where the feed was last read, when to read it next, and how the
last reads went. A first read starts the cursor at the account's present
state; what was already there is where watching begins, not news.

An account is read while some live trigger listens for one of its kinds, as
often as the most frequent of those triggers asks (`poll_seconds`, 300 by
default, never more often than once a minute). Which accounts those are is
decided from the database alone. When nobody listens to an account any more,
its cursor and kept fields go.

One service instance reads at a time, under the `signal-poller` lease, and opens
the connector of an account installed through another instance when that
account is first due. It reads a few accounts at once, claimed with `SKIP LOCKED`,
and each read has two minutes. An account that fails to answer is tried again
later: after the time it asked for when it sends `Retry-After`, otherwise less
often the longer it keeps failing. Its cursor stays where it was, so nothing it
holds is skipped, and `source_cursor.last_error` says in plain words why the
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
`every code-shaped subject is withheld, and ordinary mail is not`). The rule
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

Every observation carries a key made of what it is about and its state: a
message's Message-ID or provider id; an occurrence and a hash of its fields. Ids
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
the lookup cannot tell, nothing is said (`a meeting moved past the window is a
change, never a cancellation`, `an occurrence nobody can account for leaves
quietly`).

An occurrence that only comes into view because the 14-day window moved on is
kept quietly, and one that has ended leaves quietly. A read that stopped before
the end of the window (too many occurrences to list) takes nothing past where
it stopped as removed (`a read that stopped early takes nothing past where it
stopped as removed`).

## Each connection's catalog

A trigger listens for one event name on one connection, and each kind of
connection lists the names it reports:

| Connection | Reports |
| --- | --- |
| A mailbox (IMAP, Gmail, Outlook) | `mail.received`, and `mail.new` for a reply to a chase |
| A calendar (CalDAV, a feed, Google, Outlook) | `calendar.event.created`, `calendar.event.changed`, `calendar.event.cancelled` |
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

## Disconnecting

Revoking a connection removes, in the same step, its cursors, the fields kept
about its calendar, and every observation it reported that no job took in, and
turns off the triggers that listened to it (`revoking a connection removes what
was read from it, in the same step`). Switching it to another credential
removes the cursors, the kept fields and its mail and calendar observations the
same way. Removing a space removes all of these with the rest of the space. A
job's own record of what woke it stays with the job.

## Evidence

- `apps/melete/test/integration/signals.test.ts`: reading, de-duplication, the
  catalog, the sharing rule, standing work woken by a calendar change, and
  nothing read for an account nobody listens to (`nobody listening means nothing
  is read and nothing is kept`).
- `apps/melete/src/signals/occurrences.test.ts`: recurrence expansion with
  EXDATE, RDATE, moved and cancelled instances, and time zones.
- `apps/melete/src/signals/observations.test.ts`: how a read becomes created,
  changed and cancelled observations, and what a mail observation carries.
- `apps/melete/src/connectors/signals-providers.test.ts`: Google Calendar,
  Graph `calendarView`, Gmail history, Graph mail delta and IMAP UIDs against
  recorded answers.
