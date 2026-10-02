/**
 * Rooms, in memory: shared spaces where several people talk to one agent in
 * threads. The signed-in demo account is one person among a few others on the
 * installation. A message that names the agent (`@Melete`, or `@` and the
 * agent's name), a thread started as an ask, or a straight follow-up to the
 * agent's answer to the same person starts a scripted request, streamed on the
 * thread's live frames like the service streams it. A thread works on one
 * request at a time; a later ask waits its turn. Every body is parsed with the
 * contract on the way in and out.
 */
import * as C from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppDeps } from './app.ts';
import { newId } from './store.ts';

type Account = { id: string; email: string; created_at: string };
type Person = { id: string; email: string; display_name: string | null; created_at: string };
type Role = 'owner' | 'member' | 'guest';
type Message = z.infer<typeof C.roomMessage>;
type Turn = z.infer<typeof C.conversationTurn>;
type Status = Turn['status'];
type Request = {
  job_id: string;
  requested_by: string;
  status: Status;
  turns: Turn[];
  cards: z.infer<typeof C.resultCard>[];
  receipts: z.infer<typeof C.experienceReceipt>[];
  timer?: ReturnType<typeof setTimeout>;
};
type Thread = {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  last_activity_at: string;
  messages: Message[];
  requests: Map<string, Request>;
};
type Room = {
  id: string;
  name: string;
  purpose: string | null;
  created_at: string;
  agent_name: string;
  members: Map<string, Role>;
  threads: Map<string, Thread>;
};
type Frame = z.infer<typeof C.roomStreamFrame>;
type FrameInput =
  | { kind: 'message'; message: Message }
  | { kind: 'request'; request_job_id: string; event: unknown };

const UNDER_WAY = new Set<Status>(['queued', 'working', 'streaming']);

/** Others with an account on this installation. */
const OTHERS: { email: string; display_name: string }[] = [
  { email: 'priya.shah@fastmail.example', display_name: 'Priya Shah' },
  { email: 'sam.okafor@fastmail.example', display_name: 'Sam Okafor' },
  { email: 'lena.brandt@fastmail.example', display_name: 'Lena Brandt' },
];

class RoomError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The name a person goes by, then their email: how a room shows everyone. */
const nameOf = (person: Person) => person.display_name?.trim() || person.email.split('@')[0] || '';
const labelOf = (person: Person) => `${nameOf(person)} <${person.email}>`;

/** The same reading of a mention as the service's. */
function asksAgent(text: string, agentName: string): boolean {
  const lower = text.toLowerCase();
  const names = [...new Set(['melete', agentName.trim().toLowerCase()])].filter(Boolean);
  const word = /[\p{L}\p{N}_]/u;
  return names.some((name) => {
    for (let at = lower.indexOf(`@${name}`); at >= 0; at = lower.indexOf(`@${name}`, at + 1)) {
      const before = lower[at - 1];
      const after = lower[at + name.length + 1];
      if (
        (before === undefined || !(word.test(before) || before === '@' || before === '.')) &&
        (after === undefined || !word.test(after))
      )
        return true;
    }
    return false;
  });
}

const mentionsIn = (text: string) =>
  [...text.matchAll(/(?:^|[^\w@])@([\p{L}\p{N}_.-]+)/gu)]
    .map((match) => match[1]?.replace(/[.-]+$/, '') ?? '')
    .filter(Boolean);

/** What the scripted agent says back: plain, short, and about the ask it was given. */
function answerFor(text: string, asker: string, thread: Thread): string {
  const ask = text.replace(/@[\p{L}\p{N}_.-]+/gu, '').trim();
  const others = new Set(thread.messages.map((m) => m.author.principal_id)).size - 1;
  return [
    `Here is where “${thread.title}” stands, ${asker}.`,
    '',
    `- You asked: ${ask.slice(0, 160) || 'for a summary'}`,
    `- ${others > 0 ? `${others} other ${others === 1 ? 'person has' : 'people have'} weighed in` : 'Nobody else has weighed in yet'}, and I read the whole thread first.`,
    '- I saved the notes to the room’s files, so everyone here can open them.',
  ].join('\n');
}

