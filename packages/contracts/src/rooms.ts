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
  permissionCard,
  resultCard,
  turnStatus,
} from './experience.ts';
import { claimId } from './memory.ts';
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
  /** The person's label in this room: the name they chose, then their handle in angle brackets. */
  display_name: z.string(),
  role: roomRole,
  /**
   * The code this room gives the person, the one in angle brackets after their
   * name. Nobody chooses it, so two people with the same name stay apart.
   */
  handle: z.string().optional(),
  /** Shown to people who are not guests. */
  email: z.email().optional(),
  /** When a guest's place in the room ends. */
  expires_at: timestamp.nullable().optional(),
  /** Looking at the room now. Display only. */
  present: z.boolean(),
});
export type RoomMember = z.infer<typeof roomMember>;

/**
 * Who decides the permissions a room's request asks for: the person who asked
 * it, any member who is not a guest, or the room's owners. Guests and the
 * room's agent never decide.
 */
export const roomApprovers = z.enum(['requester', 'any_member', 'owners']);
export type RoomApprovers = z.infer<typeof roomApprovers>;

/**
 * How the room works: who decides its permissions, when its agent answers,
 * whether guests may ask it, and how many asks the room, and each person in
 * it, may make in an hour.
 */
export const roomPolicy = z.strictObject({
  approvers: roomApprovers,
  /** `asked`: the agent answers when asked. `every_message`: every message asks it, which uses more of the model. */
  agent_turns: z.enum(['asked', 'every_message']),
  guests_may_ask: z.boolean(),
  requests_per_hour: z.number().int().min(1).max(1000).optional(),
  requests_per_person_hour: z.number().int().min(1).max(1000).optional(),
});
export type RoomPolicy = z.infer<typeof roomPolicy>;
/** A change to how a room works; what it leaves out stays as it is. Owners only. */
export const roomPolicyUpdate = roomPolicy
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one setting.');
export const roomPolicyResponse = z.strictObject({ policy: roomPolicy });

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

const LOOKALIKE_MARKS =
  /[<>@\u2039\u203A\u00AB\u00BB\u27E8\u27E9\u2329\u232A\u3008\u3009\u300A\u300B\u276C-\u2771\u29FC\u29FD\u02C2\u02C3]/u;

/**
 * The name other people in a room see, beside the handle the room gives them.
 * One line of plain text with no `<`, `>` or `@`, so a name never reads as
 * more than a name, or as someone else's handle or email.
 */
export const displayNameText = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>@]+$/u, 'Use one line of plain text, without < > or @.')
  // Look-alikes of < > and @, by compatibility (＜ ﹫) or by shape (‹ › « » ⟨ ⟩), count as them.
  .refine(
    (value) => !LOOKALIKE_MARKS.test(value.normalize('NFKC')),
    'Use one line of plain text, without < > or @.',
  );
