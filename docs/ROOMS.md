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
open. What they said stays in the room. The room's owner cannot be removed.

In a room every person is shown as the name they chose followed by their email,
as in `Alice <alice@example.com>`, to the people in the room and to its agent.
The email is what tells people apart. Each person sets their name with
`PATCH /me`: one line of plain text, without `<`, `>` or `@`, and not a name
someone else already goes by.

## Threads and asking the agent

A thread starts with its first message (`POST /rooms/{id}/threads`), and
anyone in the room replies (`POST /rooms/{id}/threads/{thread}/messages`). A
message asks the agent when:

- it names the agent: `@Melete`, or `@` and the agent's own name;
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

Guests never answer a permission, and nor does the room's agent. An answer is
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
`shared_use: "room"`); everyone in the room can see which connections there are
and what each serves (`GET /rooms/{id}/connections`). Changing what a connection
serves starts work under way in the room again and withdraws the permissions
waiting in it.

## What the agent reads in a room

For a request, the agent reads:

- the room agent's own persona and standing instruction;
- the room's skills and knowledge that are shared with its members;
- the thread, with each person's name on what they said, and the answers to the
  thread's other requests;
- the request itself, and who asked it.

It reads nothing from anyone's personal space: no personal memory, no personal
files, no personal chats and no personal connections. A room's own tools and
the connections marked for the room are the only ones its requests use.

## Who sees what

Only the people in a room read it, the installation's owner included: someone
who is not in a room finds no room at all. A room's requests belong to the
room, so they never appear in anyone's own chats, plans, approvals or job
lists; they are read through the room's routes only. Files a request makes are
read by the people in the room. Everyone in the room can watch the room's
computer (`GET /rooms/{id}/requests/{request}/computers` finds it), and only the
room's owners take it over.

When the people in a room change, work under way in it starts again with the
new roster, and permissions its requests were waiting on are withdrawn. The
requests someone asked end when they leave, since only they could answer them
(a turn under way stops), and an ask of theirs still waiting its turn is dropped.