export function mountRoomsMock(
  app: Hono,
  deps: AppDeps,
  session: { account: () => Account | null; signedOut: () => boolean; profileName: () => string },
) {
  const now = () => deps.store.now().toISOString();
  const speed = deps.experienceSpeed ?? 1;
  const people = new Map<string, Person>();
  const rooms = new Map<string, Room>();
  const frames = new Map<string, Frame[]>();
  const seen = new Map<string, string>();
  const present = new Map<string, Map<string, number>>();
  /** The demonstration's other people, shown as looking at a room while the demo runs. */
  const demoHere = new Map<string, Set<string>>();
  /** Each message's submission id, so a retried post is answered with the first. */
  const submissions = new Map<string, Message>();
  let seq = 0;

  for (const other of OTHERS) {
    const id = newId('own');
    people.set(id, { id, created_at: now(), ...other });
  }
  const byEmail = (email: string) => [...people.values()].find((p) => p.email === email);

  /** The signed-in person, as a room sees them. */
  const me = (): Person => {
    if (session.signedOut()) throw new RoomError(401, 'unauthorized', 'A session is required.');
    const account = session.account();
    if (!account) throw new RoomError(401, 'unauthorized', 'A session is required.');
    const known = people.get(account.id);
    if (known) return known;
    const person = { ...account, display_name: null };
    people.set(account.id, person);
    return person;
  };
  const person = (id: string): Person =>
    people.get(id) ?? {
      id,
      email: 'someone@invalid.example',
      display_name: 'Someone',
      created_at: now(),
    };
  const author = (id: string) => ({ principal_id: id, display_name: labelOf(person(id)) });

  /** A room the caller is in; anyone else finds no room at all. */
  const roomFor = (id: string, viewer: Person): Room & { role: Role } => {
    const room = rooms.get(id);
    const role = room?.members.get(viewer.id);
    if (!room || !role) throw new RoomError(404, 'not_found', 'That room is not here.');
    return Object.assign(room, { role });
  };
  const threadIn = (room: Room, id: string) => {
    const thread = room.threads.get(id);
    if (!thread) throw new RoomError(404, 'not_found', 'That thread is not here.');
    return thread;
  };

  const push = (thread: Thread, frame: FrameInput) => {
    seq += 1;
    const list = frames.get(thread.id) ?? [];
    list.push(C.roomStreamFrame.parse({ ...frame, seq }));
    frames.set(thread.id, list);
  };
  const pushMessage = (thread: Thread, message: Message) =>
    push(thread, { kind: 'message', message });
  const pushEvent = (thread: Thread, request: Request, item: Record<string, unknown>) =>
    push(thread, {
      kind: 'request',
      request_job_id: request.job_id,
      event: {
        seq: seq + 1,
        conversation_id: request.job_id,
        turn_id: request.turns.at(-1)?.id ?? null,
        created_at: now(),
        item,
      },
    });

  const summary = (room: Room, role: Role, viewer: Person) => {
    const since = seen.get(`${room.id}:${viewer.id}`) ?? room.created_at;
    const unread = [...room.threads.values()]
      .flatMap((thread) => thread.messages)
      .filter(
        (message) => message.author.principal_id !== viewer.id && message.created_at > since,
      ).length;
    return {
      id: room.id,
      name: room.name,
      purpose: room.purpose,
      my_role: role,
      unread,
      created_at: room.created_at,
    };
  };
  const presentIn = (room: Room) => {
    const here = present.get(room.id) ?? new Map<string, number>();
    const cutoff = Date.now() - 60_000;
    const ids = new Set([
      ...[...here.entries()].filter(([, at]) => at >= cutoff).map(([id]) => id),
      ...(demoHere.get(room.id) ?? []),
    ]);
    return [...ids].filter((id) => room.members.has(id));
  };
  const detail = (room: Room, role: Role, viewer: Person) => {
    const here = new Set(presentIn(room));
    return C.roomDetail.parse({
      room: { ...summary(room, role, viewer), agent_name: room.agent_name },
      members: [...room.members.entries()].map(([id, memberRole]) => ({
        principal_id: id,
        display_name: labelOf(person(id)),
        role: memberRole,
        ...(role === 'guest' ? {} : { email: person(id).email }),
        present: here.has(id),
      })),
      policy: { approvers: 'requester', agent_turns: 'asked', guests_may_ask: true },
    });
  };
  const threadView = (room: Room, thread: Thread) =>
    C.roomThread.parse({
      id: thread.id,
      room_id: room.id,
      title: thread.title,
      created_by: author(thread.created_by),
      created_at: thread.created_at,
      last_activity_at: thread.last_activity_at,
      archived_at: null,
    });
  const requestView = (request: Request) =>
    C.roomRequest.parse({
      job_id: request.job_id,
      requested_by: author(request.requested_by),
      status: request.status,
      turns: request.turns,
      cards: request.cards,
      receipts: request.receipts,
    });

  const makeRoom = (name: string, purpose: string | null, owner: string, at = now()) => {
    const room: Room = {
      id: newId('sp'),
      name,
      purpose,
      created_at: at,
      agent_name: 'Melete',
      members: new Map([[owner, 'owner']]),
      threads: new Map(),
    };
    rooms.set(room.id, room);
    return room;
  };
  const addMessage = (
    thread: Thread,
    authorId: string,
    text: string,
    at = now(),
    extra: Partial<Message> = {},
  ): Message => {
    const message = C.roomMessage.parse({
      id: newId('rmg'),
      thread_id: thread.id,
      author: author(authorId),
      kind: 'person',
      via_agent: false,
      text,
      mentions: mentionsIn(text),
      request_state: 'none',
      request_job_id: null,
      created_at: at,
      ...extra,
    });
    thread.messages.push(message);
    thread.last_activity_at = at;
    return message;
  };
  const replace = (thread: Thread, message: Message) => {
    const index = thread.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) thread.messages[index] = message;
    pushMessage(thread, message);
  };

  const held = (thread: Thread) =>
    [...thread.requests.values()].some((request) => UNDER_WAY.has(request.status));

  /** Start the request a message asked for, and play the agent's answer onto the stream. */
  const start = (room: Room, thread: Thread, message: Message) => {
    const request: Request = {
      job_id: newId('job'),
      requested_by: message.author.principal_id,
      status: 'queued',
      turns: [],
      cards: [],
      receipts: [],
    };
    const turn: Turn = {
      id: newId('turn'),
      conversation_id: request.job_id,
      agent_id: newId('agt'),
      text: message.text ?? '',
      answer: '',
      status: 'queued',
      delivery: 'sending',
      created_at: now(),
    };
    request.turns.push(turn);
    thread.requests.set(request.job_id, request);
    replace(thread, { ...message, request_state: 'started', request_job_id: request.job_id });
    const setStatus = (status: Status) => {
      request.status = status;
      turn.status = status;
      turn.delivery = status === 'queued' ? 'sending' : null;
      pushEvent(thread, request, {
        type: 'status',
        status,
        composer: UNDER_WAY.has(status) ? 'stop' : 'send',
      });
    };
    const words = answerFor(message.text ?? '', nameOf(person(request.requested_by)), thread).split(
      /(?<= )/,
    );
    const steps: (() => void)[] = [
      () => setStatus('working'),
      ...words.map((piece, index) => () => {
        if (index === 0) setStatus('streaming');
        turn.answer += piece;
        pushEvent(thread, request, { type: 'text_delta', text: piece });
      }),
      () => {
        const card = C.resultCard.parse({
          id: newId('card'),
          title: `Notes on ${thread.title}`,
          meta: `${room.name} · room files`,
          facts: [
            { label: 'About', value: thread.title },
            { label: 'Saved as', value: 'notes.md' },
          ],
          primary_action: null,
          secondary_actions: [],
          source_connection: null,
        });
        request.cards.push(card);
        pushEvent(thread, request, { type: 'card', card });
        const receipt = C.experienceReceipt.parse({
          id: newId('rcpt'),
          what: 'Saved notes.md to the room’s files',
          where: `${room.name} files`,
          when: now(),
        });
        request.receipts.push(receipt);
        pushEvent(thread, request, { type: 'receipt', receipt });
      },
      () => {
        setStatus('done');
        release(room, thread);
      },
    ];
    const run = (index: number) => {
      if (request.status === 'stopped') return;
      const step = steps[index];
      if (!step) return;
      step();
      if (speed === 0) run(index + 1);
      else request.timer = setTimeout(() => run(index + 1), (index < 2 ? 500 : 70) * speed);
    };
    run(0);
    return request;
  };
  /** The next ask waiting its turn in a thread starts once nothing holds the thread. */
  const release = (room: Room, thread: Thread) => {
    if (held(thread)) return;
    const next = thread.messages.find((m) => m.request_state === 'pending');
    if (next) start(room, thread, next);
  };

  /** Whether a message follows straight on from the agent's answer to its author. */
  const followsAnswer = (thread: Thread, authorId: string) => {
    const last = thread.messages.at(-1);
    if (!last || last.author.principal_id !== authorId || !last.request_job_id) return false;
    const request = thread.requests.get(last.request_job_id);
    return Boolean(request && !UNDER_WAY.has(request.status));
  };

  const post = (room: Room, thread: Thread, viewer: Person, text: string, ask: boolean) => {
    const asks = ask || asksAgent(text, room.agent_name) || followsAnswer(thread, viewer.id);
    let message = addMessage(thread, viewer.id, text, now(), {
      request_state: asks ? 'pending' : 'none',
    });
    pushMessage(thread, message);
    if (asks && !held(thread)) {
      const request = start(room, thread, message);
      message = thread.messages.find((m) => m.id === message.id) ?? message;
      return { message, request_job_id: request.job_id };
    }
    return { message, request_job_id: null };
  };

  /** A demonstration room with people, a finished ask and a conversation in it. */
  const seedDemo = () => {
    const self = me();
    if (session.profileName()) self.display_name = session.profileName();
    const priya = byEmail('priya.shah@fastmail.example');
    const sam = byEmail('sam.okafor@fastmail.example');
    if (!priya || !sam) return;
    const day = (offset: number, minutes = 0) =>
      new Date(deps.store.now().getTime() - offset * 86_400_000 + minutes * 60_000).toISOString();
    const launch = makeRoom(
      'Spring launch',
      'Plans and copy for the spring release',
      self.id,
      day(6),
    );
    launch.members.set(priya.id, 'member');
    launch.members.set(sam.id, 'member');
    const thread: Thread = {
      id: newId('rth'),
      title: 'Pricing page copy',
      created_by: priya.id,
      created_at: day(1),
      last_activity_at: day(1),
      messages: [],
      requests: new Map(),
    };
    launch.threads.set(thread.id, thread);
    addMessage(
      thread,
      priya.id,
      'The pricing page still says “starter”. Should we rename it?',
      day(1),
    );
    addMessage(thread, sam.id, 'I’d keep it. People search for it.', day(1, 4));
    const ask = addMessage(
      thread,
      self.id,
      '@Melete can you pull together what we decided about the plan names?',
      day(1, 9),
      { request_state: 'started' },
    );
    const request: Request = {
      job_id: newId('job'),
      requested_by: self.id,
      status: 'done',
      turns: [
        {
          id: newId('turn'),
          conversation_id: '',
          agent_id: newId('agt'),
          text: ask.text ?? '',
          answer:
            'Here is what this thread settled:\n\n- **Starter** keeps its name; Sam pointed out people search for it.\n- Priya’s rename question is open for the other two plans.\n\nI saved these notes to the room’s files.',
          status: 'done',
          delivery: null,
          created_at: day(1, 9),
        },
      ],
      cards: [
        C.resultCard.parse({
          id: newId('card'),
          title: 'Plan names: what was decided',
          meta: 'Spring launch · room files',
          facts: [
            { label: 'About', value: 'Pricing page copy' },
            { label: 'Saved as', value: 'plan-names.md' },
          ],
          primary_action: null,
          secondary_actions: [],
          source_connection: null,
        }),
      ],
      receipts: [
        C.experienceReceipt.parse({
          id: newId('rcpt'),
          what: 'Saved plan-names.md to the room’s files',
          where: 'Spring launch files',
          when: day(1, 10),
        }),
      ],
    };
    const firstTurn = request.turns[0];
    if (firstTurn) firstTurn.conversation_id = request.job_id;
    thread.requests.set(request.job_id, request);
    const index = thread.messages.indexOf(ask);
    thread.messages[index] = { ...ask, request_job_id: request.job_id };
    addMessage(thread, priya.id, 'Thanks. I’ll take the other two to the team.', day(0, -40));

    const studio = makeRoom('Book club', 'What we read next, and when we meet', priya.id, day(12));
    studio.members.set(self.id, 'member');
    const pick: Thread = {
      id: newId('rth'),
      title: 'October pick',
      created_by: priya.id,
      created_at: day(2),
      last_activity_at: day(2),
      messages: [],
      requests: new Map(),
    };
    studio.threads.set(pick.id, pick);
    addMessage(pick, priya.id, 'Two votes for the short one. Anyone against?', day(2));
    seen.set(`${launch.id}:${self.id}`, day(0, -60));
    demoHere.set(launch.id, new Set([priya.id]));
  };

  /* ---------- routes ---------- */

  const answer = <T extends z.ZodType>(schema: T, body: unknown, status: 200 | 201 = 200) =>
    Response.json(schema.parse(body), { status });
  const route =
    (handler: (c: Context) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      try {
        return await handler(c);
      } catch (error) {
        if (error instanceof RoomError)
          return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: error.status },
          );
        const issues = (error as { issues?: unknown }).issues;
        if (Array.isArray(issues))
          return Response.json(
            { error: { code: 'invalid_request', message: 'Check the information and try again.' } },
            { status: 400 },
          );
        throw error;
      }
    };
  const body = async (c: Context) => c.req.json().catch(() => ({}));
  const param = (c: Context, name: string) => c.req.param(name) ?? '';

  app.get(
    '/me',
    route(() => {
      const self = me();
      return answer(C.ownerResponse, {
        owner: { id: self.id, email: self.email, created_at: self.created_at },
      });
    }),
  );
  app.patch(
    '/me',
    route(async (c) => {
      const self = me();
      const input = C.updateMeRequest.parse(await body(c));
      const name = input.display_name;
      if (name !== null) {
        const taken = [...people.values()].some(
          (p) =>
            p.id !== self.id &&
            (p.display_name?.toLowerCase() === name.toLowerCase() ||
              p.email.split('@')[0]?.toLowerCase() === name.toLowerCase()),
        );
        if (taken)
          throw new RoomError(
            409,
            'name_taken',
            'Someone here already goes by that name. Choose another.',
          );
      }
      self.display_name = name;
      return answer(C.meResponse, {
        owner: {
          id: self.id,
          email: self.email,
          created_at: self.created_at,
          display_name: self.display_name,
        },
      });
    }),
  );
  app.get(
    '/people',
    route((c) => {
      me();
      const query = C.peopleQuery.parse(c.req.query()).query?.trim().toLowerCase() ?? '';
      return answer(C.peopleList, {
        people: [...people.values()]
          .filter(
            (p) => !query || `${p.email} ${p.display_name ?? ''}`.toLowerCase().includes(query),
          )
          .sort((a, b) => a.email.localeCompare(b.email))
          .map((p) => ({ id: p.id, display_name: nameOf(p), email: p.email })),
      });
    }),
  );
  app.get(
    '/rooms',
    route(() => {
      const viewer = me();
      const list = [...rooms.values()]
        .filter((room) => room.members.has(viewer.id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((room) => summary(room, room.members.get(viewer.id) ?? 'member', viewer));
      return answer(C.roomList, { rooms: list });
    }),
  );
  app.post(
    '/rooms',
    route(async (c) => {
      const viewer = me();
      const input = C.createRoomRequest.parse(await body(c));
      const room = makeRoom(input.name, input.purpose?.trim() || null, viewer.id);
      return answer(C.roomDetail, detail(room, 'owner', viewer), 201);
    }),
  );
  app.get(
    '/rooms/:id',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      return answer(C.roomDetail, detail(room, room.role, viewer));
    }),
  );
  app.post(
    '/rooms/:id/members',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      if (room.role !== 'owner')
        throw new RoomError(403, 'scope_denied', 'Only an owner of this room can do that.');
      const input = C.addRoomMemberRequest.parse(await body(c));
      const added = people.get(input.principal_id);
      if (!added) throw new RoomError(404, 'not_found', 'That person is not here.');
      if (!room.members.has(added.id)) room.members.set(added.id, 'member');
      return answer(
        C.roomMembershipResponse,
        {
          member: {
            principal_id: added.id,
            display_name: labelOf(added),
            role: room.members.get(added.id),
            email: added.email,
            present: false,
          },
        },
        201,
      );
    }),
  );
  app.delete(
    '/rooms/:id/members/:principalId',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const target = param(c, 'principalId');
      if (room.role !== 'owner' && target !== viewer.id)
        throw new RoomError(403, 'scope_denied', 'Only an owner of this room can do that.');
      if (room.members.get(target) === 'owner')
        throw new RoomError(409, 'owner_stays', 'The room’s owner stays in the room.');
      if (!room.members.has(target))
        throw new RoomError(404, 'not_found', 'That person is not in this room.');
      room.members.delete(target);
      // The requests they asked end with them, as in the service.
      for (const thread of room.threads.values())
        for (const request of thread.requests.values())
          if (request.requested_by === target && UNDER_WAY.has(request.status)) {
            clearTimeout(request.timer);
            request.status = 'stopped';
            const last = request.turns.at(-1);
            if (last) last.status = 'stopped';
          }
      return answer(C.roomLeaveResponse, { removed: target });
    }),
  );
  app.get(
    '/rooms/:id/threads',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const list = [...room.threads.values()]
        .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
        .map((thread) => threadView(room, thread));
      return answer(C.roomThreadList, { threads: list });
    }),
  );
  app.post(
    '/rooms/:id/threads',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const input = C.createRoomThreadRequest.parse(await body(c));
      const at = now();
      const thread: Thread = {
        id: newId('rth'),
        title: input.title?.trim() || input.text.split('\n')[0]?.trim().slice(0, 200) || 'Thread',
        created_by: viewer.id,
        created_at: at,
        last_activity_at: at,
        messages: [],
        requests: new Map(),
      };
      room.threads.set(thread.id, thread);
      const posted = post(room, thread, viewer, input.text, input.ask_agent === true);
      return answer(C.roomMessageResponse, { thread: threadView(room, thread), ...posted }, 201);
    }),
  );
  app.get(
    '/rooms/:id/threads/:threadId',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const thread = threadIn(room, param(c, 'threadId'));
      seen.set(`${room.id}:${viewer.id}`, now());
      return answer(C.roomThreadView, {
        thread: threadView(room, thread),
        messages: thread.messages,
        requests: [...thread.requests.values()].map(requestView),
      });
    }),
  );
  app.post(
    '/rooms/:id/threads/:threadId/messages',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const thread = threadIn(room, param(c, 'threadId'));
      const input = C.postRoomMessageRequest.parse(await body(c));
      const known = submissions.get(`${thread.id}:${viewer.id}:${input.submission_id}`);
      const replayed = known && thread.messages.find((m) => m.id === known.id);
      if (replayed)
        return answer(C.roomMessageResponse, {
          thread: threadView(room, thread),
          message: replayed,
          request_job_id: replayed.request_job_id,
        });
      const posted = post(room, thread, viewer, input.text, false);
      submissions.set(`${thread.id}:${viewer.id}:${input.submission_id}`, posted.message);
      return answer(C.roomMessageResponse, { thread: threadView(room, thread), ...posted });
    }),
  );
  app.get(
    '/rooms/:id/threads/:threadId/events',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const thread = threadIn(room, param(c, 'threadId'));
      const cursor = c.req.header('Last-Event-ID') ?? c.req.query('after') ?? '0';
      if (!/^\d+$/.test(cursor))
        throw new RoomError(400, 'invalid_request', 'Choose a valid position.');
      let after = Number(cursor);
      const page = () => (frames.get(thread.id) ?? []).filter((frame) => frame.seq > after);
      if (!c.req.header('Accept')?.includes('text/event-stream')) {
        const list = page().slice(0, 100);
        return Response.json({ frames: list, next_cursor: list.at(-1)?.seq ?? after });
      }
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      let ticks = 0;
      const stop = () => clearInterval(timer);
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const flush = () => {
            // Someone no longer in the room stops reading it at once.
            if (!room.members.has(viewer.id) || session.signedOut()) {
              stop();
              controller.close();
              return;
            }
            for (const frame of page()) {
              after = frame.seq;
              controller.enqueue(
                encoder.encode(
                  `id: ${frame.seq}\nevent: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`,
                ),
              );
            }
            ticks += 1;
            if (ticks % 300 === 0) controller.enqueue(encoder.encode(': keepalive\n\n'));
          };
          flush();
          timer = setInterval(flush, 50);
          c.req.raw.signal.addEventListener('abort', stop, { once: true });
        },
        cancel: stop,
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }),
  );
  app.post(
    '/rooms/:id/requests/:jobId/stop',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const jobId = param(c, 'jobId');
      for (const thread of room.threads.values()) {
        const request = thread.requests.get(jobId);
        if (!request) continue;
        if (request.requested_by !== viewer.id && room.role !== 'owner')
          throw new RoomError(
            403,
            'scope_denied',
            'Only the person who asked, or an owner of this room, can stop it.',
          );
        if (UNDER_WAY.has(request.status)) {
          clearTimeout(request.timer);
          request.status = 'stopped';
          const last = request.turns.at(-1);
          if (last) last.status = 'stopped';
          pushEvent(thread, request, { type: 'status', status: 'stopped', composer: 'send' });
          release(room, thread);
        }
        return answer(C.roomStopResponse, { request: requestView(request) });
      }
      throw new RoomError(404, 'not_found', 'That request is not here.');
    }),
  );
  app.post(
    '/rooms/:id/presence',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const here = present.get(room.id) ?? new Map<string, number>();
      here.set(viewer.id, Date.now());
      present.set(room.id, here);
      seen.set(`${room.id}:${viewer.id}`, now());
      return answer(C.roomPresenceResponse, { present: presentIn(room) });
    }),
  );

  return {
    /** Seed the demonstration rooms; the web app's mock does, tests do not. */
    seed: () => {
      if (!session.signedOut() && session.account()) seedDemo();
    },
    rooms,
  };
}
