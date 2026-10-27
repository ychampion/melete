/**
 * A room's board: dated items (events, tasks, questions and notes) the room's
 * people and its agent keep together. Each item has an assignee and says who
 * may see it; the service filters every read by the reader's place in the room.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

const principalId = prefixedId(ID_PREFIXES.owner);
const roomId = prefixedId(ID_PREFIXES.space);

/** Limits shared by the service, its routes and the agent's tools. */
export const BOARD_TITLE_MAX = 120;
export const BOARD_DETAIL_MAX = 2000;
export const BOARD_ANSWER_MAX = 2000;
export const BOARD_CHOICES_MAX = 6;
export const BOARD_CHOICE_MAX = 80;

export const boardItemKind = z.enum(['event', 'task', 'question', 'note']);
export type BoardItemKind = z.infer<typeof boardItemKind>;

/**
 * Who sees an item. `everyone`: everyone in the room. `owners`: the room's
 * owners. `assignee`: the person it is assigned to, and the room's owners.
 */
export const boardVisibility = z.enum(['everyone', 'owners', 'assignee']);
export type BoardVisibility = z.infer<typeof boardVisibility>;

export const boardItemState = z.enum(['open', 'claimed', 'done', 'answered']);
export type BoardItemState = z.infer<typeof boardItemState>;

const boardPerson = z.strictObject({ principal_id: principalId, display_name: z.string() });

export const boardItem = z.strictObject({
  id: z.string().min(1).max(64),
  room_id: roomId,
  room_name: z.string(),
  kind: boardItemKind,
  title: z.string().min(1).max(BOARD_TITLE_MAX),
  detail: z.string().max(BOARD_DETAIL_MAX).nullable(),
  starts_at: timestamp.nullable(),
  ends_at: timestamp.nullable(),
  due_at: timestamp.nullable(),
  /** Null when nobody is assigned, or the person assigned has left the room. */
  assignee: boardPerson.nullable(),
  visibility: boardVisibility,
  /** A claim by someone who has since left the room reads as `open`. */
  state: boardItemState,
  claimed_by: boardPerson.nullable(),
  /** The answers a question suggests; any answer is accepted. */
  choices: z.array(z.string().min(1).max(BOARD_CHOICE_MAX)).max(BOARD_CHOICES_MAX).nullable(),
  answer: z.string().max(BOARD_ANSWER_MAX).nullable(),
  answered_at: timestamp.nullable(),
  /** The thread a question was asked in; its answer is posted there. */
  thread_id: z.string().nullable(),
  created_by: boardPerson,
  created_at: timestamp,
  updated_at: timestamp,
  /** The commit order of the item's latest change; a board stream resumes from it. */
  seq: z.number().int().nonnegative(),
  /** What the reader may do with it now. */
  can: z.strictObject({ claim: z.boolean(), done: z.boolean(), answer: z.boolean() }),
});
export type BoardItem = z.infer<typeof boardItem>;

export const boardList = z.strictObject({ items: z.array(boardItem) });
export type BoardList = z.infer<typeof boardList>;

export const boardItemResponse = z.strictObject({ item: boardItem });

/** `GET /board`: items from every room the reader is in, optionally theirs alone or in a window. */
export const boardQuery = z.strictObject({
  /** `1`: only open or claimed items assigned to the reader. */
  mine: z.enum(['0', '1']).optional(),
  /** Items dated in [from, to): starting, ending or due inside it. Undated items are left out. */
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export const boardAnswerRequest = z.strictObject({
  answer: z.string().trim().min(1).max(BOARD_ANSWER_MAX),
});

/** An answer to a question: the item, and the room message posted as the person who answered. */
export const boardAnswerResponse = z.strictObject({
  item: boardItem,
  thread_id: z.string(),
  message_id: z.string(),
  request_job_id: z.string().nullable(),
});

/** One frame of a room board's live stream: an item as the reader may see it now. */
export const boardStreamFrame = z.strictObject({
  seq: z.number().int().nonnegative(),
  kind: z.literal('item'),
  item: boardItem,
});
export type BoardStreamFrame = z.infer<typeof boardStreamFrame>;

/** The tools a room's request has for its board. */
export const BOARD_TOOL_SCOPES = [
  'board.list',
  'board.add',
  'board.update',
  'board.ask',
  'board.note',
] as const;
