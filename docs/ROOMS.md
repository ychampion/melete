# Rooms

A room is a shared space where several people talk to one agent. People talk
in threads, every message shows who wrote it, and the agent answers when it is
asked. The agent acts as the room: it reads only what the room has, and it
never acts as any one person in it.

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
messages first (`DELETE /rooms/{id}/messages/{message}`). The room's owner
cannot be removed.

In a room every person is shown as the name they chose followed by the handle
the room gives them, as in `Alice <k7q2mx3a>`, to the people in the room and
to its agent. The handle is what tells people apart: nobody chooses it, nobody
can take someone else's, and it differs from room to room. No label in a room
carries any part of an email: someone who has not chosen a name is shown as
`Someone` with their handle. People who are not guests also see each other's email in the
room's list of people (`GET /rooms/{id}`). Each person sets their name with
`PATCH /me`: one line of plain text, without `<`, `>` or `@` or anything that
reads as one, and not a name someone else already goes by.

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

A thread's page (`GET /rooms/{id}/threads/{thread}`) shows every message with
its author, and each request with its answer, cards and receipts. Its live
stream (`GET /rooms/{id}/threads/{thread}/events` with
`Accept: text/event-stream`) sends messages and the agent's work in order, and
resumes from `Last-Event-ID`. A room view says who is looking at it with a
heartbeat (`POST /rooms/{id}/presence`); presence is shown, and decides
nothing about who may read.

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

A room's requests act only through the connections marked for the room. Its own
tools (files, the web, its computer) are marked so from the start. Any other
connection in the room's space serves only the owner's own work there until an
owner marks it for the room (`PUT /rooms/{id}/connections/{connection}` with
`shared_use: "room"`); everyone in the room can see the connections
that serve the room (`GET /rooms/{id}/connections`); owners also see the ones
kept for them. Changing what a connection
serves starts work under way in the room again and withdraws the permissions
waiting in it.

## What the agent reads in a room

For a request, the agent reads:

- the room agent's own persona and standing instruction;
- the room's skills and knowledge that are shared with its members;
- the thread, with each person's name on what they said, and the answers to the
  thread's other requests;
- the room's memory: what people said in the room, with who said it;
- details people chose to share into the room from their own memory, each
  marked with who shared it;
- the request itself, and who asked it.

Beyond the details people shared, it reads nothing from anyone's personal
space: no personal memory, no personal files, no personal chats and no personal
connections. A room's own tools and the connections marked for the room are the
only ones its requests use.

## Memory in a room

Everything anyone says in a room's threads becomes the room's memory, under the
name of the person who said it. Everyone in the room sees it, with whose words
each detail rests on (`GET /rooms/{id}/memory`). A room's owner can forget any
detail, and anyone can forget a detail that came from their own words alone, in
the room or in plain words ("forget that"). Deleting one's own message takes its
words out of the thread, the request it asked and the room's memory.

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

When the people in a room change, work under way in it starts again with the
new roster, and permissions its requests were waiting on are withdrawn. The
requests someone asked end when they leave, since only they could answer them
(a turn under way stops), and an ask of theirs still waiting its turn is dropped.

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
