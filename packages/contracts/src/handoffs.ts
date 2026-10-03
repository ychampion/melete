/**
 * Handoffs: work a room's agent asks one person to run with their own setup.
 * The person sees the whole task, word for word, and runs it in their own
 * space or declines it. When it finishes they see the exact result and choose
 * to share it with the room or keep it to themselves. Nothing reaches the room
 * from their space without that second choice.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

const principalId = prefixedId(ID_PREFIXES.owner);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `pending`: waiting for the person. `running`: accepted, running in their own
 * space. `settled`: finished, and the result waits for them to share or keep.
 * `shared`, `kept`, `declined` and `expired` are final.
 */
export const HANDOFF_STATES = [
  'pending',
  'accepted',
  'declined',
  'running',
  'settled',
  'shared',
  'kept',
  'expired',
] as const;
export const handoffState = z.enum(HANDOFF_STATES);
export type HandoffState = z.infer<typeof handoffState>;

export const roomHandoff = z.strictObject({
  id: z.string().min(1).max(240),
  room: z.strictObject({ id: prefixedId(ID_PREFIXES.space), name: z.string() }),
  thread_id: z.string().min(1).max(240),
  /** The person whose request in the room led to this, as `Name <email>`. */
  asked_by: z.strictObject({ principal_id: principalId, display_name: z.string() }).nullable(),
  /** The whole task, exactly as it will run. */
  task: z.string(),
  task_hash: sha256,
  state: handoffState,
  /** The work it started in the person's own space, once accepted. */
  job_id: z.string().nullable(),
  /** The exact text that would be shared, once the work has finished with an answer. */
  result: z.string().nullable(),
  result_hash: sha256.nullable(),
  created_at: timestamp,
  decided_at: timestamp.nullable(),
  /** A pending handoff nobody answers by then is withdrawn and the room is told. */
  expires_at: timestamp,
});
export type RoomHandoff = z.infer<typeof roomHandoff>;

export const handoffList = z.strictObject({ handoffs: z.array(roomHandoff) });

/** Run it with my setup, or decline. Accepting names the exact task the person read. */
export const handoffDecision = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('accept'), task_hash: sha256 }),
  z.strictObject({ decision: z.literal('decline') }),
]);
export type HandoffDecision = z.infer<typeof handoffDecision>;

/** Share the result with the room, or keep it. Sharing names the exact text the person read. */
export const handoffResultDecision = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('share'), result_hash: sha256 }),
  z.strictObject({ decision: z.literal('keep') }),
]);
export type HandoffResultDecision = z.infer<typeof handoffResultDecision>;

export const handoffResponse = z.strictObject({ handoff: roomHandoff });

/** The tools of the built-in `room` connection: one for a room's requests, three for a person's own work. */
export const ROOM_TOOL_SCOPES = {
  room: ['room.handoff'],
  personal: ['room.list', 'room.post', 'room.add_file'],
} as const;
