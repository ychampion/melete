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
