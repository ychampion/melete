# Rooms

A room is a shared space where several people talk to one agent. People talk
in threads, every message shows who wrote it, and the agent answers when it is
asked. The agent acts as the room: it reads only what the room has, and it
never acts as any one person in it.

## Turning rooms on

Rooms are a preview behind one setting, `MELETE_PREVIEW_MULTIPLAYER`, which is
off by default. Set `MELETE_PREVIEW_MULTIPLAYER=true` in `deploy/.env` and
recreate the service to turn on everything on this page: rooms, shared spaces,
members, invites and guests, a room's own accounts and approval settings,
hand-offs, the `room.*` tools, and chat platform accounts linked to rooms.

While it is off:

- the routes on this page, `POST /spaces/shared` and
  `POST /spaces/{id}/memberships` answer `404` with the code `not_available`;
- agents are offered no `room.*` tool, and new spaces are given none;
- a guest cannot sign in, and no room request is started;
- the web app shows no Rooms section, invite pages, hand-offs or "Share to a
  room" action, and `GET /setup` reports `multiplayer: false`.

Nothing stored is changed or removed. Turning the setting on again brings back
every room, member and message as it was.

## Making a room and adding people

Anyone with an account makes a room with a name and, if they like, a purpose
(`POST /rooms`). The person who makes it owns it. A room starts with its own
agent (Melete, unless the room's owner gives it another), its own files and its
own tools, and on a Docker installation its own computer.

An owner adds people who have accounts on this installation
(`POST /rooms/{id}/members`, from the list at `GET /people`). An owner can
remove someone, and anyone can leave (`DELETE /rooms/{id}/members/{person}`).
Removing someone ends their access at once, including any thread they have
open. What they said stays in the room; each person can delete their own
messages first (`DELETE /rooms/{id}/messages/{message}`). The person who made
the room cannot be removed.

A room can have more than one owner. An owner adds someone as an owner
(`POST /rooms/{id}/members` with `role: "owner"`), or makes someone already in
the room an owner, or an owner a member again
(`PATCH /rooms/{id}/members/{person}` with `role: "owner"` or `"member"`).
Adding someone already in the room without a role leaves their role as it is. The
owners an owner adds run the room as its maker does: they add and remove
people, invite guests, set how the room works and answer what the room leaves
to its owners. Three things stay with the person who made the room: they
always stay an owner, only they remove the room for everyone, and a connection
kept for them serves only their work, so only they see, test or change it,
read its texts or share it with the room. Texts to a number speak as the
person who made the room, so only they add a texting number to it, and it is
kept for them; a number shared with the room no longer answers texts. The room's memory, and the skills and records kept
private to it, read for the other owners as they do for its members; so does
the room when one of them works in it from their own session or assistant, so
the maker's home, tasks and conversations there stay the maker's. Deleting
another owner's account leaves the room, as any member's does. A
room always keeps at least one owner. Each change of role moves that person's
membership generation on, so work of theirs under way checks again with what
they may now do. A guest stays a guest.

In a room the service labels every person with the name they chose followed by
the handle the room gives them, as in `Alice <k7q2mx3a>`, and the room's agent
reads them that way. The handle is what tells people apart for the agent:
nobody chooses it, nobody can take someone else's, and it differs from room to
room. No label in a room carries any part of an email: someone who has not
chosen a name is labelled `Someone` with their handle. People who are not
guests also see each other's email in the room's list of people
(`GET /rooms/{id}`).

The web app shows a person by their name and, after it in angle brackets, a
tell that stays theirs in every room: the part of their email before the @
when the reader can see emails, or else a four letter code made from their
account. The tell always shows where it matters who someone is: who may answer
a permission and who answered it, who asked, and the room's list of people.
Elsewhere, in messages, the thread list and the board, a name shows alone
unless two people the room knows of, there now or since left, have names that
read alike; then each shows its tell. Hovered or read aloud, every name
carries its tell.

Each person sets their name with `PATCH /me`: one line of plain text, without
`<`, `>` or `@` or anything that reads as one, and without characters that show
as nothing (the default ignorable characters and the Hangul fillers), so no
name can carry a tell or a handle of its own or hide a difference. It is
refused when it reads as the name of someone the person shares a room with, or
as the part before the @ of their email; everyone a room has had counts,
members, guests and people who have left, so a name cannot be taken over once
its owner leaves. A guest's name is compared the same way with the room they
join, and someone who already has an account joins a room, added by an owner or
through an invite, only while their name reads as no one's that room has had;
otherwise they are asked to change it first. Reads as means the same after `nameSkeleton`
(`@melete/contracts/name-skeleton`): NFKC, lower case, invisible characters
dropped, spaces collapsed, and a short table of Cyrillic, Greek, Lisu, Cherokee
and Latin letters that look like Latin ones read as those, so Alice spelled
with a Cyrillic or a fullwidth A is Alice. The web app decides which names read
alike by a looser fold, `clashSkeleton`, which also reads `I`, `l`, `1` and `|`
as one letter and `rn` as `m`. That fold would join ordinary names such as Eli
and Ell, so it only makes both names show their tells; it never refuses one.

## Guests

An owner can invite someone from outside the installation as a guest: an email
and a number of days, 30 unless the owner says otherwise
(`POST /rooms/{id}/invites`). Melete shows the invite link once, and the owner
sends it themselves. The link uses the installation's public address
(`MELETE_PUBLIC_URL`) when one is set; the path that comes with it opens the
same page on any address the installation answers at.

Opening the link shows the room's name and nothing about its people. The guest
chooses a password and lands in that room. A link works once, and stops working
when its days are up or an owner withdraws it
(`DELETE /rooms/{id}/invites/{invite}`); owners see every invite and its state
at `GET /rooms/{id}/invites`. Someone who is already a guest here accepts a new
room's invite while signed in, so a link never sets an existing account's
password. Someone with a full account here is added from People instead.

A guest:

- reads and posts in the rooms they were invited to, and asks the agent where
  the room allows guests to ask (`guests_may_ask`);
- never answers a permission: a guest's own request is answered by the room's
  owners;
- has no people list, no space of their own, makes no rooms, starts no work
  and connects no assistant; every route outside their rooms, their own account
  and a room's files is refused with `guests_use_rooms`;
- is never handed a room's task to run with their own setup, and their requests
  hand none to anyone (see With your own setup);
- sees no one's email.

A guest's place in a room ends when the invite's days are up. From that moment
they read nothing in it, and within a minute their membership ends the way a
removal does: work under way starts again, and the requests they asked end.
While a guest is in a room, details shared there as members-only stay out of
the agent's work (see Memory in a room). Adding a guest changes who reads the
room, so work under way starts again with the new roster.

## Threads and asking the agent

A thread starts with its first message (`POST /rooms/{id}/threads`), and
anyone in the room replies (`POST /rooms/{id}/threads/{thread}/messages`). A
message asks the agent when:

- it names an agent: `@Melete`, or `@` and the name of another agent the room
  has. The agent it names first answers that message; the request's next
  message goes back to the room's agent unless it names one again;
- it starts a thread with `ask_agent`;
- it follows straight on from the agent's answer to the same person.

Every other message is conversation between people. The agent reads it later
as part of the thread, and it starts no work.

Each ask is its own request, attributed to the person who asked. A person's
follow-ups reach their own request, and nobody else's words ever do. A thread
works on one request at a time: an ask made while another request in the thread
is under way waits its turn, and starts as soon as that request answers or
stops to wait for something. The person who asked, or a room owner, can stop a
request (`POST /rooms/{id}/requests/{request}/stop`).

Longer work a room request starts belongs to the room, not to the person who
asked. A room owner, signed in to the room, wakes it with words for its next
shift, pauses it, resumes it or stops it with the usual run routes
(`POST /runs/{id}/message`, `/pause`, `/resume` and `/stop`). A member or a
guest is refused, and someone outside the room finds nothing.

A request that ends on a question in words shows as answered, since its asker
answers by replying in the thread. A request shows as waiting on someone only
for what the thread shows them to decide: a permission, or a step whose outcome
is not yet known. To ask anyone other than the asker, the agent puts the
question on the board for them (see The board).

A thread's page (`GET /rooms/{id}/threads/{thread}`) shows every message with
its author, and each request with its answer, cards and receipts. Its live
stream (`GET /rooms/{id}/threads/{thread}/events` with
`Accept: text/event-stream`) sends messages and the agent's work in order, and
resumes from `Last-Event-ID`. A room view says who is looking at it with a
heartbeat (`POST /rooms/{id}/presence`); presence is shown, and decides
nothing about who may read.

A message can carry photos and files: upload each to `POST /rooms/{id}/attachments`
and name it in the message's `attachments`. Everyone in the room reads them
(`GET /rooms/{id}/attachments/{file}/content`), except in a summaries-only room
(below); someone removed from the room, or never in it, does not. An ask hands
them to its request, and the room's model reads a photo itself, or the
operator's vision model (`MELETE_MODEL_VISION`) takes the call and answers it.
Where neither can read photos, an ask with one is refused with a plain sentence
saying so, and the photo can still be posted without asking. A guest attaches
files only where guests may ask.

In a room set to "Show me only what needs me", a posted file is read as it is
only by the person who posted it and the room's maker. Everyone else sees what
kind of file it is and its id, with no name, size or pages, in the thread and
its live stream, and `content` (and its `preview`) answers `403 summaries_only`.
They read it with `POST /rooms/{id}/attachments/{file}/original`, which notes
the open in the room's activity, naming who opened what kind of file, before a
byte is sent; if the note cannot be written, nothing is sent. The same person
opening the same file again within a few minutes is one note. The room's request
still reads every file.

## Permissions in a room

When a request needs permission (posting to people through the room's
connection, adding an event to the room's calendar), its card appears in the
thread for everyone in the room. The card names who asked and who may answer it
(`requested_by` and `eligible_approvers`), and only those people can choose
Allow or Deny. Who may answer is the room's rule:

- `requester` (the default): the person who asked;
- `any_member`: anyone in the room who is not a guest;
- `owners`: the room's owners.

Guests never answer a permission, and nor does the room's agent. Where the
rule is `requester` and a guest asked, the room's owners answer instead.
Auto-review never answers a room's permission either: whatever the room's
settings, the people the rule names decide. Work that stays in the room's own
workspace (the files it works on, its computer) follows the same sandbox rule
as a person's own work. Saving a new file to the room's files, and publishing
an app from the room, wait for the people the rule names. An answer is
given at `POST /rooms/{id}/approvals/{approval}` with the card's `version` and
the exact content's `payload_hash`; if either has changed, it is refused and
the card is shown again. The answer is checked against the rule and the room's
people as they are at that moment, and recorded as the person who gave it: the
thread shows who answered each permission. A permission is answered once, here;
a standing "always" rule is never made from a room, since it would answer for
everyone's requests.

When someone leaves, the permissions waiting in the room are withdrawn, and
each request is told it was refused. A request whose asker has left ends with
them. A decision push goes to the people who may answer it, and to nobody else.

### What the room's own accounts send

The accounts a room's owners add for the room, such as a shared mailbox or a
team calendar, are its team accounts: connections in the room's space marked
for the room, other than the tools every room has. What the agent sends or
changes through one of them follows the room's team-account rule
(`team_account_approvers`), whatever the room's general rule says:

- `any_member` (the default): anyone in the room who is not a guest, the
  person who asked included;
- `owners`: the room's owners.

Adding an event to a member's explicitly shared personal calendar asks only
that member, whatever either room rule says. Everything else a request asks
permission for follows the general rule above.
Guests never answer under either rule, auto-review never answers, and the card,
the decision push and the agent all name the people the rule for that action
names. A room created before this setting existed keeps `owners` for its team
accounts when its general rule was already `owners`. Covered by
`a member approves another member's send through a team account, whatever the
room's general rule`, `the person who asked approves their own team-account
send under the any-member rule`, `a guest never approves a team-account send,
under either team-account rule, even their own`, `under the owners'
team-account rule only owners approve a team-account send, and only they are
told`, `an action outside the team accounts still follows the room's general
rule` and `when approvers leave, a team-account permission is withdrawn and the
request is told`.

### Values someone else typed

A value the person who asked typed in their own request (a recipient, an
address, an amount) counts as theirs for that request. A value someone else in
the thread typed is shown as theirs: it carries a warning on the asker's card,
naming who typed it, and no saved rule ever lets it through without asking.
When auto-review looks at a room's request, the instruction it judges against
is the asker's own words; what other people said in the thread reaches it
labelled with their names, never as the instruction.

## How a room works

An owner sets how the room works (`PUT /rooms/{id}/policy`); everyone in the
room reads it (`GET /rooms/{id}/policy`, and in `GET /rooms/{id}`):

- `approvers`: who answers permissions, as above;
- `team_account_approvers`: who answers what the room's team accounts send,
  `any_member` (the default) or `owners`;
- `agent_turns`: `asked` (the default) or `every_message`, where every message
  asks the agent, which uses more of the model;
- `guests_may_ask`: whether a guest's message can ask the agent;
- `requests_per_hour` (30) and `requests_per_person_hour` (10): asks the room,
  and each person in it, may make in an hour. An ask past either limit is
  refused with `429`; the message can be sent again later, or sent without
  asking.

The agent is told who answers its request's permissions, so it can say who it
is waiting for.

## Connections in a room

A room's requests use the connections marked for the room and the limited
calendar shares its members explicitly allow. Its own
tools (files, the web, its computer) are marked so from the start. A connection
an owner installs into the room's space (`space_id` set to the room's space)
serves the room from the start too: everyone's requests in the room can use it
as soon as it is installed, with nothing more to switch on. An owner can keep
one for their own work there instead, or share it with the room again
(`PUT /rooms/{id}/connections/{connection}` with `shared_use: "owner"` or
`"room"`); everyone in the room can see the connections
that serve the room (`GET /rooms/{id}/connections`); the person who made the
room also sees the ones kept for them. Only the person who made the room changes what a connection
serves, since one kept back serves only their work. Changing what a connection
serves starts work under way in the room again and withdraws the permissions
waiting in it.

Each member can share one calendar connection from their own space in the
room's settings (`PUT /rooms/{id}/calendar-shares`). The room reads it through
`room.member_freebusy` as busy time blocks only, without event titles, locations
or attendees. The `freebusy` mode permits only this read. With `freebusy_add`,
`room.add_to_member_calendar` can add an event after that member approves the
exact event. Other members and owners cannot approve for them, whatever the
room's approval rules say. Read-only calendar feeds cannot allow additions.
Sharing gives the room no other access to the connection. The room's own work
is told which members share a calendar now and which of those take new events.

`GET /rooms/{id}/calendar-shares` shows only the signed-in member's share and
their own calendar choices. `DELETE /rooms/{id}/calendar-shares` revokes that
share. Leaving the room ends access too. Each tool call checks the share and
membership again, so requests already running cannot keep reading or adding
events after access ends. Rejoining requires a new share. Guests cannot share
a personal calendar.

A room's connections are held to public addresses, because its requests come
from everyone in it. A team that runs its own MCP servers, calendars or mail on
an internal network can open those to rooms with `MELETE_PRIVATE_HOSTS`; see
[Internal hosts](CONNECTORS.md#internal-hosts).

## What the agent reads in a room

For a request, the agent reads:

- the room agent's own persona and standing instruction;
- the room's skills and knowledge that are shared with its members;
- the thread, with each person's name on what they said, and the answers to the
  thread's other requests;
- the room's memory: what people said in the room, with who said it;
- details people chose to share into the room from their own memory, each
  marked with who shared it;
- free/busy blocks from calendars members explicitly shared with the room;
- the request itself, and who asked it.

Beyond the memory details and revocable calendar shares people explicitly
allow, it reads nothing from anyone's personal space: no other personal memory,
files, chats or connections. A shared personal calendar is read as free/busy
only. Its event titles, locations and attendees stay private, and adding an
event requires the calendar member's approval.

## Memory in a room

Everything anyone says in a room's threads becomes the room's memory, under the
name of the person who said it. Everyone in the room sees it, with whose words
each detail rests on (`GET /rooms/{id}/memory`).

That includes who is taking on what and by when ("I'm taking the vendor
contract review, done by Thursday"), which a personal chat would treat as one
week's work and not keep. Anyone in the room can ask "who's on the vendor
contract?" later, in any of its threads, and the agent reads the detail with
the name of the person who said it. It stays in that room: other rooms and
each person's own memory never see it.

A room's owner can forget any detail, and anyone can forget a detail that came
from their own words alone, in the room or in plain words ("forget that").
Deleting one's own message takes its words out of the thread, the request it
asked and the room's memory.

A person can share a detail from their own memory into a room
(`POST /rooms/{id}/shares`). The room reads it from the person's memory as it
is now, so forgetting it there takes it out of the room at once. Shares are
members-only unless the person says otherwise: while a guest is in the room,
the agent does not read them. The person who shared a detail, or an owner,
withdraws it (`DELETE /rooms/{id}/shares/{share}`). Every removal here holds
after a restore from an older backup. [MEMORY](MEMORY.md#rooms) has the
details.

## With your own setup

A room's agent cannot use anyone's mail, calendar, files or memory. When a
request needs one of those ("send this summary from my email to Bob"), the agent
hands the task to a person instead: the person who asked, unless it names
someone else in the room who is not a guest.

The person finds it on their Home and with their approvals (`GET /handoffs`):
the room, who asked, and the whole task, word for word. They choose "Run with my
setup" or "Decline" (`POST /handoffs/{id}`). Running it starts work in their own
space with exactly that text, as their own agent and using their own
connections; anything it sends or changes asks them wherever their agent would,
and an address or amount the task names is shown on their card as coming from
the room. Accepting names the task's hash, so only the task they read
runs. A handoff nobody answers within seven days is withdrawn, and so is one
whose request was stopped or ended. Only a request from a member hands work to
anyone; a guest's request never reaches a person's own setup. A person has at
most three handoffs from one room waiting for them, and one request hands out
at most three. Handing a task over needs no answer in the room, since the
person's own acceptance is the answer; a room whose owners set approvals to ask
for everything asks for this too.

When the work finishes, they see the exact result and choose to share it with
the room or keep it (`POST /handoffs/{id}/result`). Sharing posts that text to
the thread as theirs, "via Melete"; keeping posts only that they kept it. Either
way, and on a decline or a withdrawal, the room's request hears how it ended and
goes on. Once shared or kept, the result is no longer stored with the handoff. A
result not shared or kept within seven days is cleared, and so is one waiting
when the person forgets something in their own memory or removes their space;
it can no longer be shared, and the room hears only that it is gone.

From their own chats, a person can also post to a room they are in
(`room.post`: the card shows the room, the thread and the exact text) or copy a
checked file into the room's files (`room.add_file`: the room keeps its own
copy). Each waits for their approval, appears in the room as theirs, and is
refused once they have left the room. A person's own work can list the rooms
they are in, and learns nothing of any other room.

## Who sees what

Only the people in a room read it, the installation's owner included: someone
who is not in a room finds no room at all. A guest reads only the rooms they
were invited to, while their invite lasts. A room's requests belong to the
room, so they never appear in anyone's own chats, plans, approvals or job
lists; they are read through the room's routes only. Files a request makes are
read by the people in the room. Everyone in the room can watch the room's
computer (`GET /rooms/{id}/requests/{request}/computers` finds it), and only the
room's owners take it over.

The person who made a room can set it to show only what needs its people
(`PUT /spaces/{id}/summaries-only`). Then the cards, receipts and live stream of
its requests name what each step touched by its kind ("An email", "An event"),
never an original's subject, address or words, for everyone but that person.

This holds in code, not only in the agent's instructions, so it holds whatever
the model writes:

- **What the model reads.** For a request that anyone but the room's maker
  asked (and for work nobody asked, such as a wake on new mail), the details
  of the room's mail, events and files reach the model as placeholders by
  role: `[doctor 1]`, `[pharmacy 1]`, `[phone number 2]`, `[medicine 1]`. That
  covers who wrote or was invited, their addresses, the people a message names,
  account, member and prescription numbers, street addresses and medicine. The
  same detail is the same placeholder on every turn, and placeholders are never
  put back. Dates, amounts, what kind of thing each item is and what it says
  stay, so the agent can still summarise ("a doctor's appointment next Tuesday",
  "a bill of $72.10 due November 12"). The request's own instructions and tool
  definitions go as written.
- **What the agent does.** A step that carries a placeholder out of the room,
  such as an event, an email or a file, is refused before it runs and nothing
  is written. The model is told the step needs the room's maker, so it says
  so. Steps that stay in the room (its board, asking someone in it) go ahead,
  and each person reads them checked as below.
- **What people read.** Before anyone but the maker reads the agent's answers,
  its cards and receipts, the board items it made (and the push that announces
  one), or the room's live stream, any of those details still in them is put in
  words: "the doctor", "a phone number", "an account number". So is a street
  given without its town, part of a number, a subject repeated three or more
  meaningful words at a time, and a quote of eight or more words of a message.
  Names and addresses match in any case, and numbers with any separators. A
  streamed answer is checked whole, so a name cut across two pieces is caught,
  and words still being written that could begin a name or a number wait for
  the rest.
  The request's receipts then say how many details were kept out ("Kept 2
  private details out of this answer").

The details come from the receipts of the room's own reads of its mail,
calendars and files over the last 30 days (the 200 most recent), each read
taken in once it has finished, in whatever order reads finish. A sender's
display name counts only whole ("Google Calendar" is not "calendar"), and mail
from an automated address such as `notifications@` names a service, not a
person. The names and addresses of the room's people are never among them. The maker, whose accounts they are, reads
everything as before, and so does the model for the maker's own requests.

When the people in a room change, work under way in it starts again with the
new roster, and permissions its requests were waiting on are withdrawn. The
requests someone asked end when they leave, since only they could answer them
(a turn under way stops), and an ask of theirs still waiting its turn is dropped.

## The board

A room keeps a board of dated items: events, tasks, questions and notes. Each
item can be assigned to one person in the room who is not a guest, and says who
sees it:

| Visibility | Who sees it |
|---|---|
| `everyone` | Everyone in the room, guests included |
| `owners` | The room's owners |
| `assignee` | The person it is assigned to, and the room's owners |

The service applies this rule in the query that reads the board, so a member
sees items for everyone and the items assigned to them, a guest sees items for
everyone, and an owner sees everything. The same rule holds for the room's
board (`GET /rooms/{id}/board`), its live stream
(`GET /rooms/{id}/board/events`, resumable with `Last-Event-ID`, closed the
moment the reader leaves the room) and `GET /board`, which shows the items from
every room the signed-in person is in (`?mine=1` keeps the open items assigned
to them, `from` and `to` keep a window of dates). A room you are not in
contributes nothing.

People claim a task or an event (`POST .../board/{item}/claim`; one claim
stands, and a second gets 409), mark it done (`.../done`) and answer a question
put to them (`.../answer`). Guests read the board and change nothing on it.
Only the person a question asks can answer it. The answer is posted in the
room as that person's own message to the agent, in the thread the question was
asked in, so the agent goes on as a new request of theirs. A question is always
put to one person, so the message does not repeat its words in the thread; the
agent reads the question with the answer, and when the person's shared calendar
takes new events, it is told it can offer to add what they took on.

The room's agent has five tools for the board: `board.list`, `board.add`,
`board.update`, `board.ask` and `board.note`. They change only the room's own
board and ask nobody. The agent reads the board as the person whose request it
is working on would see it, and changes only what that person can see; a
request from a guest reads the board and changes nothing. It assigns items only
to people in the room who are not guests. A note is always for its person
alone. A question or a note sends a push to that person only, paced like any
other push and held in their quiet hours.

A question is for its person and the owners (`assignee`) unless the agent
asks for everyone, and once a request has read someone's shared calendar,
every question it asks stays with its person. A room has no question card of
its own, so when the agent asks the person whose request it is with
`ask_person`, the question goes on the board for them, under the same rule,
and their answer comes back in the request's thread.

Times on the board are read and written as wall times in the room's time zone
(`2026-11-06T09:00`, with `time_zone` alongside in `board.list`), so an item
moved to another day keeps its time of day when the clocks change in between.
A time written with its own offset is taken as given.

When someone leaves the room, items assigned to them read as unassigned and a
claim of theirs reads as open again. Titles are written by the agent, so `board.add` tells it
to keep the titles of items for everyone short and free of private detail.

## Talking to a room from a chat platform

A room can be reached from a chat platform as well as from the web. Each
platform plugs in as a surface with three doors: people's messages come in,
the room's messages, answers, cards and decisions go out, and people answer
the room's permissions. The web uses the same doors, so every rule on this page
holds on a platform too.

A platform account speaks only for the person it is linked to. The platform
links an account after its own sign-in proves who holds it; Melete keeps the
link for that platform alone and never moves it to someone else. Then:

- their messages appear in the room under their own label, whatever name the
  platform shows;
- they answer a permission only where the room's rule names them, and a guest
  keeps a guest's limits;
- what goes out to them is the threads of the rooms they are in, and it stops
  when they leave the room or the account is unlinked;
- a message written on another platform reaches them with that platform's
  name, never its own id for the message.

A person sees the accounts linked to them (`GET /me/linked-accounts`) and
unlinks any of them (`DELETE /me/linked-accounts/{provider}/{account}`).
Changing or resetting their password unlinks them all.

An account with no link is refused: it cannot post, answer or follow a thread,
and it never becomes a guest.