export const updateMeRequest = z.strictObject({ display_name: displayNameText.nullable() });
export const meResponse = z.strictObject({
  owner: z.strictObject({
    id: z.string(),
    email: z.email(),
    created_at: timestamp,
    display_name: z.string().nullable(),
    /**
     * `guest`: an account invited into rooms. Its sign-in reaches only rooms and
     * its own account; every other route answers 403 `guests_use_rooms`.
     */
    kind: z.enum(['person', 'guest']).optional(),
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

/** A permission of a room's request that has been answered, and who answered it. */
export const roomDecision = z.strictObject({
  approval_id: id,
  decision: z.enum(['approved', 'denied']),
  /** The person who answered; null when Melete withdrew it or decided it by the room's settings. */
  decided_by: roomAuthor.nullable(),
  decided_at: timestamp,
});
export type RoomDecision = z.infer<typeof roomDecision>;

/** One ask of the room's agent: its answer, cards and receipts, and who asked. */
export const roomRequest = z.strictObject({
  job_id: id,
  requested_by: roomAuthor,
  status: turnStatus,
  turns: z.array(conversationTurn),
  cards: z.array(resultCard),
  receipts: z.array(experienceReceipt),
  /** Permissions waiting now, each naming who may answer it. */
  permissions: z.array(permissionCard).optional(),
  /** Permissions answered, with who answered each. */
  decisions: z.array(roomDecision).optional(),
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

/**
 * An answer to one of a room's permissions. It names the exact content
 * (`payload_hash`) and the card it answers (`version`); either having changed,
 * the answer is refused. Only the people the room's rule names may answer.
 */
export const roomPermissionDecision = z.discriminatedUnion('option', [
  z.strictObject({ option: z.literal('allow_once'), version: id, payload_hash: id }),
  z.strictObject({ option: z.literal('deny'), version: id, payload_hash: id }),
]);
export const roomPermissionOutcome = z.strictObject({
  status: z.literal('ok'),
  option: z.enum(['allow_once', 'deny']),
  decided_by: roomAuthor,
});

/** A connection in a room's space, and whether it serves the room's requests. */
export const roomConnection = z.strictObject({
  id,
  label: z.string(),
  provider: z.string(),
  status: z.string(),
  /** `room`: the agent uses it for the room's requests. `owner`: it serves only the owner's own work. */
  shared_use: z.enum(['owner', 'room']),
});
export const roomConnectionList = z.strictObject({ connections: z.array(roomConnection) });
export const roomConnectionUpdate = z.strictObject({ shared_use: z.enum(['owner', 'room']) });
export const roomConnectionResponse = z.strictObject({ connection: roomConnection });

/**
 * Room memory: what people said in the room that the room's agent remembers,
 * each detail with the people whose words it rests on, and the details people
 * shared into the room from their own memory.
 */
export const roomMemoryItem = z.strictObject({
  claim_id: claimId,
  key: z.string().nullable(),
  /** The detail in a few plain words, e.g. "venue: deposit". */
  label: z.string(),
  content: z.string(),
  /** Whose words in the room this detail rests on. */
  said_by: z.array(roomAuthor),
  /** An owner of the room may forget any detail; anyone else only one from their own words. */
  can_forget: z.boolean(),
  recorded_at: timestamp,
});
export type RoomMemoryItem = z.infer<typeof roomMemoryItem>;
/**
 * A detail a person shared into the room from their own memory. It is a
 * reference: forgetting it in their own memory takes it out of the room, and
 * `content` is null once the room can no longer read it.
 */
export const roomShare = z.strictObject({
  id,
  claim_id: claimId,
  shared_by: roomAuthor,
  /** Kept out of the agent's work while a guest is in the room. */
  members_only: z.boolean(),
  label: z.string().nullable(),
  content: z.string().nullable(),
  created_at: timestamp,
  /** The person who shared it, or an owner of the room, may withdraw it. */
  can_withdraw: z.boolean(),
});
export type RoomShare = z.infer<typeof roomShare>;
export const roomMemoryView = z.strictObject({
  items: z.array(roomMemoryItem),
  shares: z.array(roomShare),
});
export const shareToRoomRequest = z.strictObject({
  /** A detail in the person's own memory. */
  claim_id: claimId,
  /** Defaults to true: kept out of the agent's work while a guest is in the room. */
  members_only: z.boolean().optional(),
});
export const roomShareResponse = z.strictObject({ share: roomShare });
export const roomShareWithdrawn = z.strictObject({ withdrawn: id });
export const roomMemoryForgotten = z.strictObject({ forgotten: claimId });
export const roomMessageDeleted = z.strictObject({ message: roomMessage });

/**
 * Guests. An owner invites someone by email for a number of days; Melete makes
 * a link that works once, which the owner sends them. The guest opens it,
 * chooses a password and lands in that room alone. Their place ends when the
 * invite's time is up.
 */
export const createRoomInviteRequest = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  /** How long the guest stays in the room. Defaults to 30 days. */
  expires_in_days: z.number().int().min(1).max(365).optional(),
});
export const roomInviteState = z.enum(['open', 'accepted', 'expired', 'withdrawn']);
export const roomInvite = z.strictObject({
  id,
  room_id: roomId,
  email: z.email(),
  state: roomInviteState,
  /** When the link stops working, and when the guest's place in the room ends. */
  expires_at: timestamp,
  created_by: roomAuthor,
  created_at: timestamp,
  accepted_at: timestamp.nullable(),
});
export type RoomInvite = z.infer<typeof roomInvite>;
export const roomInviteList = z.strictObject({ invites: z.array(roomInvite) });
export const roomInviteCreated = z.strictObject({
  invite: roomInvite,
  /** The link to send, when this installation knows its public address. Shown once. */
  link: z.string().nullable(),
  /** The same page as a path on this installation, to open or paste on its sign-in page. Shown once. */
  path: z.string(),
});
export const roomInviteResponse = z.strictObject({ invite: roomInvite });

const inviteToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'That invite link is not complete.');
/** The token from an invite link. It rides in the request body, never in a path a log keeps. */
export const inviteViewRequest = z.strictObject({ token: inviteToken });
/** What an invite link shows before it is accepted: the room's name, and nothing about its people. */
export const inviteView = z.strictObject({
  room_name: z.string(),
  expires_at: timestamp,
  /** An account already signs in with this invite's email: sign in first, then accept. */
  existing_account: z.boolean(),
});
export const acceptInviteRequest = z.strictObject({
  token: inviteToken,
  /** The new guest account's password. Not needed when accepting while signed in. */
  password: z.string().min(8).max(1024).optional(),
  display_name: displayNameText.optional(),
});
export const acceptInviteResponse = z.strictObject({ room_id: roomId });

/**
 * A chat platform account linked to the signed-in person. While it is linked,
 * that account speaks, answers and hears in the person's rooms as them.
 */
export const linkedAccount = z.strictObject({
  provider: z.string(),
  external_id: z.string(),
  created_at: timestamp,
});
export const linkedAccountList = z.strictObject({ accounts: z.array(linkedAccount) });
export const linkedAccountRemoval = z.strictObject({ removed: z.boolean() });
