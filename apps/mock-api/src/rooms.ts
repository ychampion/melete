/**
 * Rooms, in memory: shared spaces where several people talk to one agent in
 * threads. The signed-in demo account is one person among a few others on the
 * installation. A message that names the agent (`@Melete`, or `@` and the
 * agent's name), a thread started as an ask, or a straight follow-up to the
 * agent's answer to the same person starts a scripted request, streamed on the
 * thread's live frames like the service streams it. A thread works on one
 * request at a time; a later ask waits its turn. Every body is parsed with the
 * contract on the way in and out.
 *
 * It also keeps what the service keeps around a room: its settings and who
 * answers its permissions, what it remembers and what people shared into it,
 * guest invites (a guest who accepts one is signed in as that guest, and
 * reaches nothing but rooms), and the tasks a room hands a person to run with
 * their own setup.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as C from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppDeps } from './app.ts';
import { newId } from './store.ts';

type Account = { id: string; email: string; created_at: string };
type Person = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  kind: 'person' | 'guest';
  /** A guest's own password; the demo account's lives with the app. */
  password?: string;
};
type Role = 'owner' | 'member' | 'guest';
type Message = z.infer<typeof C.roomMessage>;
type Turn = z.infer<typeof C.conversationTurn>;
type Status = Turn['status'];
type Permission = z.infer<typeof C.permissionCard>;
type Request = {
  job_id: string;
  requested_by: string;
  status: Status;
  turns: Turn[];
  cards: z.infer<typeof C.resultCard>[];
  receipts: z.infer<typeof C.experienceReceipt>[];
  /** Permissions waiting now, each naming who may answer it. */
  permissions: Permission[];
  decisions: z.infer<typeof C.roomDecision>[];
  timer?: ReturnType<typeof setTimeout>;
};
type Thread = {
  id: string;
  room_id: string;
  title: string;
  created_by: string;
  created_at: string;
  last_activity_at: string;
  messages: Message[];
  requests: Map<string, Request>;
};
type MemoryItem = {
  claim_id: string;
  key: string | null;
  label: string;
  content: string;
  said_by: string[];
  /** The messages it rests on: deleting the only one forgets it. */
  messages: string[];
  recorded_at: string;
};
type Share = {
  id: string;
  claim_id: string;
  shared_by: string;
  members_only: boolean;
  label: string;
  content: string;
  created_at: string;
};
type Invite = {
  id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  accepted_at: string | null;
  withdrawn_at: string | null;
};
type Handoff = {
  id: string;
  room_id: string;
  thread_id: string;
  request_job_id: string;
  target: string;
  asker: string | null;
  task: string;
  state: C.HandoffState;
  job_id: string | null;
  result: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
};
type Room = {
  id: string;
  name: string;
  purpose: string | null;
  created_at: string;
  agent_name: string;
  members: Map<string, Role>;
  /** When a guest's place in the room ends. */
  expires: Map<string, string>;
  threads: Map<string, Thread>;
  policy: z.infer<typeof C.roomPolicy>;
  memory: MemoryItem[];
  shares: Share[];
  invites: Invite[];
};
type Frame = z.infer<typeof C.roomStreamFrame>;
type FrameInput =
  | { kind: 'message'; message: Message }
  | { kind: 'request'; request_job_id: string; event: unknown };

const UNDER_WAY = new Set<Status>(['queued', 'working', 'streaming']);
/** Asks to send something, which the scripted agent takes to a permission. */
const SENDS = /\b(send|email|mail|post)\b/i;
/** Asks for the person's own mail or calendar, which the room's agent hands to them. */
const OWN_SETUP = /\bmy (email|mail|inbox|calendar)\b/i;
const DAY_MS = 86_400_000;
const HANDOFF_DAYS = 7;

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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The service's handle: eight letters from the room and the account, the same everywhere. */
const HANDLE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function roomHandle(roomId: string, principalId: string): string {
  const digest = createHash('sha256').update(`room-handle:${roomId}:${principalId}`).digest();
  let handle = '';
  for (let index = 0; index < 8; index++) handle += HANDLE_ALPHABET[(digest[index] ?? 0) & 31];
  return handle;
}

