/**
 * Rooms: a shared space where several people talk to one agent in threads.
 * Every route names the room in its path and checks the caller's membership
 * itself; a header never selects a room.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import {
  conversationTurn,
  experienceEvent,
  experienceReceipt,
  resultCard,
  turnStatus,
} from './experience.ts';
import { submissionId } from './responsibility.ts';

const principalId = prefixedId(ID_PREFIXES.owner);
const roomId = prefixedId(ID_PREFIXES.space);
const id = z.string().min(1).max(240);

/** A person's place in a room. The room's own agent is not listed among them. */
export const roomRole = z.enum(['owner', 'member', 'guest']);
export type RoomRole = z.infer<typeof roomRole>;

export const roomSummary = z.strictObject({
  id: roomId,
  name: z.string(),
  purpose: z.string().nullable(),
  my_role: roomRole,
  /** Messages from other people since the caller last looked at the room. */
  unread: z.number().int().nonnegative(),
  created_at: timestamp,
});
export type RoomSummary = z.infer<typeof roomSummary>;

export const roomMember = z.strictObject({
  principal_id: principalId,
  display_name: z.string(),
  role: roomRole,
  /** Shown to people who are not guests. */
  email: z.email().optional(),
  /** Looking at the room now. Display only. */
  present: z.boolean(),
});
export type RoomMember = z.infer<typeof roomMember>;

/** How the room works: who decides its permissions, when its agent answers, and whether guests may ask. */
export const roomPolicy = z.strictObject({
  approvers: z.enum(['requester', 'any_member', 'owners']),
  agent_turns: z.enum(['asked', 'every_message']),
  guests_may_ask: z.boolean(),
});

export const roomDetail = z.strictObject({
  room: roomSummary.extend({ agent_name: z.string() }),
  members: z.array(roomMember),
  policy: roomPolicy,
});

export const roomList = z.strictObject({ rooms: z.array(roomSummary) });

export const createRoomRequest = z.strictObject({
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().max(500).optional(),
});
export const addRoomMemberRequest = z.strictObject({ principal_id: principalId });

export const person = z.strictObject({
  id: principalId,
  display_name: z.string(),
  email: z.email(),
});
export const peopleQuery = z.strictObject({ query: z.string().max(200).optional() });
export const peopleList = z.strictObject({ people: z.array(person) });

/**
 * The name other people in a room see, beside their email. One line of plain
 * text with no `<`, `>` or `@`, so a name never reads as more than a name, or
 * as someone's email.
 */
export const displayNameText = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>@]+$/u, 'Use one line of plain text, without < > or @.');
export const updateMeRequest = z.strictObject({ display_name: displayNameText.nullable() });
export const meResponse = z.strictObject({
  owner: z.strictObject({
    id: z.string(),
    email: z.email(),
    created_at: timestamp,
    display_name: z.string().nullable(),
  }),
});

export const roomAuthor = z.strictObject({
  principal_id: principalId,
  display_name: z.string(),
});

export const roomThread = z.strictObject({
  id,
  room_id: roomId,
  title: z.string(),
  created_by: roomAuthor,
  created_at: timestamp,
  last_activity_at: timestamp,
  archived_at: timestamp.nullable(),
});
export type RoomThread = z.infer<typeof roomThread>;

export const roomMessage = z.strictObject({
  id,
  thread_id: id,
  author: roomAuthor,
  kind: z.enum(['person', 'handoff_result', 'system']),
  /** Posted by a person's own agent after they approved the exact text. */
  via_agent: z.boolean(),
  /** Null once its author deleted it. */
  text: z.string().nullable(),
  mentions: z.array(z.string()),
  /** `pending`: it asked the agent and waits its turn in the thread. `started`: it reached a request. */
  request_state: z.enum(['none', 'pending', 'started']),
  request_job_id: id.nullable(),
  created_at: timestamp,
});
export type RoomMessage = z.infer<typeof roomMessage>;

/** One ask of the room's agent: its answer, cards and receipts, and who asked. */
export const roomRequest = z.strictObject({
  job_id: id,
  requested_by: roomAuthor,
  status: turnStatus,
  turns: z.array(conversationTurn),
  cards: z.array(resultCard),
  receipts: z.array(experienceReceipt),
});
export type RoomRequest = z.infer<typeof roomRequest>;

export const roomThreadList = z.strictObject({ threads: z.array(roomThread) });
export const roomThreadView = z.strictObject({
  thread: roomThread,
  messages: z.array(roomMessage),
  requests: z.array(roomRequest),
});

const messageText = z.string().trim().min(1).max(20_000);
export const createRoomThreadRequest = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  text: messageText,
  /** Start the thread by asking the room's agent. */
  ask_agent: z.boolean().optional(),
  submission_id: submissionId,
});
export const postRoomMessageRequest = z.strictObject({
  text: messageText,
  submission_id: submissionId,
});
export const roomMessageResponse = z.strictObject({
  thread: roomThread,
  message: roomMessage,
  /** The request this message reached, when it asked the agent and its turn has come. */
  request_job_id: id.nullable(),
});

/**
 * One frame of a thread's live stream. Its `seq` is the stream cursor: send it
 * back as `Last-Event-ID` to resume.
 */
export const roomStreamFrame = z.union([
  z.strictObject({
    seq: z.number().int().nonnegative(),
    kind: z.literal('message'),
    message: roomMessage,
  }),
  z.strictObject({
    seq: z.number().int().nonnegative(),
    kind: z.literal('request'),
    request_job_id: id,
    event: experienceEvent,
  }),
]);
export type RoomStreamFrame = z.infer<typeof roomStreamFrame>;

export const roomStopResponse = z.strictObject({ request: roomRequest });
export const roomPresenceResponse = z.strictObject({ present: z.array(principalId) });
export const roomMembershipResponse = z.strictObject({ member: roomMember });
export const roomLeaveResponse = z.strictObject({ removed: principalId });