/** The name a person chose; a room calls someone who chose none "Someone", never by their email. */
const nameOf = (person: Person) => person.display_name?.trim() || 'Someone';
/** How a room labels a person: their name, then the room's handle for them. */
const labelIn = (roomId: string, person: Person) =>
  `${nameOf(person)} <${roomHandle(roomId, person.id)}>`;

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
  session: {
    account: () => Account | null;
    signedOut: () => boolean;
    profileName: () => string;
    /** A detail in the demo account's own memory, by its claim id. */
    belief?: (claimId: string) => { label: string; value: string } | null;
  },
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
  const handoffs = new Map<string, Handoff>();
  /** The guest signed in on this mock, when one is; otherwise the demo account's session holds. */
  let guestId: string | null = null;
  let seq = 0;

  for (const other of OTHERS) {
    const id = newId('own');
    people.set(id, { id, created_at: now(), kind: 'person', ...other });
  }
  const byEmail = (email: string) =>
    [...people.values()].find((p) => p.email === email.toLowerCase());

  /** The signed-in person, as a room sees them. */
  const me = (): Person => {
    const guest = guestId ? people.get(guestId) : undefined;
    if (guest) return guest;
    if (session.signedOut()) throw new RoomError(401, 'unauthorized', 'A session is required.');
    const account = session.account();
    if (!account) throw new RoomError(401, 'unauthorized', 'A session is required.');
    const known = people.get(account.id);
    if (known) return known;
    const person: Person = { ...account, display_name: null, kind: 'person' };
    people.set(account.id, person);
    return person;
  };
  /** Routes a guest never reaches: making rooms, the people list, and everything personal. */
  const personOnly = (viewer: Person) => {
    if (viewer.kind === 'guest')
      throw new RoomError(
        403,
        'guests_use_rooms',
        'A guest account uses only the rooms it was invited to.',
      );
  };
  const person = (id: string): Person =>
    people.get(id) ?? {
      id,
      email: 'someone@invalid.example',
      display_name: 'Someone',
      created_at: now(),
      kind: 'person',
    };
  const author = (roomId: string, id: string) => ({
    principal_id: id,
    display_name: labelIn(roomId, person(id)),
  });

  /** A guest whose days are up is no longer in the room. */
  const roleIn = (room: Room, id: string): Role | undefined => {
    const role = room.members.get(id);
    const until = room.expires.get(id);
    if (role === 'guest' && until && until <= now()) return undefined;
    return role;
  };
  /** A room the caller is in; anyone else finds no room at all. */
  const roomFor = (id: string, viewer: Person): Room & { role: Role } => {
    const room = rooms.get(id);
    const role = room ? roleIn(room, viewer.id) : undefined;
    if (!room || !role) throw new RoomError(404, 'not_found', 'That room is not here.');
    return Object.assign(room, { role });
  };
  const ownerOnly = (room: Room & { role: Role }) => {
    if (room.role !== 'owner')
      throw new RoomError(403, 'scope_denied', 'Only an owner of this room can do that.');
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
    return [...ids].filter((id) => roleIn(room, id));
  };
  const memberView = (room: Room, id: string, role: Role, viewer: Role, here: boolean) =>
    C.roomMember.parse({
      principal_id: id,
      display_name: labelIn(room.id, person(id)),
      role,
      handle: roomHandle(room.id, id),
      ...(viewer === 'guest' ? {} : { email: person(id).email }),
      expires_at: room.expires.get(id) ?? null,
      present: here,
    });
  const detail = (room: Room, role: Role, viewer: Person) => {
    const here = new Set(presentIn(room));
    return C.roomDetail.parse({
      room: { ...summary(room, role, viewer), agent_name: room.agent_name },
      members: [...room.members.keys()].flatMap((id) => {
        const memberRole = roleIn(room, id);
        return memberRole ? [memberView(room, id, memberRole, role, here.has(id))] : [];
      }),
      policy: room.policy,
    });
  };
  const threadView = (room: Room, thread: Thread) =>
    C.roomThread.parse({
      id: thread.id,
      room_id: room.id,
      title: thread.title,
      created_by: author(room.id, thread.created_by),
      created_at: thread.created_at,
      last_activity_at: thread.last_activity_at,
      archived_at: null,
    });
  const requestView = (room: Room, request: Request) =>
    C.roomRequest.parse({
      job_id: request.job_id,
      requested_by: author(room.id, request.requested_by),
      status: request.status,
      turns: request.turns,
      cards: request.cards,
      receipts: request.receipts,
      permissions: request.permissions,
      decisions: request.decisions,
    });

  const makeRoom = (name: string, purpose: string | null, owner: string, at = now()) => {
    const room: Room = {
      id: newId('sp'),
      name,
      purpose,
      created_at: at,
      agent_name: 'Melete',
      members: new Map([[owner, 'owner']]),
      expires: new Map(),
      threads: new Map(),
      policy: {
        approvers: 'requester',
        agent_turns: 'asked',
        guests_may_ask: true,
        requests_per_hour: 30,
        requests_per_person_hour: 10,
      },
      memory: [],
      shares: [],
      invites: [],
    };
    rooms.set(room.id, room);
    return room;
  };
  const makeThread = (room: Room, title: string, by: string, at = now()): Thread => {
    const thread: Thread = {
      id: newId('rth'),
      room_id: room.id,
      title,
      created_by: by,
      created_at: at,
      last_activity_at: at,
      messages: [],
      requests: new Map(),
    };
    room.threads.set(thread.id, thread);
    return thread;
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
      author: author(thread.room_id, authorId),
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
  /** A line the service writes into a thread as one of its people: a handoff's outcome. */
  const note = (
    thread: Thread,
    authorId: string,
    text: string,
    kind: Message['kind'] = 'system',
  ) => {
    const message = addMessage(thread, authorId, text, now(), {
      kind,
      via_agent: kind === 'handoff_result',
      mentions: [],
    });
    pushMessage(thread, message);
    return message;
  };

  /**
   * Who may answer a permission of this request, under the room's rule: the
   * person who asked (a guest's request goes to the owners), any member who is
   * not a guest, or the owners. Guests never answer.
   */
  const eligibleFor = (room: Room, request: Request): string[] => {
    const asker = request.requested_by;
    const owners = [...room.members.keys()].filter((id) => roleIn(room, id) === 'owner');
    if (room.policy.approvers === 'owners') return owners;
    if (room.policy.approvers === 'any_member')
      return [...room.members.keys()].filter((id) => {
        const role = roleIn(room, id);
        return role === 'owner' || role === 'member';
      });
    const role = roleIn(room, asker);
    return role === 'guest' ? owners : role ? [asker] : [];
  };
  const waitingLine = (room: Room, request: Request) => {
    if (room.policy.approvers === 'owners') return "Waiting for one of the room's owners.";
    if (room.policy.approvers === 'any_member') return 'Any member of the room can answer it.';
    return roleIn(room, request.requested_by) === 'guest'
      ? "Waiting for one of the room's owners to answer it."
      : `Waiting for ${labelIn(room.id, person(request.requested_by))}, who asked for it. Only they can answer it.`;
  };
  /** A permission a room's request waits on, naming who may answer it now. */
  const permissionFor = (room: Room, request: Request, what: string, at = now()) =>
    C.permissionCard.parse({
      id: newId('perm'),
      conversation_id: request.job_id,
      what,
      why: [waitingLine(room, request), 'From: team@studio-mail.example'],
      options: ['allow_once', 'deny'],
      version: newId('ver'),
      preview: null,
      // What would be sent, whole, so whoever answers reads it first.
      draft: {
        id: newId('drf'),
        recipient: 'agency@studio.example',
        channel: 'email',
        subject: `Notes from ${room.name}`,
        body: `Hello,

Here are the notes from the room ${room.name}. The starter plan keeps its name.

Thanks`,
        connection_id: newId('conn'),
        status: 'awaiting_permission',
      },
      created_at: at,
      requested_by: author(room.id, request.requested_by),
      eligible_approvers: eligibleFor(room, request).map((id) => author(room.id, id)),
      payload_hash: sha256(`${request.job_id}:${what}`),
    });
  /** A change of rule, or of who is in the room, changes who may answer what waits. */
  const refreshPermissions = (room: Room) => {
    for (const thread of room.threads.values())
      for (const request of thread.requests.values())
        request.permissions = request.permissions.map((permission) => ({
          ...permission,
          why: [waitingLine(room, request), ...permission.why.slice(1)],
          eligible_approvers: eligibleFor(room, request).map((id) => author(room.id, id)),
        }));
  };

  const held = (thread: Thread) =>
    [...thread.requests.values()].some((request) => UNDER_WAY.has(request.status));

  const newRequest = (requestedBy: string): Request => ({
    job_id: newId('job'),
    requested_by: requestedBy,
    status: 'queued',
    turns: [],
    cards: [],
    receipts: [],
    permissions: [],
    decisions: [],
  });

  /** Hand a task to a person to run with their own setup; it waits for them on their Home. */
  const handOff = (room: Room, thread: Thread, request: Request, task: string, at = now()) => {
    const handoff: Handoff = {
      id: newId('rho'),
      room_id: room.id,
      thread_id: thread.id,
      request_job_id: request.job_id,
      target: request.requested_by,
      asker: request.requested_by,
      task,
      state: 'pending',
      job_id: null,
      result: null,
      created_at: at,
      decided_at: null,
      expires_at: new Date(Date.parse(at) + HANDOFF_DAYS * DAY_MS).toISOString(),
    };
    handoffs.set(handoff.id, handoff);
    return handoff;
  };

  /** Start the request a message asked for, and play the agent's answer onto the stream. */
  const start = (room: Room, thread: Thread, message: Message) => {
    const request = newRequest(message.author.principal_id);
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
    const text = message.text ?? '';
    const asker = person(request.requested_by);
    // Only a member's request reaches a person's own setup; a guest's never does.
    const ownSetup = OWN_SETUP.test(text) && roleIn(room, asker.id) !== 'guest';
    const words = (
      ownSetup
        ? `That needs your own setup, ${nameOf(asker)}, which this room cannot use. I sent you the task to run with it; it waits on your Home.`
        : answerFor(text, nameOf(asker), thread)
    ).split(/(?<= )/);
    const steps: (() => void)[] = [
      () => setStatus('working'),
      ...words.map((piece, index) => () => {
        if (index === 0) setStatus('streaming');
        turn.answer += piece;
        pushEvent(thread, request, { type: 'text_delta', text: piece });
      }),
      () => {
        if (ownSetup) {
          handOff(room, thread, request, text.replace(/@[\p{L}\p{N}_.-]+/gu, '').trim());
          return;
        }
        // An ask to send something waits on the person the room's rule names.
        if (SENDS.test(text)) {
          const permission = permissionFor(room, request, `Send the notes on ${thread.title}`);
          request.permissions.push(permission);
          pushEvent(thread, request, { type: 'permission', permission });
          return;
        }
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
        setStatus(ownSetup ? 'paused' : request.permissions.length > 0 ? 'needs_you' : 'done');
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

  const post = (
    room: Room & { role: Role },
    thread: Thread,
    viewer: Person,
    text: string,
    ask: boolean,
  ) => {
    const asks =
      ask ||
      room.policy.agent_turns === 'every_message' ||
      asksAgent(text, room.agent_name) ||
      followsAnswer(thread, viewer.id);
    if (asks && room.role === 'guest' && !room.policy.guests_may_ask)
      throw new RoomError(403, 'guests_may_not_ask', 'Guests in this room do not ask its agent.');
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

  /** The room's request hears how the handoff it waits on ended, and settles. */
  const settleRequest = (handoff: Handoff) => {
    const thread = rooms.get(handoff.room_id)?.threads.get(handoff.thread_id);
    const request = thread?.requests.get(handoff.request_job_id);
    if (!thread || !request || request.status !== 'paused') return;
    request.status = 'done';
    const last = request.turns.at(-1);
    if (last) last.status = 'done';
    pushEvent(thread, request, { type: 'status', status: 'done', composer: 'send' });
  };
  const handoffView = (handoff: Handoff) => {
    const room = rooms.get(handoff.room_id);
    return C.roomHandoff.parse({
      id: handoff.id,
      room: { id: handoff.room_id, name: room?.name ?? 'A room' },
      thread_id: handoff.thread_id,
      asked_by: handoff.asker ? author(handoff.room_id, handoff.asker) : null,
      task: handoff.task,
      task_hash: sha256(handoff.task),
      state: handoff.state,
      job_id: handoff.job_id,
      result: handoff.result,
      result_hash: handoff.result === null ? null : sha256(handoff.result),
      created_at: handoff.created_at,
      decided_at: handoff.decided_at,
      expires_at: handoff.expires_at,
    });
  };
  /** What waits on the signed-in person: a task to run or decline, or a result to share or keep. */
  const handoffsWaiting = () => {
    let viewer: Person;
    try {
      viewer = me();
    } catch {
      return [];
    }
    return [...handoffs.values()]
      .filter(
        (handoff) =>
          handoff.target === viewer.id &&
          (handoff.state === 'pending' ||
            handoff.state === 'running' ||
            (handoff.state === 'settled' && handoff.result !== null)),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(handoffView);
  };

  const shareView = (room: Room & { role: Role }, share: Share, viewer: Person) =>
    C.roomShare.parse({
      id: share.id,
      claim_id: share.claim_id,
      shared_by: author(room.id, share.shared_by),
      members_only: share.members_only,
      label: share.label,
      content: share.content,
      created_at: share.created_at,
      can_withdraw: room.role === 'owner' || share.shared_by === viewer.id,
    });
  /** What the room remembers, as the viewer may act on it. */
  const memoryView = (room: Room & { role: Role }, viewer: Person) =>
    C.roomMemoryView.parse({
      items: room.memory.map((item) => ({
        claim_id: item.claim_id,
        key: item.key,
        label: item.label,
        content: item.content,
        said_by: item.said_by.map((id) => author(room.id, id)),
        can_forget: room.role === 'owner' || item.said_by.every((id) => id === viewer.id),
        recorded_at: item.recorded_at,
      })),
      shares: room.shares.map((share) => shareView(room, share, viewer)),
    });

  const inviteState = (invite: Invite): z.infer<typeof C.roomInviteState> =>
    invite.withdrawn_at
      ? 'withdrawn'
      : invite.accepted_at
        ? 'accepted'
        : invite.expires_at <= now()
          ? 'expired'
          : 'open';
  const inviteView = (room: Room, invite: Invite) =>
    C.roomInvite.parse({
      id: invite.id,
      room_id: room.id,
      email: invite.email,
      state: inviteState(invite),
      expires_at: invite.expires_at,
      created_by: author(room.id, invite.created_by),
      created_at: invite.created_at,
      accepted_at: invite.accepted_at,
    });
  const inviteByToken = (token: string) => {
    const hash = sha256(token);
    for (const room of rooms.values()) {
      const invite = room.invites.find((entry) => entry.token_hash === hash);
      if (invite && inviteState(invite) === 'open') return { room, invite };
    }
    throw new RoomError(
      404,
      'invite_unavailable',
      'This invite link is used, withdrawn or out of date. Ask for a new one.',
    );
  };

  /** A demonstration room with people, a finished ask and a conversation in it. */
  const seedDemo = () => {
    const self = me();
    if (session.profileName()) self.display_name = session.profileName();
    const priya = byEmail('priya.shah@fastmail.example');
    const sam = byEmail('sam.okafor@fastmail.example');
    if (!priya || !sam) return;
    const day = (offset: number, minutes = 0) =>
      new Date(deps.store.now().getTime() - offset * DAY_MS + minutes * 60_000).toISOString();
    const launch = makeRoom(
      'Spring launch',
      'Plans and copy for the spring release',
      self.id,
      day(6),
    );
    launch.members.set(priya.id, 'member');
    launch.members.set(sam.id, 'member');
    const thread = makeThread(launch, 'Pricing page copy', priya.id, day(1));
    const asked = addMessage(
      thread,
      priya.id,
      'The pricing page still says “starter”. Should we rename it?',
      day(1),
    );
    const kept = addMessage(thread, sam.id, 'I’d keep it. People search for it.', day(1, 4));
    const ask = addMessage(
      thread,
      self.id,
      '@Melete can you pull together what we decided about the plan names?',
      day(1, 9),
      { request_state: 'started' },
    );
    const request: Request = {
      ...newRequest(self.id),
      status: 'done',
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
      decisions: [
        C.roomDecision.parse({
          approval_id: newId('apr'),
          decision: 'approved',
          decided_by: author(launch.id, self.id),
          decided_at: day(1, 10),
        }),
      ],
    };
    request.turns.push({
      id: newId('turn'),
      conversation_id: request.job_id,
      agent_id: newId('agt'),
      text: ask.text ?? '',
      answer:
        'Here is what this thread settled:\n\n- **Starter** keeps its name; Sam pointed out people search for it.\n- Priya’s rename question is open for the other two plans.\n\nI saved these notes to the room’s files.',
      status: 'done',
      delivery: null,
      created_at: day(1, 9),
    });
    thread.requests.set(request.job_id, request);
    const index = thread.messages.indexOf(ask);
    thread.messages[index] = { ...ask, request_job_id: request.job_id };
    addMessage(thread, priya.id, 'Thanks. I’ll take the other two to the team.', day(0, -40));

    // Sam's ask to send something waits on Sam, as the room's rule says.
    const sends = addMessage(
      thread,
      sam.id,
      '@Melete email the plan names to the agency',
      day(0, -20),
      { request_state: 'started' },
    );
    const waiting: Request = { ...newRequest(sam.id), status: 'needs_you' };
    waiting.turns.push({
      id: newId('turn'),
      conversation_id: waiting.job_id,
      agent_id: newId('agt'),
      text: sends.text ?? '',
      answer: 'I drafted the email with the plan names. It goes out once Sam says so.',
      status: 'needs_you',
      delivery: null,
      created_at: day(0, -20),
    });
    waiting.permissions.push(
      permissionFor(launch, waiting, 'Send the plan names to agency@studio.example', day(0, -19)),
    );
    thread.requests.set(waiting.job_id, waiting);
    const sent = thread.messages.indexOf(sends);
    thread.messages[sent] = { ...sends, request_job_id: waiting.job_id };

    // A task the room handed the demo account to run with their own mail.
    const followUp = makeThread(launch, 'Agency follow-up', self.id, day(0, -15));
    const handAsk = addMessage(
      followUp,
      self.id,
      '@Melete send the agency a short note from my email asking when the drafts land',
      day(0, -15),
      { request_state: 'started' },
    );
    const handed: Request = { ...newRequest(self.id), status: 'paused' };
    handed.turns.push({
      id: newId('turn'),
      conversation_id: handed.job_id,
      agent_id: newId('agt'),
      text: handAsk.text ?? '',
      answer:
        'That needs your own email, which this room cannot use. I sent you the task to run with your own setup; it waits on your Home.',
      status: 'paused',
      delivery: null,
      created_at: day(0, -15),
    });
    followUp.requests.set(handed.job_id, handed);
    followUp.messages[0] = { ...handAsk, request_job_id: handed.job_id };
    handOff(
      launch,
      followUp,
      handed,
      'Send the agency (agency@studio.example) a short note from my email asking when the spring drafts will land.',
      day(0, -14),
    );

    // What the room remembers from what its people said, with who said it.
    launch.memory.push(
      {
        claim_id: newId('k'),
        key: 'plan.starter.name',
        label: 'Plan names: starter',
        content: 'The starter plan keeps its name; people search for it.',
        said_by: [sam.id],
        messages: [kept.id],
        recorded_at: day(1, 5),
      },
      {
        claim_id: newId('k'),
        key: 'plan.rename.question',
        label: 'Plan names: open question',
        content: 'Whether to rename the other two plans is still open.',
        said_by: [priya.id],
        messages: [asked.id],
        recorded_at: day(1, 1),
      },
    );
    launch.shares.push({
      id: newId('rsh'),
      claim_id: newId('k'),
      shared_by: priya.id,
      members_only: true,
      label: 'Agency contact',
      content: 'Mara Lind at the studio handles the spring drafts.',
      created_at: day(2),
    });
    launch.invites.push({
      id: newId('rin'),
      email: 'mara.lind@studio.example',
      token_hash: sha256(randomBytes(32).toString('base64url')),
      expires_at: new Date(deps.store.now().getTime() + 23 * DAY_MS).toISOString(),
      created_by: self.id,
      created_at: day(7),
      accepted_at: null,
      withdrawn_at: null,
    });

    const studio = makeRoom('Book club', 'What we read next, and when we meet', priya.id, day(12));
    studio.members.set(self.id, 'member');
    const pick = makeThread(studio, 'October pick', priya.id, day(2));
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
  const meBody = (self: Person) => ({
    owner: {
      id: self.id,
      email: self.email,
      created_at: self.created_at,
      display_name: self.display_name,
      kind: self.kind,
    },
  });

  app.get(
    '/me',
    route(() => answer(C.meResponse, meBody(me()))),
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
      return answer(C.meResponse, meBody(self));
    }),
  );
  app.get(
    '/people',
    route((c) => {
      personOnly(me());
      const query = C.peopleQuery.parse(c.req.query()).query?.trim().toLowerCase() ?? '';
      return answer(C.peopleList, {
        people: [...people.values()]
          .filter((p) => p.kind === 'person')
          .filter(
            (p) => !query || `${p.email} ${p.display_name ?? ''}`.toLowerCase().includes(query),
          )
          .sort((a, b) => a.email.localeCompare(b.email))
          .map((p) => ({
            id: p.id,
            display_name: p.display_name?.trim() || p.email.split('@')[0] || p.email,
            email: p.email,
          })),
      });
    }),
  );
  app.get(
    '/rooms',
    route(() => {
      const viewer = me();
      const list = [...rooms.values()]
        .filter((room) => roleIn(room, viewer.id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((room) => summary(room, roleIn(room, viewer.id) ?? 'member', viewer));
      return answer(C.roomList, { rooms: list });
    }),
  );
  app.post(
    '/rooms',
    route(async (c) => {
      const viewer = me();
      personOnly(viewer);
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
  // The accounts in the room's space. An account added to a room serves the room.
  app.get(
    '/rooms/:id/connections',
    route((c) => {
      const room = roomFor(param(c, 'id'), me());
      return answer(C.roomConnectionList, {
        connections: [...deps.store.connections.values()]
          .filter((entry) => entry.space_id === room.id && entry.status !== 'revoked')
          .map((entry) => ({
            id: entry.id,
            label: entry.label,
            provider: entry.provider,
            status: entry.status,
            shared_use: 'room' as const,
            builtin: entry.builtin === true,
          })),
      });
    }),
  );
  app.post(
    '/rooms/:id/members',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      ownerOnly(room);
      const input = C.addRoomMemberRequest.parse(await body(c));
      const added = people.get(input.principal_id);
      if (added?.kind !== 'person')
        throw new RoomError(404, 'not_found', 'That person is not here.');
      if (!room.members.has(added.id)) room.members.set(added.id, 'member');
      refreshPermissions(room);
      const role = room.members.get(added.id) ?? 'member';
      return answer(
        C.roomMembershipResponse,
        { member: memberView(room, added.id, role, 'owner', false) },
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
      room.expires.delete(target);
      // The requests they asked end with them, as in the service.
      for (const thread of room.threads.values())
        for (const request of thread.requests.values())
          if (request.requested_by === target && UNDER_WAY.has(request.status)) {
            clearTimeout(request.timer);
            request.status = 'stopped';
            const last = request.turns.at(-1);
            if (last) last.status = 'stopped';
          }
      refreshPermissions(room);
      return answer(C.roomLeaveResponse, { removed: target });
    }),
  );
  app.get(
    '/rooms/:id/policy',
    route((c) => {
      const room = roomFor(param(c, 'id'), me());
      return answer(C.roomPolicyResponse, { policy: room.policy });
    }),
  );
  app.put(
    '/rooms/:id/policy',
    route(async (c) => {
      const room = roomFor(param(c, 'id'), me());
      ownerOnly(room);
      const input = C.roomPolicyUpdate.parse(await body(c));
      const next = { ...room.policy, ...input };
      if ((next.requests_per_person_hour ?? 0) > (next.requests_per_hour ?? Infinity))
        throw new RoomError(
          400,
          'invalid_request',
          'One person cannot ask more often than the whole room.',
        );
      room.policy = C.roomPolicy.parse(next);
      refreshPermissions(room);
      return answer(C.roomPolicyResponse, { policy: room.policy });
    }),
  );
  app.post(
    '/rooms/:id/approvals/:approvalId',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const input = C.roomPermissionDecision.parse(await body(c));
      const approvalId = param(c, 'approvalId');
      for (const thread of room.threads.values())
        for (const request of thread.requests.values()) {
          const decided = request.decisions.find((entry) => entry.approval_id === approvalId);
          if (decided) {
            const how = decided.decision === 'approved' ? 'allowed' : 'denied';
            throw new RoomError(
              409,
              'already_answered',
              decided.decided_by?.principal_id === viewer.id
                ? `You already ${how} this.`
                : `${decided.decided_by?.display_name ?? 'Someone'} already ${how} this.`,
            );
          }
          const permission = request.permissions.find((entry) => entry.id === approvalId);
          if (!permission) continue;
          if (!eligibleFor(room, request).includes(viewer.id))
            throw new RoomError(403, 'not_yours_to_answer', waitingLine(room, request));
          if (
            permission.version !== input.version ||
            permission.payload_hash !== input.payload_hash
          )
            throw new RoomError(
              409,
              'approval_hash_mismatch',
              'What this asks for changed. Review it again.',
            );
          request.permissions = request.permissions.filter((entry) => entry.id !== approvalId);
          request.decisions.push(
            C.roomDecision.parse({
              approval_id: approvalId,
              decision: input.option === 'allow_once' ? 'approved' : 'denied',
              decided_by: author(room.id, viewer.id),
              decided_at: now(),
            }),
          );
          if (input.option === 'allow_once') {
            const receipt = C.experienceReceipt.parse({
              id: newId('rcpt'),
              what: permission.what.replace(/^Send/, 'Sent'),
              where: 'agency@studio.example',
              when: now(),
            });
            request.receipts.push(receipt);
            pushEvent(thread, request, { type: 'receipt', receipt });
          }
          if (request.permissions.length === 0) {
            request.status = 'done';
            const last = request.turns.at(-1);
            if (last) last.status = 'done';
            pushEvent(thread, request, { type: 'status', status: 'done', composer: 'send' });
          }
          return answer(C.roomPermissionOutcome, {
            status: 'ok',
            option: input.option,
            decided_by: author(room.id, viewer.id),
          });
        }
      throw new RoomError(404, 'not_found', 'That permission is not here.');
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
      const thread = makeThread(
        room,
        input.title?.trim() || input.text.split('\n')[0]?.trim().slice(0, 200) || 'Thread',
        viewer.id,
      );
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
        requests: [...thread.requests.values()].map((request) => requestView(room, request)),
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
  app.delete(
    '/rooms/:id/messages/:messageId',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const id = param(c, 'messageId');
      for (const thread of room.threads.values()) {
        const message = thread.messages.find((m) => m.id === id);
        if (!message) continue;
        if (message.author.principal_id !== viewer.id || message.kind !== 'person')
          throw new RoomError(403, 'scope_denied', 'Only the person who wrote it can delete it.');
        const redacted = { ...message, text: null, mentions: [] };
        replace(thread, redacted);
        // What rests on it alone is forgotten with it.
        room.memory = room.memory.filter(
          (item) => !(item.messages.length === 1 && item.messages[0] === id),
        );
        return answer(C.roomMessageDeleted, { message: redacted });
      }
      throw new RoomError(404, 'not_found', 'That message is not here.');
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
            // Someone no longer in the room, or signed out, stops reading it at once.
            let current: Person | null = null;
            try {
              current = me();
            } catch {
              current = null;
            }
            if (!roleIn(room, viewer.id) || current?.id !== viewer.id) {
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
        if (UNDER_WAY.has(request.status) || request.status === 'paused') {
          clearTimeout(request.timer);
          request.status = 'stopped';
          const last = request.turns.at(-1);
          if (last) last.status = 'stopped';
          pushEvent(thread, request, { type: 'status', status: 'stopped', composer: 'send' });
          // A handoff its request no longer waits on is withdrawn.
          for (const handoff of handoffs.values())
            if (handoff.request_job_id === jobId && handoff.state === 'pending') {
              handoff.state = 'expired';
              handoff.decided_at = now();
            }
          release(room, thread);
        }
        return answer(C.roomStopResponse, { request: requestView(room, request) });
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

  /* ---------- memory and shares ---------- */

  app.get(
    '/rooms/:id/memory',
    route((c) => {
      const viewer = me();
      return answer(C.roomMemoryView, memoryView(roomFor(param(c, 'id'), viewer), viewer));
    }),
  );
  app.post(
    '/rooms/:id/memory/:claimId/forget',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const claimId = param(c, 'claimId');
      const item = room.memory.find((entry) => entry.claim_id === claimId);
      if (!item) throw new RoomError(404, 'not_found', 'That detail is not here.');
      if (room.role !== 'owner' && !item.said_by.every((id) => id === viewer.id))
        throw new RoomError(
          403,
          'scope_denied',
          'Only an owner can forget what other people said in the room.',
        );
      room.memory = room.memory.filter((entry) => entry !== item);
      return answer(C.roomMemoryForgotten, { forgotten: claimId });
    }),
  );
  app.post(
    '/rooms/:id/shares',
    route(async (c) => {
      const viewer = me();
      personOnly(viewer);
      const room = roomFor(param(c, 'id'), viewer);
      const input = C.shareToRoomRequest.parse(await body(c));
      const existing = room.shares.find((share) => share.claim_id === input.claim_id);
      if (existing)
        return answer(C.roomShareResponse, { share: shareView(room, existing, viewer) });
      const found = session.belief?.(input.claim_id);
      if (!found) throw new RoomError(404, 'not_found', 'That detail is not in your memory.');
      const share: Share = {
        id: newId('rsh'),
        claim_id: input.claim_id,
        shared_by: viewer.id,
        members_only: input.members_only ?? true,
        label: found.label,
        content: found.value,
        created_at: now(),
      };
      room.shares.push(share);
      return answer(C.roomShareResponse, { share: shareView(room, share, viewer) }, 201);
    }),
  );
  app.delete(
    '/rooms/:id/shares/:shareId',
    route((c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      const shareId = param(c, 'shareId');
      const share = room.shares.find((entry) => entry.id === shareId);
      if (!share) throw new RoomError(404, 'not_found', 'That share is not here.');
      if (room.role !== 'owner' && share.shared_by !== viewer.id)
        throw new RoomError(403, 'scope_denied', 'Only the person who shared it can withdraw it.');
      room.shares = room.shares.filter((entry) => entry !== share);
      return answer(C.roomShareWithdrawn, { withdrawn: shareId });
    }),
  );

  /* ---------- guests ---------- */

  app.get(
    '/rooms/:id/invites',
    route((c) => {
      const room = roomFor(param(c, 'id'), me());
      ownerOnly(room);
      return answer(C.roomInviteList, {
        invites: [...room.invites]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((invite) => inviteView(room, invite)),
      });
    }),
  );
  app.post(
    '/rooms/:id/invites',
    route(async (c) => {
      const viewer = me();
      const room = roomFor(param(c, 'id'), viewer);
      ownerOnly(room);
      const input = C.createRoomInviteRequest.parse(await body(c));
      const account = byEmail(input.email);
      if (account?.kind === 'person')
        throw new RoomError(
          409,
          'person_account',
          'This email has a full account here. Add them from People instead.',
        );
      if (account && roleIn(room, account.id))
        throw new RoomError(409, 'already_in_room', 'They are already in this room.');
      const token = randomBytes(32).toString('base64url');
      const invite: Invite = {
        id: newId('rin'),
        email: input.email,
        token_hash: sha256(token),
        expires_at: new Date(
          deps.store.now().getTime() + (input.expires_in_days ?? 30) * DAY_MS,
        ).toISOString(),
        created_by: viewer.id,
        created_at: now(),
        accepted_at: null,
        withdrawn_at: null,
      };
      room.invites.push(invite);
      return answer(
        C.roomInviteCreated,
        {
          invite: inviteView(room, invite),
          link: null,
          path: `/#/invite?${new URLSearchParams({ token })}`,
        },
        201,
      );
    }),
  );
  app.delete(
    '/rooms/:id/invites/:inviteId',
    route((c) => {
      const room = roomFor(param(c, 'id'), me());
      ownerOnly(room);
      const invite = room.invites.find((entry) => entry.id === param(c, 'inviteId'));
      if (!invite) throw new RoomError(404, 'not_found', 'That invite is not here.');
      if (inviteState(invite) === 'open') invite.withdrawn_at = now();
      return answer(C.roomInviteResponse, { invite: inviteView(room, invite) });
    }),
  );
  app.post(
    '/invites/view',
    route(async (c) => {
      const input = C.inviteViewRequest.parse(await body(c));
      const { room, invite } = inviteByToken(input.token);
      return answer(C.inviteView, {
        room_name: room.name,
        expires_at: invite.expires_at,
        existing_account: Boolean(byEmail(invite.email)),
      });
    }),
  );
  app.post(
    '/invites/accept',
    route(async (c) => {
      const input = C.acceptInviteRequest.parse(await body(c));
      const { room, invite } = inviteByToken(input.token);
      const account = byEmail(invite.email);
      let signedIn: Person | null = null;
      try {
        signedIn = me();
      } catch {
        signedIn = null;
      }
      let guest: Person;
      if (account) {
        if (account.kind !== 'guest')
          throw new RoomError(
            409,
            'person_account',
            'This email has a full account here. Ask an owner to add you from People.',
          );
        if (signedIn?.id !== account.id)
          throw new RoomError(
            409,
            'sign_in_first',
            'This email already has an account. Sign in, then open the link again.',
          );
        guest = account;
      } else {
        if (signedIn)
          throw new RoomError(
            409,
            'signed_in_as_other',
            'This invite is for another email. Sign out, then open the link again.',
          );
        if (!input.password)
          throw new RoomError(400, 'password_required', 'Choose a password for your account.');
        guest = {
          id: newId('own'),
          email: invite.email,
          display_name: input.display_name?.trim() || null,
          created_at: now(),
          kind: 'guest',
          password: input.password,
        };
        people.set(guest.id, guest);
        guestId = guest.id;
      }
      room.members.set(guest.id, 'guest');
      room.expires.set(guest.id, invite.expires_at);
      invite.accepted_at = now();
      refreshPermissions(room);
      return answer(C.acceptInviteResponse, { room_id: room.id });
    }),
  );

  /* ---------- handoffs ---------- */

  const handoffFor = (id: string, viewer: Person) => {
    const handoff = handoffs.get(id);
    if (!handoff || handoff.target !== viewer.id)
      throw new RoomError(404, 'not_found', 'That request is not here.');
    return handoff;
  };
  const threadOf = (handoff: Handoff) => {
    const thread = rooms.get(handoff.room_id)?.threads.get(handoff.thread_id);
    if (!thread) throw new RoomError(404, 'not_found', 'That room is not here.');
    return thread;
  };

  app.get(
    '/handoffs',
    route(() => {
      const viewer = me();
      personOnly(viewer);
      return answer(C.handoffList, {
        handoffs: [...handoffs.values()]
          .filter((handoff) => handoff.target === viewer.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(handoffView),
      });
    }),
  );
  app.post(
    '/handoffs/:id',
    route(async (c) => {
      const viewer = me();
      personOnly(viewer);
      const handoff = handoffFor(param(c, 'id'), viewer);
      const input = C.handoffDecision.parse(await body(c));
      if (handoff.state !== 'pending')
        throw new RoomError(
          409,
          'handoff_answered',
          handoff.state === 'expired'
            ? 'This was withdrawn, or waited too long.'
            : 'This has already been answered.',
        );
      const thread = threadOf(handoff);
      const label = labelIn(handoff.room_id, viewer);
      if (input.decision === 'decline') {
        handoff.state = 'declined';
        handoff.decided_at = now();
        note(thread, viewer.id, `${label} declined to run this with their own setup.`);
        settleRequest(handoff);
        return answer(C.handoffResponse, { handoff: handoffView(handoff) });
      }
      if (input.task_hash !== sha256(handoff.task))
        throw new RoomError(409, 'task_changed', 'The task changed. Read it again.');
      handoff.state = 'running';
      handoff.decided_at = now();
      handoff.job_id = newId('job');
      note(thread, viewer.id, `${label} is running this with their own setup.`);
      const finish = () => {
        if (handoff.state !== 'running') return;
        handoff.state = 'settled';
        handoff.result =
          'I sent the note from your email to agency@studio.example. They replied that the spring drafts land on Thursday.';
      };
      if (speed === 0) finish();
      else setTimeout(finish, 1500 * speed);
      return answer(C.handoffResponse, { handoff: handoffView(handoff) });
    }),
  );
  app.post(
    '/handoffs/:id/result',
    route(async (c) => {
      const viewer = me();
      personOnly(viewer);
      const handoff = handoffFor(param(c, 'id'), viewer);
      const input = C.handoffResultDecision.parse(await body(c));
      if (handoff.state !== 'settled' || handoff.result === null)
        throw new RoomError(409, 'no_result', 'There is no result to share yet.');
      const thread = threadOf(handoff);
      if (input.decision === 'share') {
        if (input.result_hash !== sha256(handoff.result))
          throw new RoomError(409, 'result_changed', 'The result changed. Read it again.');
        note(thread, viewer.id, handoff.result, 'handoff_result');
        handoff.state = 'shared';
      } else {
        note(thread, viewer.id, `${labelIn(handoff.room_id, viewer)} kept the result private.`);
        handoff.state = 'kept';
      }
      handoff.result = null;
      settleRequest(handoff);
      return answer(C.handoffResponse, { handoff: handoffView(handoff) });
    }),
  );

  return {
    /** Seed the demonstration rooms; the web app's mock does, tests do not. */
    seed: () => {
      if (!session.signedOut() && session.account()) seedDemo();
    },
    rooms,
    handoffsWaiting,
    /** The guest signed in now, if any: their sign-in reaches rooms and their own account only. */
    guest: () => (guestId ? (people.get(guestId) ?? null) : null),
    /** A guest signs in with the password they chose when they accepted their invite. */
    signInGuest: (email: string, password: string) => {
      const guest = byEmail(email);
      if (guest?.kind !== 'guest' || guest.password !== password) return null;
      guestId = guest.id;
      return guest;
    },
    signOutGuest: () => {
      guestId = null;
    },
  };
}
